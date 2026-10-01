import { readSheet } from 'read-excel-file/node';
import yauzl from 'yauzl';
import { createHash } from 'node:crypto';
import { ReaderError } from './errors.js';
import { REVIEW_FIELDS, emptyReviewFields } from '../../../shared/core/reader/review-fields.js';
import { normalizeFields, dateValue, textValue } from './reviews.js';

export const MAX_XLSX_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;

async function inspectZip(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_XLSX_BYTES) throw new ReaderError(400, '请选择不超过 8 MiB 的 xlsx 文件');
    await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
        if (error) { reject(new ReaderError(400, '文件不是有效的 xlsx 压缩包')); return; }
        let total = 0, actual = 0, count = 0, failed = false;
        const fail = error => { if (failed) return; failed = true; zip.close(); reject(error instanceof ReaderError ? error : new ReaderError(400, 'xlsx 压缩数据损坏')); };
        zip.on('error', fail); zip.on('end', resolve);
        zip.on('entry', entry => {
            total += entry.uncompressedSize;
            if (++count > 1000 || total > MAX_EXPANDED || (entry.generalPurposeBitFlag & 1)) {
                fail(new ReaderError(400, 'xlsx 解压内容过大或文件已加密')); return;
            }
            if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
            zip.openReadStream(entry, (error, stream) => {
                if (error) { fail(error); return; }
                const worksheet = /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.fileName), chunks = [];
                stream.on('error', fail);
                stream.on('data', bytes => {
                    actual += bytes.length;
                    if (actual > MAX_EXPANDED) { stream.destroy(); fail(new ReaderError(400, 'xlsx 解压内容超过 32 MiB')); }
                    else if (worksheet) chunks.push(bytes);
                });
                stream.on('end', () => {
                    if (failed) return;
                    // Check sparse far-away cells before the parser pads its
                    // matrix; a tiny zip must not allocate millions of rows.
                    if (worksheet) for (const match of Buffer.concat(chunks).toString('utf8').matchAll(/<(?:[\w.-]+:)?(?:row|c)\b[^>]*\br\s*=\s*["']([^"']+)["']/gu)) {
                        const address = /^(?:([A-Z]+))?(\d+)$/u.exec(match[1]);
                        if (!address) continue;
                        let column = 0;
                        for (const letter of address[1] || '') column = column * 26 + letter.charCodeAt(0) - 64;
                        if (Number(address[2]) > 5001 || column > 50) { fail(new ReaderError(400, 'xlsx 最多 5000 条记录、50 列')); return; }
                    }
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    }));
}
function header(value) { return value.trim().replace(/^└\s*/, '').normalize('NFKC').replace(/\s/g, ''); }
const headerKeys = new Map();
for (const field of REVIEW_FIELDS) {
    const aliases = [field.label];
    if (field.when) aliases.push(`${field.label}（选${field.when === '架空(衍生)' ? '架空(衍生)' : field.when}才出）`);
    for (const alias of aliases) headerKeys.set(header(alias), field.key);
}
for (const [key, aliases] of Object.entries({ title: ['书名（必填）', '书名'], author: ['作者（必填）', '作者'],
    submittedAt: ['提交时间（自动）', '提交时间'], submitter: ['提交者（自动）', '提交者'],
    startedAt: ['开始阅读日期'], finishedAt: ['读完日期'], reflection: ['感想', '读后感'] })) {
    for (const alias of aliases) headerKeys.set(header(alias), key);
}
function cellValue(cell) {
    const value = cell.value;
    if (value == null) return '';
    if (value instanceof Date || typeof value !== 'object') return value;
    if ('formula' in value || 'sharedFormula' in value) {
        if (value.result == null) throw new Error('公式单元格没有缓存结果，请导出为静态值');
        return value.result;
    }
    return cell.text;
}
function string(value) { return value instanceof Date ? value.toISOString() : String(value ?? '').trim(); }
// Questionnaire exports display submission times to the second. Round both date
// cells and text cells to that precision: Excel's serial-date conversion can
// otherwise turn 12:30:00 into 12:29:59.999 and break reimport deduplication.
function submissionTime(date) { return new Date(Math.round(date.getTime() / 1000) * 1000).toISOString(); }
function timestamp(value) {
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) throw new Error('提交时间无效');
        return submissionTime(value);
    }
    if (typeof value === 'number') return timestamp(new Date(Math.round((value - 25569) * 86400000)));
    let text = string(value).replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
    if (!match) throw new Error('提交时间缺失或格式无效');
    const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    dateValue(date, '提交时间');
    text = `${date}T${(match[4] || '00').padStart(2, '0')}:${match[5] || '00'}:${match[6] || '00'}${match[7] || ''}${match[8] || 'Z'}`;
    const parsed = new Date(text);
    if (!Number.isFinite(parsed.getTime())) throw new Error('提交时间无效');
    return submissionTime(parsed);
}

