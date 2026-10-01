import { randomUUID } from 'node:crypto';
import { AnnotationStore } from './annotations.js';
import { ReaderError } from './errors.js';
import { REVIEW_FIELDS, emptyReviewFields, reviewTags } from '../../../shared/core/reader/review-fields.js';

export const REVIEW_SCHEMA = `
    CREATE TABLE IF NOT EXISTS readingStats (
        bookId TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        startedAt TEXT, readingMs INTEGER NOT NULL DEFAULT 0, wordCount INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS readingSessions (
        sessionId TEXT PRIMARY KEY, bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        startedAt INTEGER NOT NULL, elapsedMs INTEGER NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookId TEXT REFERENCES books(id) ON DELETE SET NULL,
        title TEXT NOT NULL, author TEXT NOT NULL, startedAt TEXT, finishedAt TEXT,
        readingMs INTEGER, wordCount INTEGER, fields TEXT NOT NULL, reflection TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL, submittedAt TEXT, dedupeKey TEXT UNIQUE,
        original TEXT NOT NULL DEFAULT '{}', warnings TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS archives_book ON archives(bookId);
    CREATE INDEX IF NOT EXISTS archives_match ON archives(title,author);
    CREATE TABLE IF NOT EXISTS reviewDrafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT NOT NULL UNIQUE,
        bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        archiveId INTEGER REFERENCES archives(id) ON DELETE SET NULL,
        draft TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        createdAt TEXT NOT NULL, filledAt TEXT
    );
    CREATE INDEX IF NOT EXISTS drafts_book ON reviewDrafts(bookId,id);
    CREATE TABLE IF NOT EXISTS importPreviews (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, rows TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
    );
`;

export function requireReader(identity) {
    if (identity.author !== 'reader') throw new ReaderError(403, 'This action belongs to the reader');
}
export function jsonObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReaderError(400, 'Expected a JSON object');
}
export function recordId(value) {
    const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(id) || id < 1) throw new ReaderError(400, 'Invalid record id');
    return id;
}
export function textValue(value, label, max = 255, required = false) {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ReaderError(400, `Invalid ${label}`);
    return value.trim();
}
export function dateValue(value, label) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new ReaderError(400, `Invalid ${label}`);
    return value;
}
export function normalizeFields(data) {
    jsonObject(data);
    const fields = emptyReviewFields();
    if (Object.keys(data).some(key => !(key in fields))) throw new ReaderError(400, 'Unknown questionnaire field');
    for (const field of REVIEW_FIELDS) {
        const value = data[field.key] ?? fields[field.key];
        if (field.type === 'text') fields[field.key] = textValue(value, field.label, field.key === 'extraTags' ? 10000 : 1000);
        else if (field.type === 'multi') {
            if (!Array.isArray(value) || value.length > field.options.length || value.some(item => !field.options.includes(item))) throw new ReaderError(400, `Invalid ${field.label} option`);
            fields[field.key] = [...new Set(value)];
        } else {
            if (typeof value !== 'string' || (value && !field.options.includes(value))) throw new ReaderError(400, `Invalid ${field.label} option`);
            fields[field.key] = value;
        }
    }
    for (const field of REVIEW_FIELDS.filter(field => field.when)) if (fields.background !== field.when) fields[field.key] = [];
    return fields;
}
function countCharacters(text) {
    let count = 0;
    for (const char of text) if (!/\s/u.test(char)) count++;
    return count;
}
function nullableCount(value, label) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new ReaderError(400, `Invalid ${label}`);
    return value;
}

