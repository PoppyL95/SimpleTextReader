import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startReader } from './smoke.mjs';
import { sampleWorkbook, TENCENT_HEADERS } from './fixtures/review-workbook.mjs';
import { parseWorkbook } from '../app/reader/workbook.js';
import { activeReadingMs, REVIEW_FIELDS } from '../../shared/core/reader/review-fields.js';
import { ReaderStore } from '../app/reader/store.js';

for (const prefix of ['', '/reader']) test(`phase 3 API at ${prefix || '/'}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hals-reviews-'));
    let runtime = await startReader(directory, prefix);
    const data = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const reader = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, { ...options, headers: { ...options.headers, Origin: new URL(runtime.url).origin } });
    const hals = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, { ...options, headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
    const source = '第一章\n\n甲 段🙂。\n\n第二章\n末段。';
    let book, other, archive, preview, requestA, requestB;
    const workbook = await sampleWorkbook({ extraColumns: true });
    try {
        book = await (await reader('/books?filename=测试书.[测试作者].txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: source })).json();
        other = await (await reader('/books?filename=其他书.[测试作者].txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: source + '\n不同版' })).json();
        await t.test('reading starts on an action; cumulative sessions retry without duplicate time', async () => {
            const before = await (await hals(`/books/${book.id}/stats`)).json(); assert.equal(before.startedAt, null); assert.equal(before.readingMs, 0);
            assert.equal(before.wordCount, [...source].filter(char => !/\s/u.test(char)).length);
            const session = { sessionId: randomUUID(), startedAt: Date.now() - 60000, elapsedMs: 20000 };
            for (const elapsedMs of [20000, 20000, 10000, 30000]) {
                assert.equal((await reader(`/books/${book.id}/reading`, { method: 'POST', ...data({ ...session, elapsedMs }) })).status, 200);
            }
            const stats = await (await hals(`/books/${book.id}/stats`)).json(); assert.equal(stats.readingMs, 30000); assert(stats.startedAt);
            assert.equal((await reader(`/books/${other.id}/reading`, { method: 'POST', ...data(session) })).status, 409);
            assert.equal((await hals(`/books/${book.id}/reading`, { method: 'POST', ...data(session) })).status, 403);
        });
        await t.test('manual archives, exact options, conditional fields, filters, optimistic editing', async () => {
            const response = await reader('/archives', { method: 'POST', ...data({ bookId: book.id, title: book.title, author: book.author,
                startedAt: '2026-09-01', finishedAt: '2026-10-01', readingMs: 999999, wordCount: 99999, reflection: '读者手写感想',
                fields: { rating: '踩我雷点 滚', perspective: '主受', relationship: 'np', background: '现代', modern: ['娱乐圈'], ancient: ['修仙'],
                    style: ['背德：骨科、小妈、第三者等'], extraTags: '补充 标签,第三', platform: '长佩', completed: '已看完' } }) });
            assert.equal(response.status, 201); archive = await response.json();
            assert.equal(archive.readingMs, 30000); assert.notEqual(archive.wordCount, 99999); assert.deepEqual(archive.fields.ancient, []);
            assert(archive.tags.includes('踩我雷点 滚')); assert(archive.tags.includes('第三')); assert(archive.hasBook);
            assert.equal((await reader('/archives', { method: 'POST', ...data({ title: '错误选项', author: '作者', fields: { platform: '不存在的平台' } }) })).status, 400);
            assert.equal((await reader('/archives', { method: 'POST', ...data({ title: '错日期', author: '作者', startedAt: '2026-02-31' }) })).status, 400);
            assert.equal((await reader('/archives', { method: 'POST', ...data({ title: '倒序日期', author: '作者', startedAt: '2026-10-02', finishedAt: '2026-10-01' }) })).status, 400);
            const edited = await reader(`/archives/${archive.id}`, { method: 'PATCH', ...data({ reflection: '修改过的人类感想', updatedAt: archive.updatedAt }) });
            assert.equal(edited.status, 200); const changed = await edited.json();
            assert.equal((await reader(`/archives/${archive.id}`, { method: 'PATCH', ...data({ reflection: '旧页面', updatedAt: archive.updatedAt }) })).status, 409); archive = changed;
            assert.equal((await (await hals('/archives?platform=长佩&background=现代&tag=第三')).json()).length, 1);
            assert.equal((await (await hals('/archives?rating=值得多刷')).json()).length, 0);
            assert.equal((await hals(`/archives/${archive.id}`, { method: 'PATCH', ...data({ reflection: '陪读不得改人类感想', updatedAt: archive.updatedAt }) })).status, 403);
        });
        await t.test('one TXT owns one card, including concurrent creates and relinking', async () => {
            const response = await reader('/archives', { method: 'POST', ...data({ bookId: book.id, title: book.title, author: book.author }) });
            assert.equal(response.status, 409); const conflict = await response.json();
            assert.equal(conflict.code, 'archive_book_conflict'); assert.equal(conflict.archiveId, archive.id);
            assert.deepEqual(await (await reader(`/books/${book.id}/archive-candidates`)).json(), []);
            assert.equal((await reader(`/books/${other.id}/archive-link`, { method: 'POST', ...data({ recordIds: [archive.id, archive.id] }) })).status, 400);
            const attempts = await Promise.all([1, 2].map(() => reader('/archives', { method: 'POST', ...data({ bookId: other.id, title: other.title, author: other.author }) })));
            assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
            const created = await attempts.find(r => r.status === 201).json();
            assert.equal((await reader(`/archives/${created.id}`, { method: 'DELETE' })).status, 204);
        });
        await t.test('xlsx preview does not write, reports rows, preserves unknowns, deduplicates import', async () => {
            const response = await reader('/archive-import/preview?filename=样例.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: workbook });
            assert.equal(response.status, 200); preview = await response.json(); assert.equal(preview.rows.length, 4);
            assert.equal((await (await hals('/archives')).json()).length, 1, 'preview must not write archives');
            assert(preview.rows.find(row => row.row === 4).errors.length); assert(preview.rows.find(row => row.row === 5).duplicate);
            const unknown = preview.rows.find(row => row.row === 3); assert.equal(unknown.record.bookId, null); assert(unknown.warnings.length >= 3);
            assert(unknown.record.fields.extraTags.includes('自定义评价')); assert(unknown.record.fields.extraTags.includes('自定义风格'));
            assert(preview.rows.every(row => row.warnings.some(warning => warning.kind === 'unknown_column' && warning.label === '保留测试列' && warning.message.includes('未识别表头'))));
            assert.equal(preview.rows[0].original['保留测试列'], '  原始空白也要保留  ');
            assert.equal((await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 4] }) })).status, 400);
            assert.equal((await (await hals('/archives')).json()).length, 1);
            const first = await (await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 3, 5] }) })).json();
            assert.equal(first.imported, 2); assert.equal(first.duplicates, 1);
            const again = await (await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 3, 5] }) })).json();
            assert.equal(again.imported, 0); assert.equal(again.duplicates, 3);
            const records = await (await hals('/archives')).json(); assert.equal(records.length, 3);
            const imported = records.find(record => record.source === 'import' && record.title === '测试书');
            assert.equal(imported.bookId, null); assert(imported.warnings.some(warning => warning.kind === "duplicate_book_link")); assert.equal(imported.reflection, '导入的感想');
            assert.deepEqual(imported.fields.ancient, ['修仙', '武侠江湖']);
            const raw = await (await hals(`/archives/${imported.id}`)).json(); assert.equal(raw.original['保留测试列'], '  原始空白也要保留  ');
            assert(raw.warnings.some(warning => warning.kind === 'unknown_column' && warning.label === '保留测试列'));
            const freshPreview = await (await reader('/archive-import/preview?filename=样例.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: workbook })).json();
            assert(freshPreview.rows.filter(row => !row.errors.length).every(row => row.duplicate));
            assert.equal((await reader('/archive-import/preview?filename=bad.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'not an xlsx' })).status, 400);
        });
        await t.test('missing txt stays viewable; matching later upload prompts explicit linking', async () => {
            const record = (await (await hals('/archives')).json()).find(record => record.title === '未上传书'); assert.equal(record.hasBook, false);
            const later = await (await reader('/books?filename=未上传书.[原作者].txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '这是晚上传的原文。' })).json();
            assert.equal((await (await hals(`/archives/${record.id}`)).json()).bookId, null, 'upload cannot silently link');
            const candidates = await (await reader(`/books/${later.id}/archive-candidates`)).json(); assert.equal(candidates.length, 1); assert.equal(candidates[0].id, record.id);
            assert.equal((await reader(`/books/${later.id}/archive-link`, { method: 'POST', ...data({ recordIds: [archive.id] }) })).status, 409);
            assert.equal((await reader(`/books/${later.id}/archive-link`, { method: 'POST', ...data({ recordIds: [record.id] }) })).status, 200);
            assert.equal((await (await hals(`/archives/${record.id}`)).json()).bookId, later.id);
        });
        await t.test('manual linking accepts different metadata and preserves the archive with conflict checks', async () => {
            const original = await (await reader('/archives', { method: 'POST', ...data({ title: '档案里的别名', author: '档案笔名',
                finishedAt: '2026-09-25', reflection: '保留手写的读后感', fields: { rating: '值得多刷', extraTags: '保留标签' } }) })).json();
            const patch = (changes, identity = reader) => identity(`/archives/${original.id}`, { method: 'PATCH', ...data({ updatedAt: original.updatedAt, ...changes }) });
            assert.equal((await patch({ bookId: '0'.repeat(64) })).status, 404);
            assert.equal((await patch({ bookId: book.id }, hals)).status, 403);
            const occupied = await patch({ bookId: book.id }); assert.equal(occupied.status, 409); assert.equal((await occupied.json()).archiveId, archive.id);
            const response = await patch({ bookId: other.id }); assert.equal(response.status, 200);
            const linked = await response.json(); assert.equal(linked.bookId, other.id); assert(linked.hasBook);
            for (const key of ['title', 'author', 'finishedAt', 'reflection', 'fields', 'original', 'source']) assert.deepEqual(linked[key], original[key], key);
            assert.equal((await patch({ bookId: other.id })).status, 409, 'an old picker must not overwrite a newer association');
            const changed = await (await reader(`/archives/${original.id}`, { method: 'PATCH', ...data({ updatedAt: linked.updatedAt, reflection: original.reflection }) })).json();
            assert.equal(changed.bookId, other.id); assert.equal(changed.reflection, original.reflection);
            assert.equal((await reader(`/archives/${original.id}`, { method: 'DELETE' })).status, 204);
            const imported = (await (await hals('/archives')).json()).find(record => record.title === '未上传书');
            const raw = await (await hals(`/archives/${imported.id}`)).json();
            const relinked = await (await reader(`/archives/${raw.id}`, { method: 'PATCH', ...data({ updatedAt: raw.updatedAt, bookId: other.id }) })).json();
            assert.equal(relinked.bookId, other.id);
            for (const key of ['title', 'author', 'finishedAt', 'reflection', 'fields', 'original', 'warnings', 'submittedAt', 'source']) assert.deepEqual(relinked[key], raw[key], `imported ${key}`);
        });
        await t.test('draft handoff snapshots notes; request affinity, late responses and idempotence', async () => {
            const note = await (await hals(`/books/${book.id}/notes`, { method: 'POST', ...data({ line: 3, text: '为起草准备的批注' }) })).json();
            requestA = await (await reader(`/books/${book.id}/draft-request`, { method: 'POST', ...data({ archiveId: archive.id }) })).json();
            requestB = await (await reader(`/books/${book.id}/draft-request`, { method: 'POST', ...data({ archiveId: archive.id }) })).json();
            assert.notEqual(requestA.requestId, requestB.requestId);
            const queue = await (await hals('/handoff?unread=1')).json();
            assert.equal(queue.items.length, 2); assert.equal(queue.items[0].type, 'draft_request');
            assert.equal(queue.items[0].payload.requestId, requestA.requestId); assert(queue.items[0].payload.notes.some(item => item.id === note.id));
            assert.equal((await reader(`/books/${book.id}/review-draft`, { method: 'POST', ...data({ requestId: requestB.requestId, draft: '浏览器不能冒充小克' }) })).status, 403);
            assert.equal((await hals(`/books/${other.id}/review-draft`, { method: 'POST', ...data({ requestId: requestB.requestId, draft: '跨书错误' }) })).status, 404);
            const readyB = await (await hals(`/books/${book.id}/review-draft`, { method: 'POST', ...data({ requestId: requestB.requestId, draft: '新的小克草稿' }) })).json();
            assert.deepEqual(await (await hals(`/books/${book.id}/review-draft`, { method: 'POST', ...data({ requestId: requestB.requestId, draft: '新的小克草稿' }) })).json(), readyB);
            assert.equal((await hals(`/books/${book.id}/review-draft`, { method: 'POST', ...data({ requestId: requestB.requestId, draft: '同请求不得换内容' }) })).status, 409);
            await hals(`/books/${book.id}/review-draft`, { method: 'POST', ...data({ requestId: requestA.requestId, draft: '晚到的旧草稿' }) });
            assert.equal((await (await hals(`/books/${book.id}/review-draft?archiveId=${archive.id}`)).json()).requestId, requestB.requestId);
            assert.equal((await (await hals(`/archives/${archive.id}`)).json()).reflection, '修改过的人类感想');
            assert.equal((await (await hals('/handoff?unread=1')).json()).items.length, 2, 'returning a draft must not implicitly ack');
            assert.equal((await hals(`/handoff/${requestA.handoffId}/ack`, { method: 'POST' })).status, 200);
        });
        await t.test('restart persists archives/drafts/time; deleting txt preserves archive; record CRUD', async () => {
            await runtime.stop(); runtime = await startReader(directory, prefix, runtime.token);
            assert.equal((await (await hals(`/books/${book.id}/stats`)).json()).readingMs, 30000);
            assert.equal((await (await hals(`/books/${book.id}/review-draft?requestId=${requestA.requestId}`)).json()).draft, '晚到的旧草稿');
            assert.equal((await (await hals('/archives')).json()).length, 3);
            assert.equal((await reader(`/books/${book.id}`, { method: 'DELETE' })).status, 204);
            const retained = await (await hals(`/archives/${archive.id}`)).json(); assert.equal(retained.bookId, null); assert.equal(retained.hasBook, false); assert.equal(retained.reflection, '修改过的人类感想');
            assert.equal((await reader(`/archives/${archive.id}`, { method: 'DELETE' })).status, 204);
            assert.equal((await hals(`/archives/${archive.id}`)).status, 404);
            assert.equal((await fetch(runtime.url + '/api/archives', { headers: { Authorization: 'Bearer bad' } })).status, 401);
            assert.equal((await fetch(runtime.url + '/reader.db')).status, 404);
        });
    } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('Tencent required headers map every questionnaire field; plain and conditional headers remain compatible', async () => {
    const conditional = [...TENCENT_HEADERS];
    conditional[8] = '└ 现代（选现代才出）（必填）';
    conditional[9] = '└ 古代（选古代才出）';
    conditional[10] = '└ 未来（选未来才出）';
    conditional[11] = '└ 同人（选架空(衍生)才出）（必填）';
    const variants = [TENCENT_HEADERS,
        TENCENT_HEADERS.map(name => ` ${name.replaceAll('（', ' ( ').replaceAll('）', ' ) ')} `),
        TENCENT_HEADERS.map(name => name.replace('（必填）', '').replace('（自动）', '')), conditional];
    for (const headers of variants) {
        const rows = await parseWorkbook(await sampleWorkbook({ headers }), [], []);
        assert.deepEqual(rows[0].record.fields, { characters: '虚构主角', rating: '值得多刷', perspective: '女主',
            relationship: '1v1', background: '古代', modern: [], ancient: ['修仙', '武侠江湖'], future: [], fanfiction: [],
            style: ['小甜饼', '年龄差（年下/年上）'], extraTags: '测试 标签, 甲', platform: '晋江', completed: '已看完' });
        assert.deepEqual(rows[0].warnings, []); assert.deepEqual(rows[0].errors, []);
        assert(rows[3].duplicate); assert.equal(rows[0].record.submittedAt, '2026-09-30T12:30:00.000Z');
        assert.deepEqual(rows[1].record.fields.future, ['星际']);
        assert(rows[1].warnings.some(warning => warning.value === '未知未来选项'));
        assert(rows[1].record.fields.extraTags.includes('自定义评价'));
    }
    const rows = await parseWorkbook(await sampleWorkbook(), [], []);
    assert.deepEqual(Object.keys(rows[0].original), TENCENT_HEADERS);
    assert.equal(rows[0].original['角色（必填）'], '虚构主角');
    const unknownHeaders = [...TENCENT_HEADERS]; unknownHeaders[8] = '新版现代题（必填）';
    const unknownRows = await parseWorkbook(await sampleWorkbook({ headers: unknownHeaders }), [], []);
    assert.equal(unknownRows[0].original['新版现代题（必填）'], '');
    assert.deepEqual(unknownRows[0].warnings.map(warning => warning.label), ['新版现代题（必填）']);
    assert.equal(unknownRows[0].warnings[0].kind, 'unknown_column', 'an empty cell must still warn about its unrecognized header');
});

test('reading duration respects visible time and the two-minute idle boundary', () => {
    const start = 1000000;
    assert.equal(activeReadingMs(start, start + 90000, start, true), 90000);
    assert.equal(activeReadingMs(start + 90000, start + 180000, start, true), 30000);
    assert.equal(activeReadingMs(start + 180000, start + 200000, start, true), 0);
    assert.equal(activeReadingMs(start, start + 30000, start, false), 0);
    assert.equal(activeReadingMs(start, start + 30000, 0, true), 0);
    assert.equal(activeReadingMs(start + 5000, start, start, true), 0);
    assert.deepEqual(REVIEW_FIELDS.find(field => field.key === 'rating').options, ['值得多刷', '可圈可点', '文荒可看', '看不下去', '踩我雷点 滚']);
});

test('legacy duplicate TXT links retain every record and migrate once to the latest edited card', async () => {
    const directory = await mkdtemp('/tmp/hals-card-migration-');
    let store = await new ReaderStore(directory).init();
    try {
        const book = await store.upload(Buffer.from('第一章\n保留原文。'), '迁移测试.[作者].txt');
        const older = await store.createArchive({ bookId: book.id, title: '较早卡片', author: '作者', reflection: '旧感想完整保留' }, { author: 'reader' });
        await store.db.execute('DROP INDEX archives_unique_book');
        await store.db.execute({ sql: `INSERT INTO archives (bookId,title,author,fields,reflection,source,createdAt,updatedAt)
            VALUES (?,?,?,? ,?,'manual',?,?)`, args: [book.id, '最近编辑的卡片', '作者', JSON.stringify(older.fields), '新感想也保留', '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'] });
        store.db.close(); store = await new ReaderStore(directory).init();
        const records = await store.archives(); assert.equal(records.length, 2);
        const linked = records.filter(record => record.bookId === book.id); assert.equal(linked.length, 1); assert.equal(linked[0].title, '最近编辑的卡片');
        const unlinked = await store.archive(older.id); assert.equal(unlinked.bookId, null); assert.equal(unlinked.reflection, older.reflection);
        assert(unlinked.warnings.some(warning => warning.kind === 'duplicate_book_link'));
        await store.ensureUniqueArchives(); assert.equal((await store.archive(older.id)).warnings.length, unlinked.warnings.length);
        await assert.rejects(store.createArchive({ bookId: book.id, title: '重复', author: '作者' }, { author: 'reader' }), error => error.status === 409 && error.archiveId === linked[0].id);
        await assert.rejects(store.db.execute({ sql: 'UPDATE archives SET bookId=? WHERE id=?', args: [book.id, older.id] }), /UNIQUE/);
    } finally { store.db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('two submissions for the same TXT import every record but link only one card', async () => {
    const directory = await mkdtemp('/tmp/hals-import-single-card-');
    const store = await new ReaderStore(directory).init(), identity = { author: 'reader' };
    try {
        const book = await store.upload(Buffer.from('第一章\n同书不同提交。'), '测试书.[测试作者].txt');
        const preview = await store.previewImport(await sampleWorkbook({ extraColumns: true, anotherSubmission: true }), '样例.xlsx', identity);
        for (const number of [2, 6]) assert(preview.rows.find(row => row.row === number).warnings.some(warning => warning.kind === 'duplicate_book_link'));
        const result = await store.commitImport({ previewId: preview.previewId, rows: [2, 6] }, identity);
        assert.equal(result.imported, 2);
        const records = await store.archives(); assert.equal(records.length, 2);
        assert.equal(records.filter(record => record.bookId === book.id).length, 1);
        const unlinked = records.find(record => !record.bookId); assert.equal(unlinked.reflection, '同书另一条感想完整保留');
        assert(unlinked.warnings.some(warning => warning.kind === 'duplicate_book_link'));
        assert.equal((await store.archive(unlinked.id)).original['角色（必填）'], '虚构主角');
    } finally { store.db.close(); await rm(directory, { recursive: true, force: true }); }
});