export async function parseWorkbook(bytes, books, existingKeys) {
    await inspectZip(bytes);
    let matrix;
    try { matrix = await readSheet(bytes, { trim: false }); }
    catch { throw new ReaderError(400, '无法解析 xlsx，请使用腾讯文档导出的 xlsx 文件'); }
    const sheet = { rowCount: matrix.length, columnCount: matrix.reduce((maximum, row) => Math.max(maximum, row?.length || 0), 0),
        getRow(number) {
            const values = matrix[number - 1] || [];
            return { hasValues: values.some(value => value != null && value !== ''),
                getCell(column) { return { value: values[column - 1] ?? null }; } };
        } };
    if (!sheet || sheet.rowCount < 1 || sheet.rowCount > 5001 || sheet.columnCount > 50) throw new ReaderError(400, 'xlsx 需有表头，最多 5000 条记录、50 列');
    const columns = [], seenHeaders = new Set();
    for (let column = 1; column <= sheet.columnCount; column++) {
        const name = string(cellValue(sheet.getRow(1).getCell(column))) || `未命名列 ${column}`;
        const key = headerKeys.get(header(name));
        if (seenHeaders.has(key || name)) throw new ReaderError(400, `重复表头：${name}`);
        seenHeaders.add(key || name); columns.push({ column, name, key });
    }
    for (const key of ['title', 'author', 'submittedAt']) if (!seenHeaders.has(key)) throw new ReaderError(400, '表头需包含书名（必填）、作者（必填）、提交时间（自动）');
    const seenKeys = new Set(existingKeys), rows = [];
    let totalCharacters = 0;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        const original = {}, values = {}, errors = [], warnings = [];
        for (const column of columns) {
            const cell = row.getCell(column.column);
            original[column.name] = cell.value ?? '';
            try {
                const value = cellValue(cell);
                totalCharacters += string(value).length;
                if (totalCharacters > 4000000) throw new ReaderError(413, '表格内容过大，请分批导入');
                if (string(value).length > 50000) throw new Error('单元格内容超过 50000 字符');
                if (column.key) values[column.key] = value;
            } catch (error) { if (error.status === 413) throw error; errors.push(`${column.name}：${error.message}`); }
        }
        const fields = emptyReviewFields(), unknown = [];
        for (const field of REVIEW_FIELDS) {
            const text = string(values[field.key]);
            if (field.type === 'text') fields[field.key] = text;
            else {
                const selected = field.type === 'multi' ? text.split(/[,，]/u).map(value => value.trim()).filter(Boolean) : text ? [text] : [];
                const valid = [];
                for (const value of selected) {
                    if (!field.options.includes(value) || (field.when && string(values.background) !== field.when)) {
                        unknown.push(value); warnings.push({ field: field.key, label: field.label, value,
                            message: !field.options.includes(value) ? '未知选项已放入补充标签' : '联动题与时代背景不一致，已放入补充标签' });
                    } else valid.push(value);
                }
                fields[field.key] = field.type === 'multi' ? [...new Set(valid)] : valid[0] || '';
            }
        }
        if (unknown.length) fields.extraTags = [...new Set([fields.extraTags, ...unknown].filter(Boolean))].join(', ');
        let record = null, dedupeKey = null, duplicate = false, candidates = [];
        try {
            const title = textValue(string(values.title), '书名', 255, true), author = textValue(string(values.author), '作者', 255, true);
            const submittedAt = timestamp(values.submittedAt);
            const startedAt = dateValue(values.startedAt ? string(values.startedAt).slice(0, 10) : null, '开始阅读日期');
            const finishedAt = dateValue(values.finishedAt ? string(values.finishedAt).slice(0, 10) : fields.completed === '已看完' ? submittedAt.slice(0, 10) : null, '读完日期');
            if (startedAt && finishedAt && finishedAt < startedAt) throw new Error('读完日期早于开始日期');
            const normalized = normalizeFields(fields);
            candidates = books.filter(book => book.title.trim() === title && book.author.trim() === author).map(book => ({ id: book.id, title: book.title, author: book.author, filename: book.filename }));
            record = { bookId: candidates.length === 1 ? candidates[0].id : null, title, author, startedAt, finishedAt,
                readingMs: null, wordCount: null, submittedAt, fields: normalized,
                reflection: textValue(string(values.reflection), '感想', 50000) };
            dedupeKey = createHash('sha256').update(JSON.stringify([title, author, submittedAt])).digest('hex');
            duplicate = seenKeys.has(dedupeKey);
            if (!errors.length) seenKeys.add(dedupeKey);
        } catch (error) { errors.push(error.message); }
        rows.push({ row: rowNumber, record, original, errors, warnings, duplicate, dedupeKey, candidates });
    }
    if (!rows.length) throw new ReaderError(400, 'xlsx 中没有读书记录');
    return rows;
}