export class ReviewStore extends AnnotationStore {
    async ensureUniqueArchives() {
        // Retain every historical record; only the latest edited card keeps the TXT link.
        const rows = (await this.db.execute('SELECT id,bookId,warnings FROM archives WHERE bookId IS NOT NULL ORDER BY updatedAt DESC,id DESC')).rows;
        const seen = new Set(), statements = [];
        for (const row of rows) {
            if (seen.has(row.bookId)) {
                const warnings = JSON.parse(row.warnings);
                warnings.push({ kind: 'duplicate_book_link', message: '同一 TXT 已关联最近编辑的卡片，本记录保留内容并解除重复关联。' });
                statements.push({ sql: 'UPDATE archives SET bookId=NULL,warnings=? WHERE id=?', args: [JSON.stringify(warnings), row.id] });
            }
            seen.add(row.bookId);
        }
        statements.push('CREATE UNIQUE INDEX IF NOT EXISTS archives_unique_book ON archives(bookId) WHERE bookId IS NOT NULL');
        await this.db.batch(statements, 'write');
    }
    async assertAvailableBook(bookId, exceptId = null) {
        if (!bookId) return;
        const row = (await this.db.execute({ sql: 'SELECT id FROM archives WHERE bookId=? AND id<>?', args: [bookId, exceptId ?? 0] })).rows[0];
        if (row) throw new ReaderError(409, '这本 TXT 已有读书卡片，请打开原卡片编辑。', { code: 'archive_book_conflict', archiveId: row.id });
    }
    async ensureStats(bookId, text) {
        const existing = await this.db.execute({ sql: 'SELECT * FROM readingStats WHERE bookId=?', args: [bookId] });
        if (existing.rows[0]) return existing.rows[0];
        text ??= await this.text(bookId);
        await this.db.execute({ sql: 'INSERT INTO readingStats (bookId,wordCount) VALUES (?,?) ON CONFLICT(bookId) DO NOTHING', args: [bookId, countCharacters(text)] });
        return (await this.db.execute({ sql: 'SELECT * FROM readingStats WHERE bookId=?', args: [bookId] })).rows[0];
    }
    async stats(bookId) { await this.book(bookId); return this.ensureStats(bookId); }
    async saveReading(bookId, data, identity) {
        requireReader(identity); jsonObject(data); await this.book(bookId);
        const { sessionId, startedAt, elapsedMs } = data;
        if (typeof sessionId !== 'string' || !/^[\da-f-]{36}$/i.test(sessionId) || !Number.isSafeInteger(startedAt) ||
            startedAt < 946684800000 || startedAt > Date.now() + 300000 || !Number.isSafeInteger(elapsedMs) ||
            elapsedMs < 0 || elapsedMs > Math.max(0, Date.now() - startedAt + 300000)) throw new ReaderError(400, 'Invalid reading session');
        const existing = (await this.db.execute({ sql: 'SELECT * FROM readingSessions WHERE sessionId=?', args: [sessionId] })).rows[0];
        if (existing && (existing.bookId !== bookId || existing.startedAt !== startedAt)) throw new ReaderError(409, 'Session belongs to another reading action');
        await this.ensureStats(bookId);
        if (existing && elapsedMs <= existing.elapsedMs) return this.stats(bookId); // retry or late lower cumulative count
        const first = new Date(startedAt).toISOString(), now = new Date().toISOString();
        await this.db.batch([
            { sql: `INSERT INTO readingSessions VALUES (?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET elapsedMs=excluded.elapsedMs,updatedAt=excluded.updatedAt`, args: [sessionId, bookId, startedAt, elapsedMs, now] },
            { sql: `UPDATE readingStats SET readingMs=readingMs+?,startedAt=CASE WHEN startedAt IS NULL OR startedAt>? THEN ? ELSE startedAt END WHERE bookId=?`, args: [elapsedMs - (existing?.elapsedMs || 0), first, first, bookId] },
        ], 'write');
        return this.stats(bookId);
    }
    describeArchive(row, details = true) {
        const fields = JSON.parse(row.fields);
        const result = { ...row, fields, tags: reviewTags(fields), warnings: JSON.parse(row.warnings), hasBook: Boolean(row.bookId) };
        if (details) result.original = JSON.parse(row.original);
        else delete result.original;
        delete result.dedupeKey; return result;
    }
    async archives(query = {}) {
        const rows = (await this.db.execute('SELECT * FROM archives ORDER BY createdAt DESC,id DESC')).rows.map(row => this.describeArchive(row, false));
        return rows.filter(record => ['rating', 'platform', 'background'].every(key => !query[key] || record.fields[key] === query[key]) &&
            (!query.tag || record.tags.includes(query.tag)) && (!query.bookId || record.bookId === query.bookId) &&
            (!query.q || `${record.title} ${record.author}`.toLowerCase().includes(String(query.q).toLowerCase())));
    }
    async archive(id) {
        const row = (await this.db.execute({ sql: 'SELECT * FROM archives WHERE id=?', args: [recordId(id)] })).rows[0];
        if (!row) throw new ReaderError(404, 'Archive not found');
        return this.describeArchive(row);
    }
    async archiveValues(data) {
        jsonObject(data);
        const title = textValue(data.title, 'title', 255, true), author = textValue(data.author, 'author', 255, true);
        const fields = normalizeFields(data.fields ?? {});
        const startedAt = dateValue(data.startedAt, 'start date'), finishedAt = dateValue(data.finishedAt, 'finish date');
        if (startedAt && finishedAt && finishedAt < startedAt) throw new ReaderError(400, 'Finish date precedes start date');
        let readingMs = nullableCount(data.readingMs, 'reading duration'), wordCount = nullableCount(data.wordCount, 'word count');
        const bookId = data.bookId ?? null;
        if (bookId !== null) {
            const stats = await this.stats(bookId); readingMs = stats.readingMs; wordCount = stats.wordCount;
        }
        return { bookId, title, author, startedAt, finishedAt, readingMs, wordCount, fields,
            reflection: textValue(data.reflection ?? '', 'reflection', 50000) };
    }
    async createArchive(data, identity) {
        requireReader(identity); const record = await this.archiveValues(data), now = new Date().toISOString();
        await this.assertAvailableBook(record.bookId);
        const draftRequest = await this.archiveDraftRequest(record.bookId, data.draftRequestId);
        if (draftRequest?.archiveId != null) throw new ReaderError(409, 'Draft request already belongs to an archive');
        const statements = [{ sql: `INSERT INTO archives
            (bookId,title,author,startedAt,finishedAt,readingMs,wordCount,fields,reflection,source,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,'manual',?,?) RETURNING *`, args: [record.bookId, record.title, record.author,
            record.startedAt, record.finishedAt, record.readingMs, record.wordCount, JSON.stringify(record.fields), record.reflection, now, now] }];
        if (draftRequest) statements.push({ sql: 'UPDATE reviewDrafts SET archiveId=last_insert_rowid() WHERE requestId=?', args: [draftRequest.requestId] });
        const results = await this.db.batch(statements, 'write');
        return this.describeArchive(results[0].rows[0]);
    }
    async updateArchive(id, data, identity) {
        requireReader(identity); jsonObject(data);
        const existing = await this.archive(id);
        if (data.updatedAt !== existing.updatedAt) throw new ReaderError(409, 'Archive changed on another device; reload before saving');
        const record = await this.archiveValues({ ...existing, ...data, fields: { ...existing.fields, ...(data.fields || {}) } });
        await this.assertAvailableBook(record.bookId, existing.id);
        const draftRequest = await this.archiveDraftRequest(record.bookId, data.draftRequestId);
        if (draftRequest?.archiveId != null && draftRequest.archiveId !== existing.id) throw new ReaderError(409, 'Draft request belongs to another archive');
        const now = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
        const statements = [{ sql: `UPDATE archives SET bookId=?,title=?,author=?,startedAt=?,finishedAt=?,readingMs=?,wordCount=?,fields=?,reflection=?,updatedAt=? WHERE id=?`, args: [record.bookId, record.title, record.author,
            record.startedAt, record.finishedAt, record.readingMs, record.wordCount, JSON.stringify(record.fields), record.reflection, now, existing.id] }];
        if (draftRequest) statements.push({ sql: 'UPDATE reviewDrafts SET archiveId=? WHERE requestId=?', args: [existing.id, draftRequest.requestId] });
        await this.db.batch(statements, 'write');
        return this.archive(existing.id);
    }
    async deleteArchive(id, identity) {
        requireReader(identity); await this.archive(id);
        await this.db.execute({ sql: 'DELETE FROM archives WHERE id=?', args: [recordId(id)] });
    }
    async archiveCandidates(bookId) {
        const book = await this.book(bookId);
        if ((await this.db.execute({ sql: 'SELECT id FROM archives WHERE bookId=?', args: [bookId] })).rows.length) return [];
        return (await this.db.execute({ sql: `SELECT id,title,author,submittedAt FROM archives WHERE bookId IS NULL AND title=? AND author=? ORDER BY id`, args: [book.title.trim(), book.author.trim()] })).rows;
    }
    async linkArchives(bookId, data, identity) {
        requireReader(identity); jsonObject(data);
        if (!Array.isArray(data.recordIds) || data.recordIds.length !== 1) throw new ReaderError(400, '每本 TXT 只能选择一张卡片关联');
        await this.assertAvailableBook(bookId);
        const ids = [...new Set(data.recordIds.map(recordId))], candidates = await this.archiveCandidates(bookId);
        if (ids.some(id => !candidates.some(record => record.id === id))) throw new ReaderError(409, 'Archive no longer matches this book');
        const now = new Date().toISOString();
        await this.db.batch(ids.map(id => ({ sql: 'UPDATE archives SET bookId=?,updatedAt=? WHERE id=?', args: [bookId, now, id] })), 'write');
        return { linked: ids };
    }
    async requestDraft(bookId, data, identity) {
        requireReader(identity); jsonObject(data); const book = await this.book(bookId);
        const archiveId = data.archiveId == null ? null : recordId(data.archiveId);
        if (archiveId && (await this.archive(archiveId)).bookId !== bookId) throw new ReaderError(400, 'Archive belongs to another book');
        const requestId = randomUUID(), now = new Date().toISOString();
        const payload = { requestId, archiveId, book: { ...book, stats: await this.stats(bookId) }, notes: await this.notes(bookId) };
        const results = await this.db.batch([
            { sql: 'INSERT INTO reviewDrafts (requestId,bookId,archiveId,createdAt) VALUES (?,?,?,?) RETURNING *', args: [requestId, bookId, archiveId, now] },
            { sql: `INSERT INTO handoff (bookId,type,payload,createdAt) VALUES (?,'draft_request',?,?) RETURNING *`, args: [bookId, JSON.stringify(payload), now] },
        ], 'write');
        return { ...results[0].rows[0], handoffId: results[1].rows[0].id };
    }
    async archiveDraftRequest(bookId, requestId) {
        if (requestId == null) return null;
        if (!bookId) throw new ReaderError(400, 'A draft request requires a linked book');
        return this.reviewDraft(bookId, requestId);
    }
    async reviewDraft(bookId, requestId, archiveId) {
        await this.book(bookId);
        if (requestId != null && (typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId))) throw new ReaderError(400, 'Invalid draft request id');
        const args = [bookId]; let clause = '';
        if (requestId) { clause = 'AND requestId=?'; args.push(requestId); }
        else if (archiveId === 'new') clause = 'AND archiveId IS NULL';
        else if (archiveId != null) { clause = 'AND archiveId=?'; args.push(recordId(archiveId)); }
        const row = (await this.db.execute({ sql: `SELECT * FROM reviewDrafts WHERE bookId=? ${clause} ORDER BY id DESC LIMIT 1`, args })).rows[0];
        if (requestId && !row) throw new ReaderError(404, 'Draft request not found in this book');
        return row ?? null;
    }
    async saveDraft(bookId, data, identity) {
        if (identity.author !== 'hals') throw new ReaderError(403, 'Only the companion can return a draft');
        jsonObject(data);
        if (typeof data.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(data.requestId)) throw new ReaderError(400, 'A requestId is required');
        const request = await this.reviewDraft(bookId, data.requestId), draft = textValue(data.draft, 'draft', 50000, true);
        if (request.status === 'ready') {
            if (request.draft !== draft) throw new ReaderError(409, 'This request already has a different draft');
            return request;
        }
        await this.db.execute({ sql: `UPDATE reviewDrafts SET draft=?,status='ready',filledAt=? WHERE requestId=?`, args: [draft, new Date().toISOString(), request.requestId] });
        return this.reviewDraft(bookId, request.requestId);
    }
    async previewImport(bytes, filename, identity) {
        requireReader(identity);
        if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || filename.length > 255) throw new ReaderError(400, '请选择 xlsx 文件');
        const { parseWorkbook } = await import('./workbook.js');
        const existing = (await this.db.execute('SELECT dedupeKey FROM archives WHERE dedupeKey IS NOT NULL')).rows.map(row => row.dedupeKey);
        const rows = await parseWorkbook(bytes, await this.list(), existing);
        const occupied = new Set((await this.db.execute('SELECT bookId FROM archives WHERE bookId IS NOT NULL')).rows.map(row => row.bookId));
        for (const row of rows) {
            for (const candidate of row.candidates) candidate.hasArchive = occupied.has(candidate.id);
            if (row.record?.bookId && occupied.has(row.record.bookId)) {
                row.record.bookId = null;
                row.warnings.push({ kind: 'duplicate_book_link', message: '该 TXT 已有卡片，本行会作为未关联档案导入，内容完整保留。' });
            }
        }
        const matched = new Map();
        for (const row of rows.filter(row => !row.errors.length && !row.duplicate && row.record?.bookId)) {
            const previous = matched.get(row.record.bookId);
            if (previous) {
                const warning = { kind: 'duplicate_book_link', message: '同一 TXT 在本文件中有多条记录；选中多条时只关联第一条，其余内容完整保留为未关联档案。' };
                if (!previous.warnings.some(item => item.kind === warning.kind)) previous.warnings.push(warning);
                row.warnings.push(warning);
            } else matched.set(row.record.bookId, row);
        }
        const encoded = JSON.stringify(rows);
        if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new ReaderError(400, '预览内容过大，请分批导入');
        const previewId = randomUUID(), now = Date.now(), expiresAt = now + 1800000;
        await this.db.execute({ sql: 'DELETE FROM importPreviews WHERE expiresAt<? OR id IN (SELECT id FROM importPreviews ORDER BY createdAt DESC LIMIT -1 OFFSET 2)', args: [now] });
        await this.db.execute({ sql: 'INSERT INTO importPreviews VALUES (?,?,?,?,?)', args: [previewId, filename, encoded, now, expiresAt] });
        return { previewId, filename, expiresAt, rows: rows.map(({ dedupeKey, ...row }) => row) };
    }
    async commitImport(data, identity) {
        requireReader(identity); jsonObject(data);
        if (typeof data.previewId !== 'string' || !Array.isArray(data.rows) || !data.rows.length || data.rows.length > 5000) throw new ReaderError(400, '请选择要导入的记录');
        const preview = (await this.db.execute({ sql: 'SELECT * FROM importPreviews WHERE id=?', args: [data.previewId] })).rows[0];
        if (!preview || preview.expiresAt < Date.now()) throw new ReaderError(410, '预览已过期，请重新选择文件');
        if (data.links != null) jsonObject(data.links);
        const rows = JSON.parse(preview.rows), selected = [...new Set(data.rows.map(recordId))].map(number => rows.find(row => row.row === number));
        if (selected.some(row => !row || row.errors.length || !row.record)) throw new ReaderError(400, '选择的记录中有错误，请先修正文件');
        const now = new Date().toISOString(), statements = [];
        const occupied = new Set((await this.db.execute('SELECT bookId FROM archives WHERE bookId IS NOT NULL')).rows.map(row => row.bookId));
        for (const row of selected) {
            let bookId = data.links && row.row in data.links ? data.links[row.row] : row.record.bookId;
            if (bookId != null) {
                if (!row.candidates.some(book => book.id === bookId)) throw new ReaderError(400, '关联书籍不在该行的匹配列表中');
                // Books may have been removed/renamed since preview. Recheck before committing.
                const book = await this.book(bookId);
                if (book.title.trim() !== row.record.title || book.author.trim() !== row.record.author) throw new ReaderError(409, '书籍信息已变化，请重新预览');
            }
            const warnings = [...row.warnings];
            if (bookId && occupied.has(bookId)) {
                bookId = null;
                if (!warnings.some(warning => warning.kind === 'duplicate_book_link')) warnings.push({ kind: 'duplicate_book_link', message: '该 TXT 已关联另一张卡片，本记录保留内容并作为未关联档案导入。' });
            }
            // A skipped duplicate must not reserve the only association for a later new row.
            const duplicate = (await this.db.execute({ sql: 'SELECT id FROM archives WHERE dedupeKey=?', args: [row.dedupeKey] })).rows.length;
            if (bookId && !duplicate) occupied.add(bookId);
            const record = row.record;
            statements.push({ sql: `INSERT INTO archives
                (bookId,title,author,startedAt,finishedAt,readingMs,wordCount,fields,reflection,source,submittedAt,dedupeKey,original,warnings,createdAt,updatedAt)
                VALUES (?,?,?,?,?,?,?,?,?,'import',?,?,?,?,?,?) ON CONFLICT(dedupeKey) DO NOTHING RETURNING id`,
                args: [bookId, record.title, record.author, record.startedAt, record.finishedAt, record.readingMs, record.wordCount,
                    JSON.stringify(record.fields), record.reflection, record.submittedAt, row.dedupeKey, JSON.stringify(row.original), JSON.stringify(warnings), now, now] });
        }
        const results = await this.db.batch(statements, 'write');
        const inserted = results.flatMap(result => result.rows.map(row => row.id));
        return { inserted, imported: inserted.length, duplicates: selected.length - inserted.length };
    }
}
