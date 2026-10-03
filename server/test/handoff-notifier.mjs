import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { HandoffNotifier } from '../app/reader/handoff-notifier.js';
import { ReaderStore } from '../app/reader/store.js';
function setup(overrides = {}) {
    const timers = [], calls = [], logs = [];
    const notifier = new HandoffNotifier({ url: 'http://notify.example/hook',
        schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
        cancel: timer => { timer.cancelled = true; },
        fetch: async (url, options) => { calls.push({ url, ...options }); return { ok: true }; },
        log: message => logs.push(message), ...overrides });
    return { notifier, timers, calls, logs };
}
const metadata = { type: 'selection', bookId: 'book-one', title: '虚构书' };
const settle = () => new Promise(resolve => setImmediate(resolve));
test('unconfigured notification does no scheduling or network work', () => {
    const { notifier, timers, calls } = setup({ url: '' }); notifier.enqueue(metadata);
    assert.equal(timers.length, 0); assert.equal(calls.length, 0);
});
test('fixed ten-second window batches by book and posts only metadata', async () => {
    const { notifier, timers, calls } = setup();
    notifier.enqueue({ ...metadata, quote: '不得发出的原文' }); notifier.enqueue(metadata); notifier.enqueue(metadata);
    notifier.enqueue({ ...metadata, bookId: 'book-two' });
    assert.equal(timers.length, 2); assert(timers.every(timer => timer.delay === 10000));
    timers[0].callback(); timers[1].callback(); await settle();
    assert.deepEqual(JSON.parse(calls[0].body), { ...metadata, count: 3 });
    assert.equal(JSON.parse(calls[1].body).count, 1); assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    notifier.enqueue(metadata); assert.equal(timers.length, 3);
    timers[2].callback(); await settle(); assert.equal(JSON.parse(calls[2].body).count, 1);
});
test('HTTP failure, network failure and invalid URL only log', async () => {
    for (const fetch of [async () => ({ ok: false, status: 500 }), async () => { throw new Error('secret URL'); }]) {
        const { notifier, logs } = setup({ fetch }); await notifier.send({ ...metadata, count: 1 });
        assert.equal(logs.length, 1); assert(!logs[0].includes('secret'));
    }
    const { notifier, logs } = setup({ url: 'file:///secret' }); await notifier.send(metadata); assert.equal(logs.length, 1);
});
test('request aborts at three seconds', async () => {
    const { notifier, logs } = setup({ fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const keepAlive = setTimeout(() => {}, 4000), start = Date.now();
    try { await notifier.send(metadata); assert(Date.now() - start >= 2900 && Date.now() - start < 3900); assert.match(logs[0], /TimeoutError/); }
    finally { clearTimeout(keepAlive); }
});
test('closing cancels pending batches', () => {
    const { notifier, timers } = setup(); notifier.enqueue(metadata); notifier.close();
    assert(timers[0].cancelled); assert.equal(notifier.pending.size, 0);
});
test('real HTTP receiver gets one metadata-only JSON POST', async () => {
    let receive;
    const received = new Promise(resolve => { receive = resolve; });
    const server = createServer((request, response) => {
        let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
        request.on('end', () => { response.writeHead(204).end(); receive({ method: request.method,
            contentType: request.headers['content-type'], body: JSON.parse(body) }); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const callbacks = [], notifier = new HandoffNotifier({ url: `http://127.0.0.1:${server.address().port}/hook`,
        schedule: callback => { callbacks.push(callback); }, cancel: () => {} });
    try {
        notifier.enqueue({ ...metadata, quote: '私有原文' }); notifier.enqueue(metadata); callbacks[0]();
        const request = await received;
        assert.equal(request.method, 'POST'); assert.equal(request.contentType, 'application/json');
        assert.deepEqual(request.body, { ...metadata, count: 2 });
    } finally { notifier.close(); await new Promise(resolve => server.close(resolve)); }
});
test('enqueue persists before notification; invalid selections create no notification', async () => {
    const directory = await mkdtemp('/tmp/hals-notify-'), store = new ReaderStore(directory);
    const harness = setup({ fetch: async () => { throw new Error('offline'); } }); store.handoffNotifier = harness.notifier;
    try {
        await store.init(); const book = await store.upload(Buffer.from('第一章\n虚构原文'), '虚构书.txt');
        const selection = { startLine: 2, endLine: 2, startOffset: 0, endOffset: 4, quote: '虚构原文' };
        await assert.rejects(store.sendSelection(book.id, { ...selection, quote: '不匹配' }, { author: 'reader' }));
        assert.equal(harness.timers.length, 0);
        const item = await store.sendSelection(book.id, selection, { author: 'reader' });
        assert.equal(item.type, 'selection'); assert.equal((await store.handoffs({})).items.length, 1);
        harness.timers[0].callback(); await settle(); assert.equal(harness.logs.length, 1);
        assert.equal((await store.handoffs({})).items.length, 1);
        await store.db.executeMultiple((await import('../app/reader/annotations.js')).ANNOTATION_SCHEMA);
        assert.equal((await store.handoffs({})).items.length, 1, 'migration remains repeatable');
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
