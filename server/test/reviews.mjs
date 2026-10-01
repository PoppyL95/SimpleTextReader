import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startReader } from './smoke.mjs';
import { sampleWorkbook } from './fixtures/review-workbook.mjs';
import { activeReadingMs, REVIEW_FIELDS } from '../../shared/core/reader/review-fields.js';

for (const prefix of ['', '/reader']) test(`phase 3 API at ${prefix || '/'}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hals-reviews-'));
    let runtime = await startReader(directory, prefix);
    const data = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const reader = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, { ...options, headers: { ...options.headers, Origin: new URL(runtime.url).origin } });
    const hals = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, { ...options, headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
    const source = '第一章\n\n甲 段🙂。\n\n第二章\n末段。';
    let book, other, archive, preview, requestA, requestB;
    const workbook = await sampleWorkbook();
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
        await t.test('xlsx preview does not write, reports rows, preserves unknowns, deduplicates import', async () => {
            const response = await reader('/archive-import/preview?filename=样例.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: workbook });
            assert.equal(response.status, 200); preview = await response.json(); assert.equal(preview.rows.length, 4);
            assert.equal((await (await hals('/archives')).json()).length, 1, 'preview must not write archives');
            assert(preview.rows.find(row => row.row === 4).errors.length); assert(preview.rows.find(row => row.row === 5).duplicate);
            const unknown = preview.rows.find(row => row.row === 3); assert.equal(unknown.record.bookId, null); assert(unknown.warnings.length >= 3);
            assert(unknown.record.fields.extraTags.includes('自定义评价')); assert(unknown.record.fields.extraTags.includes('自定义风格'));
            assert.equal(preview.rows[0].original['保留测试列'], '  原始空白也要保留  ');
            assert.equal((await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 4] }) })).status, 400);
            assert.equal((await (await hals('/archives')).json()).length, 1);
            const first = await (await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 3, 5] }) })).json();
            assert.equal(first.imported, 2); assert.equal(first.duplicates, 1);
            const again = await (await reader('/archive-import/commit', { method: 'POST', ...data({ previewId: preview.previewId, rows: [2, 3, 5] }) })).json();
            assert.equal(again.imported, 0); assert.equal(again.duplicates, 3);
            const records = await (await hals('/archives')).json(); assert.equal(records.length, 3);
            const imported = records.find(record => record.source === 'import' && record.title === '测试书');
            assert.equal(imported.bookId, book.id); assert.equal(imported.reflection, '导入的感想');
            assert.deepEqual(imported.fields.ancient, ['修仙', '武侠江湖']);
            const raw = await (await hals(`/archives/${imported.id}`)).json(); assert.equal(raw.original['保留测试列'], '  原始空白也要保留  ');
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
