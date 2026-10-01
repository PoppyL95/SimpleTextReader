import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createLineMap } from '../../shared/core/reader/coordinates.js';
import { TextProcessorCore } from '../../shared/core/text/text-processor-core.js';

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startReader(directory, basePath = '', token = randomBytes(24).toString('hex'), requestedPort) {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(requestedPort || 0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['app/app.js'], { cwd, env: { ...process.env, PORT: String(port),
        BASE_PATH: basePath, DATA_DIR: directory, HALS_TOKEN: token, TRUSTED_PROXY: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15000);
        child.stdout.on('data', data => { output += data; if (output.includes('Reader listening')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', data => { output += data; });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
    return { child, port, token, url: `http://127.0.0.1:${port}${basePath}`, async stop() {
        if (child.exitCode !== null) return;
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
    } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    for (const prefix of ['', '/reader']) test(`phase 1 API at ${prefix || '/'}`, async t => {
        const directory = await mkdtemp(path.join(tmpdir(), 'hals-api-'));
        let runtime;
        try {
            runtime = await startReader(directory, prefix);
            const call = (endpoint, options = {}) => fetch(runtime.url + endpoint, { ...options,
                headers: { Authorization: `Bearer ${runtime.token}`, ...options.headers } });
            const text = '第一章 测试\n\n第一段中文。\n\n第二段中文。\n';
            let id;
            await t.test('root, prefixed resources, manifest, and loopback binding', async () => {
                assert.equal((await fetch(runtime.url + '/')).status, 200);
                const manifest = await (await fetch(runtime.url + '/client/manifests/PWA/manifest.json')).json();
                assert.equal(manifest.scope, `${prefix}/`); assert.equal(manifest.start_url, `${prefix}/`);
                assert.equal((await fetch(runtime.url + '/client/app/app.js')).status, 200);
                assert.equal((await fetch(runtime.url + '/shared/core/reader/coordinates.js')).status, 200);
                if (prefix) {
                    assert.equal((await fetch(runtime.url, { redirect: 'manual' })).status, 301);
                    assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/api`)).status, 404);
                }
            });
            await t.test('invalid bearer cannot fall back; browser CSRF and same-origin checks', async () => {
                for (const auth of ['Bearer wrong', 'Bearer', 'Basic invalid']) {
                    assert.equal((await fetch(runtime.url + '/api/books', { headers: { Authorization: auth } })).status, 401);
                }
                assert.equal((await fetch(runtime.url + '/api/books?filename=test.txt', { method: 'POST',
                    headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' }, body: text })).status, 403);
                assert.equal((await fetch(runtime.url + '/api/books?filename=test.txt', { method: 'POST',
                    headers: { 'Content-Type': 'text/plain' }, body: text })).status, 403);
                const health = await fetch(runtime.url + '/api'); const cookie = health.headers.get('set-cookie').split(';')[0];
                const csrf = (await health.json()).csrfToken;
                const uploaded = await fetch(runtime.url + '/api/books?filename=测试.txt', { method: 'POST', headers: {
                    'Content-Type': 'text/plain', Cookie: cookie, 'X-CSRF-Token': csrf }, body: text });
                assert.equal(uploaded.status, 201); id = (await uploaded.json()).id;
            });
            await t.test('UTF-8 hash, original blank lines, dedup, and same-name different books', async () => {
                assert.equal(id, createHash('sha256').update(text).digest('hex'));
                const duplicate = await call('/api/books?filename=renamed.txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
                assert.equal((await duplicate.json()).id, id);
                const other = await call('/api/books?filename=renamed.txt', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text + '另一版' });
                const otherId = (await other.json()).id; assert.notEqual(otherId, id);
                assert.equal((await (await call('/api/books')).json()).length, 2);
                assert.equal(await (await call(`/api/books/${id}/download`)).text(), text);
                const excerpt = await (await call(`/api/books/${id}/text?from=2&to=4`)).json();
                assert.equal(excerpt.text, '\n第一段中文。\n');
                assert.equal((await call(`/api/books/${id}/text?from=0&to=3`)).status, 400);
                assert.equal((await call(`/api/books/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: '新书名', author: '测试作者' }) })).status, 200);
                assert.equal((await call(`/api/books/${otherId}`, { method: 'DELETE' })).status, 204);
            });
            await t.test('newest action wins, backtracking and beacon retries, offset validation', async () => {
                const now = Date.now();
                const put = data => call(`/api/books/${id}/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                const newer = { line: 5, offset: 2, clientUpdatedAt: now, deviceId: 'A', chapter: '第一章' };
                assert.equal((await put(newer)).status, 200);
                assert.equal((await put({ ...newer, line: 3, clientUpdatedAt: now - 1, deviceId: 'B' })).status, 409);
                assert.equal((await put({ ...newer, line: 3, clientUpdatedAt: now + 1 })).status, 200);
                assert.equal((await put({ ...newer, line: 3, clientUpdatedAt: now + 1 })).status, 200);
                assert.equal((await put({ ...newer, offset: 100 })).status, 400);
                assert.equal((await put({ ...newer, line: 0 })).status, 400);
                const beacon = await fetch(runtime.url + `/api/books/${id}/progress`, { method: 'POST', headers: {
                    'Content-Type': 'application/json', Origin: `http://127.0.0.1:${runtime.port}` },
                    body: JSON.stringify({ ...newer, line: 3, clientUpdatedAt: now + 2 }) });
                assert.equal(beacon.status, 200);
            });
            await t.test('server data and source are never static resources', async () => {
                for (const resource of [`/books/${id}.txt`, `/reader.db`, '/.reader-data/reader.db', '/server/prisma/schema.prisma',
                    '/server/package.json', '/package.json', '/client/app/../../server/package.json']) {
                    assert.equal((await fetch(runtime.url + resource)).status, 404, resource);
                }
                assert.equal((await readFile(path.join(directory, 'reader.db'))).subarray(0, 16).toString(), 'SQLite format 3\0');
            });
            await t.test('prefixed WebSocket heartbeat and invalid companion credentials', async () => {
                const ws = new WebSocket(runtime.url.replace('http:', 'ws:') + '/ws', { headers: { Authorization: `Bearer ${runtime.token}` } });
                await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
                const pong = new Promise(resolve => ws.once('pong', resolve)); ws.ping(); await pong; ws.close();
                const invalid = new WebSocket(runtime.url.replace('http:', 'ws:') + '/ws', { headers: { Authorization: 'Bearer invalid' } });
                await new Promise((resolve, reject) => { invalid.once('error', resolve); invalid.once('open', () => reject(new Error('invalid WS accepted'))); });
            });
            await t.test('restart persists book and progress; missing HALS_TOKEN disables companion', async () => {
                await runtime.stop(); runtime = await startReader(directory, prefix, '');
                assert.equal((await fetch(runtime.url + '/api/books', { headers: { Authorization: 'Bearer whatever' } })).status, 401);
                const books = await (await fetch(runtime.url + '/api/books')).json();
                assert.equal(books.length, 1); assert.equal(books[0].id, id); assert.equal(books[0].progress.line, 3);
                assert.equal(books[0].author, '测试作者');
            });
        } finally { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); }
    });
    test('original/render coordinates retain blanks, CRLF, Chinese and trailing blank lines', () => {
        const map = createLineMap('第一章\r\n\r\n  中文正文  \r\n\n下一段\n', 3);
        assert.equal(map.toOriginal(3), 1); assert.equal(map.toOriginal(4), 3); assert.equal(map.toOriginal(5), 5);
        assert.equal(map.toRendered(3), 4); assert.equal(map.toRendered(2), 4); assert.equal(map.toOriginal(6), 6);
    });
    test('filename metadata recognizes Chinese book brackets and by without breaking existing formats', () => {
        for (const [filename, title, author] of [
            ['《纸船夜航》 by 秋舟', '纸船夜航', '秋舟'],
            ['《纸船夜航》by秋舟', '纸船夜航', '秋舟'],
            ['纸船夜航 BY 虚构作者', '纸船夜航', '虚构作者'],
            ['《纸船夜航》  By： 秋舟', '纸船夜航', '秋舟'],
            ['Paper Boats by River Reed', 'Paper Boats', 'River Reed'],
            ['《纸船夜航》', '纸船夜航', ''],
            ['Goodbye Moon', 'Goodbye Moon', ''],
            ['The Bystander', 'The Bystander', ''],
            ['纸船夜航.[秋舟]', '纸船夜航', '秋舟'],
            ['《纸船夜航》.[秋舟]', '纸船夜航', '秋舟'],
            ['《纸船夜航》 作者：秋舟', '纸船夜航', '秋舟'],
        ]) {
            const parsed = TextProcessorCore.getBookNameAndAuthor(filename);
            assert.equal(parsed.bookName, title, filename); assert.equal(parsed.author, author, filename);
        }
    });
}
