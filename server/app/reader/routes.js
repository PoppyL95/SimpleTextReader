import express from 'express';
import { ReaderError } from './store.js';
import { authenticate } from './auth.js';
import { MAX_BOOK_BYTES } from './settings.js';

export function readerRouter(store) {
    const router = express.Router();
    router.use(authenticate);
    const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
    router.get('/', route(async (req, res) => res.json({ status: 'ok', readerSync: true,
        csrfToken: req.session?.csrf, services: { library: { status: 'ok', directoryExists: true } } })));
    router.get('/books', route(async (_req, res) => res.json(await store.list())));
    router.post('/books', express.raw({ type: ['text/plain', 'application/octet-stream'], limit: MAX_BOOK_BYTES }), route(async (req, res) => {
        if (!Buffer.isBuffer(req.body)) throw new ReaderError(415, 'Upload a text/plain or application/octet-stream body');
        res.status(201).json(await store.upload(req.body, req.query.filename, req.query.encoding));
    }));
    router.get('/books/:id', route(async (req, res) => res.json({ ...await store.book(req.params.id), progress: await store.progress(req.params.id) })));
    router.patch('/books/:id', route(async (req, res) => res.json(await store.metadata(req.params.id, req.body))));
    router.delete('/books/:id', route(async (req, res) => { await store.remove(req.params.id); res.sendStatus(204); }));
    router.get('/books/:id/download', route(async (req, res) => {
        const book = await store.book(req.params.id);
        res.set('Content-Disposition', `attachment; filename="book.txt"; filename*=UTF-8''${encodeURIComponent(book.filename)}`);
        res.type('text/plain').send(await store.text(req.params.id));
    }));
    router.get('/books/:id/text', route(async (req, res) => {
        const text = await store.text(req.params.id); const lines = text.split('\n');
        const from = Number(req.query.from ?? 1); const to = Number(req.query.to ?? Math.min(lines.length, from + 199));
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > lines.length || to - from > 2000) {
            throw new ReaderError(400, 'Invalid original line range (maximum 2001 lines)');
        }
        res.json({ from, to, text: lines.slice(from - 1, to).join('\n') });
    }));
    router.get('/books/:id/progress', route(async (req, res) => res.json(await store.progress(req.params.id))));
    const save = route(async (req, res) => res.json(await store.saveProgress(req.params.id, req.body)));
    router.put('/books/:id/progress', save);
    router.post('/books/:id/progress', save); // sendBeacon uses POST.
    router.get('/books/:id/notes', route(async (req, res) => res.json(await store.notes(req.params.id))));
    router.post('/books/:id/notes', route(async (req, res) => res.status(201).json(await store.createNote(req.params.id, req.body, req.readerIdentity))));
    router.patch('/books/:id/notes/:noteId', route(async (req, res) => res.json(await store.editNote(req.params.id, req.params.noteId, req.body, req.readerIdentity))));
    router.delete('/books/:id/notes/:noteId', route(async (req, res) => {
        await store.deleteNote(req.params.id, req.params.noteId, req.readerIdentity); res.sendStatus(204);
    }));
    router.post('/books/:id/notes/read', route(async (req, res) => res.json(await store.markNotes(req.params.id, req.body, req.readerIdentity))));
    router.post('/books/:id/notes/:noteId/read', route(async (req, res) => res.json(await store.markNotes(req.params.id,
        { ids: [req.params.noteId], read: req.body?.read }, req.readerIdentity))));
    router.post('/books/:id/handoff', route(async (req, res) => res.status(201).json(await store.sendSelection(req.params.id, req.body, req.readerIdentity))));
    router.get('/handoff', route(async (req, res) => res.json(await store.handoffs(req.query))));
    router.post('/handoff/:id/ack', route(async (req, res) => res.json(await store.ackHandoff(req.params.id))));
    router.use((_req, res) => res.status(404).json({ error: 'API not found' }));
    router.use((error, _req, res, _next) => {
        const status = error.status || 500;
        if (status >= 500) console.error('Reader operation failed:', error.code || error.name);
        res.status(status).json({ error: status >= 500 ? 'Reader operation failed' : error.message,
            ...(error.progress ? { progress: error.progress } : {}) });
    });
    return router;
}
