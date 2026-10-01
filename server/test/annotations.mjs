import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startReader } from './smoke.mjs';
import { createLineMap, selectionQuote } from '../../shared/core/reader/coordinates.js';

for (const prefix of ['', '/reader']) test(`phase 2 API at ${prefix || '/'}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hals-notes-'));
    let runtime = await startReader(directory, prefix);
    const json = data => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const companion = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, {
        ...options, headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
    const reader = (endpoint, options = {}) => fetch(runtime.url + '/api' + endpoint, {
        ...options, headers: { ...options.headers, Origin: new URL(runtime.url).origin } });
    const source = '第一章 测试\r\n\r\n  甲段中文🙂。\r\n\r\n乙段中文。\r\n';
    let book, other, highlight, reply, hals, handoff;
    const selection = { startLine: 3, startOffset: 3, endLine: 5, endOffset: 4,
        quote: selectionQuote(source.split('\n'), { startLine: 3, startOffset: 3, endLine: 5, endOffset: 4 }) };
    try {
        for (const text of [source, source + '另一版']) {
            const response = await companion('/books?filename=测试.[作者].txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
            assert.equal(response.status, 201);
            if (!book) book = await response.json(); else other = await response.json();
        }
        const notesPath = `/books/${book.id}/notes`;
        await t.test('original cross-paragraph coordinates, quote validation and server-owned author', async () => {
            const response = await reader(notesPath, { method: 'POST', ...json({ kind: 'highlight', ...selection, author: 'hals' }) });
            assert.equal(response.status, 201); highlight = await response.json();
            assert.equal(highlight.author, 'reader'); assert.equal(highlight.line, 3); assert.equal(highlight.quote, selection.quote);
            assert(highlight.readAt);
            for (const invalid of [{ ...selection, quote: '错误原文' }, { ...selection, startLine: 0 },
                { ...selection, endOffset: 999 }, { ...selection, startOffset: -1 }, { ...selection, endLine: 2 }]) {
                assert.equal((await reader(notesPath, { method: 'POST', ...json({ kind: 'highlight', ...invalid }) })).status, 400);
            }
            assert.equal((await companion(notesPath, { method: 'POST', ...json({ line: 999, text: '越界' }) })).status, 400);
            const responseHals = await companion(notesPath, { method: 'POST', ...json({ line: 3, text: '<img src=x onerror=alert(1)>小克批注', author: 'reader' }) });
            assert.equal(responseHals.status, 201); hals = await responseHals.json();
            assert.equal(hals.author, 'hals'); assert.equal(hals.readAt, null);
        });
        await t.test('same-book flat threads and chronological ordering', async () => {
            assert.equal((await companion(`/books/${other.id}/notes`, { method: 'POST', ...json({ text: '跨书回复', parentId: highlight.id }) })).status, 404);
            assert.equal((await companion(notesPath, { method: 'POST', ...json({ line: 5, text: '错行回复', parentId: highlight.id }) })).status, 400);
            reply = await (await reader(notesPath, { method: 'POST', ...json({ text: '读者回复', parentId: highlight.id }) })).json();
            assert.equal(reply.line, 3); assert.equal(reply.parentId, highlight.id);
            const nested = await (await companion(notesPath, { method: 'POST', ...json({ text: '小克回复', parentId: reply.id }) })).json();
            assert.equal(nested.parentId, highlight.id);
            const notes = await (await companion(notesPath)).json();
            assert.deepEqual(notes.map(note => note.id), [highlight.id, hals.id, reply.id, nested.id]);
            assert.equal(notes.find(note => note.id === hals.id).readAt, null, 'GET must not mark notes read');
        });
        await t.test('edit/delete ownership and explicit reader read state', async () => {
            assert.equal((await reader(`${notesPath}/${hals.id}`, { method: 'PATCH', ...json({ text: '伪造修改' }) })).status, 403);
            assert.equal((await companion(`${notesPath}/${highlight.id}`, { method: 'DELETE' })).status, 403);
            assert.equal((await companion(`${notesPath}/${hals.id}/read`, { method: 'POST', ...json({}) })).status, 403);
            assert.equal((await reader(`${notesPath}/read`, { method: 'POST', ...json({ ids: [hals.id, 999999] }) })).status, 404);
            let notes = await (await reader(notesPath)).json(); assert.equal(notes.find(note => note.id === hals.id).readAt, null);
            assert.equal((await reader(`${notesPath}/${hals.id}/read`, { method: 'POST', ...json({}) })).status, 200);
            notes = await (await reader(notesPath)).json(); assert(notes.find(note => note.id === hals.id).readAt);
            const edited = await (await companion(`${notesPath}/${hals.id}`, { method: 'PATCH', ...json({ text: '编辑后重新未读', author: 'reader' }) })).json();
            assert.equal(edited.author, 'hals'); assert.equal(edited.readAt, null); assert.equal(edited.createdAt, hals.createdAt);
            assert.equal((await reader(`${notesPath}/read`, { method: 'POST', ...json({ ids: [hals.id], versions: { [hals.id]: hals.updatedAt } }) })).status, 409,
                'an edited comment must not be marked read using an older displayed version');
            const editedHighlight = await reader(`${notesPath}/${highlight.id}`, { method: 'PATCH', ...json({ text: '划线说明' }) });
            assert.equal(editedHighlight.status, 200); assert.equal((await editedHighlight.json()).quote, selection.quote);
            assert.equal((await reader(`${notesPath}/${highlight.id}`, { method: 'PATCH', ...json({ startLine: 5, startOffset: 0, endLine: 5, endOffset: 2, quote: '乙段' }) })).status, 400);
            const changedHighlight = await reader(`${notesPath}/${highlight.id}`, { method: 'PATCH', ...json({ startOffset: 4, endLine: 3, endOffset: 6, quote: '中文' }) });
            assert.equal(changedHighlight.status, 200); assert.equal((await changedHighlight.json()).endLine, 3);
            assert.equal((await reader(`${notesPath}/${reply.id}`, { method: 'PATCH', ...json({ line: 5 }) })).status, 400);
            assert.equal((await reader(`${notesPath}/${reply.id}`, { method: 'PATCH', ...json({ text: '' }) })).status, 400);
            assert.equal((await reader(`${notesPath}/${hals.id}/read`, { method: 'POST', ...json({ read: false }) })).status, 200);
        });
        await t.test('server-generated queue, stable cursor pagination, no implicit ack, idempotent ack', async () => {
            assert.equal((await reader('/handoff', { method: 'POST', ...json({ type: 'anything', payload: {} }) })).status, 404);
            assert.equal((await companion(`/books/${book.id}/handoff`, { method: 'POST', ...json(selection) })).status, 403);
            const ids = [];
            for (let i = 0; i < 3; i++) {
                const response = await reader(`/books/${book.id}/handoff`, { method: 'POST', ...json({ ...selection, chapter: '第一章', type: 'fake', payload: 'fake' }) });
                assert.equal(response.status, 201); const item = await response.json(); ids.push(item.id);
                assert.equal(item.type, 'selection'); assert.equal(item.payload.title, book.title); assert.equal(item.payload.chapter, '第一章');
                assert.equal(item.payload.quote, selection.quote); assert.equal(item.payload.startLine, 3);
            }
            const page1 = await (await companion('/handoff?unread=1&limit=2')).json();
            assert.deepEqual(await (await companion('/handoff?unread=1&limit=2&cursor=0')).json(), page1);
            assert.deepEqual(page1.items.map(item => item.id), ids.slice(0, 2)); assert.equal(page1.nextCursor, ids[1]);
            const repeated = await (await companion('/handoff?unread=1&limit=2')).json(); assert.deepEqual(repeated, page1);
            const page2 = await (await companion(`/handoff?unread=1&limit=2&cursor=${page1.nextCursor}`)).json();
            assert.deepEqual(page2.items.map(item => item.id), ids.slice(2)); assert.equal(page2.nextCursor, null);
            handoff = await (await companion(`/handoff/${ids[0]}/ack`, { method: 'POST' })).json();
            assert(handoff.acknowledgedAt);
            assert.deepEqual(await (await companion(`/handoff/${ids[0]}/ack`, { method: 'POST' })).json(), handoff);
            assert.deepEqual((await (await companion('/handoff?unread=1')).json()).items.map(item => item.id), ids.slice(1));
            assert.equal((await companion('/handoff?limit=201')).status, 400);
            assert.equal((await companion('/handoff?cursor=-1')).status, 400);
        });
        await t.test('new endpoints retain authentication and static isolation', async () => {
            for (const endpoint of [notesPath, '/handoff?unread=1']) {
                assert.equal((await fetch(runtime.url + '/api' + endpoint, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
            }
            assert.equal((await fetch(runtime.url + '/api' + notesPath, { method: 'POST', ...json({ line: 3, text: '跨站' }),
                headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' } })).status, 403);
            assert.equal((await fetch(runtime.url + '/reader.db')).status, 404);
            assert.equal((await fetch(runtime.url + `/books/${book.id}.txt`)).status, 404);
        });
        await t.test('restart persistence and deletion cascades', async () => {
            await runtime.stop(); runtime = await startReader(directory, prefix, runtime.token);
            const notes = await (await companion(notesPath)).json(); assert.equal(notes.length, 4);
            assert.equal(notes.find(note => note.id === highlight.id).text, '划线说明');
            assert.equal(notes.find(note => note.id === highlight.id).quote, '中文');
            assert.deepEqual((await (await companion('/handoff')).json()).items[0], handoff);
            assert.equal((await reader(`${notesPath}/${highlight.id}`, { method: 'DELETE' })).status, 204);
            assert.deepEqual((await (await companion(notesPath)).json()).map(note => note.id), [hals.id]);
            assert.equal((await companion(`/books/${book.id}`, { method: 'DELETE' })).status, 204);
            assert.deepEqual((await (await companion('/handoff')).json()).items, []);
            assert.equal((await companion(notesPath)).status, 404);
        });
    } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('character mapping preserves original whitespace, symbols, CR fragments, emoji, entities and drop caps', () => {
    const map = createLineMap('标题\r\n\n  中\u200b文🙂 &amp; <em>正文</em>  \r第二段\nhello', 3);
    assert.equal(map.toOriginal(4), 3); assert.equal(map.toOriginal(5), 3);
    const positions = map.characters(4, '中文🙂 & 正文');
    assert.equal(positions[0].start, 2); assert.equal(positions[1].start, 4);
    assert.equal(positions[5].start, 8); assert.equal(positions[5].end, 13);
    assert.equal(map.characters(6, 'Hello')[0].start, 0);
    assert.equal(map.characters(4, '不存在'), null);
    assert.equal(createLineMap('a★a★b').characters(2, 'ab'), null, 'ambiguous stripped text must not guess a position');
});
