import { createClient } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import jschardet from 'jschardet';
import { TextProcessorCore } from '../../../shared/core/text/text-processor-core.js';
import { DATA_DIR } from './settings.js';
import { ANNOTATION_SCHEMA } from './annotations.js';
import { ReviewStore, REVIEW_SCHEMA } from './reviews.js';
import { ReaderError } from './errors.js';

export { ReaderError } from './errors.js';

// Decode before hashing. Newlines and blank lines remain part of the original text.
export function decodeBook(bytes, encoding) {
    if (!bytes.length) throw new ReaderError(400, 'Empty book');
    if (!encoding) {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* legacy encoding */ }
        encoding = jschardet.detect(bytes).encoding;
    }
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new ReaderError(400, 'Unsupported encoding; upload UTF-8 or specify encoding'); }
}

export class ReaderStore extends ReviewStore {
    constructor(directory = DATA_DIR) {
        super();
        this.directory = directory;
        this.lengths = new Map();
        this.mutations = Promise.resolve();
        // Serialize mutations including original-file changes, not only SQL writes.
        for (const method of ['upload', 'metadata', 'remove', 'saveProgress', 'createNote', 'editNote',
            'deleteNote', 'markNotes', 'sendSelection', 'ackHandoff', 'saveReading', 'createArchive', 'updateArchive',
            'deleteArchive', 'linkArchives', 'requestDraft', 'saveDraft', 'previewImport', 'commitImport']) {
            const operation = this[method].bind(this);
            this[method] = (...args) => {
                const result = this.mutations.then(() => operation(...args));
                this.mutations = result.catch(() => {});
                return result;
            };
        }
    }
    async init() {
        await mkdir(path.join(this.directory, 'books'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(this.directory, 'cache'), { recursive: true, mode: 0o700 });
        this.db = createClient({ url: pathToFileURL(path.join(this.directory, 'reader.db')).href });
        await this.db.execute('PRAGMA foreign_keys = ON');
        await this.db.execute('PRAGMA journal_mode = DELETE');
        await this.db.execute('PRAGMA synchronous = FULL');
        await this.db.executeMultiple(`
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, title TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL, totalLines INTEGER NOT NULL,
                createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS progress (
                bookId TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
                line INTEGER NOT NULL, offset INTEGER NOT NULL, chapter TEXT NOT NULL DEFAULT '',
                clientUpdatedAt INTEGER NOT NULL, deviceId TEXT NOT NULL,
                serverUpdatedAt TEXT NOT NULL
            );
        `);
        await this.db.executeMultiple(ANNOTATION_SCHEMA);
        await this.db.executeMultiple(REVIEW_SCHEMA);
        await this.ensureUniqueArchives();
        return this;
    }
    async list() {
        const result = await this.db.execute(`SELECT b.*, p.line, p.offset, p.chapter, p.clientUpdatedAt,
            p.deviceId, p.serverUpdatedAt FROM books b LEFT JOIN progress p ON p.bookId=b.id
            ORDER BY b.createdAt, b.id`);
        return result.rows.map(row => this.describe(row));
    }
    describe(row) {
        return { ...row, progress: { line: row.line ?? 1, offset: row.offset ?? 0,
            chapter: row.chapter ?? '', clientUpdatedAt: row.clientUpdatedAt ?? 0,
            deviceId: row.deviceId ?? '', serverUpdatedAt: row.serverUpdatedAt ?? null,
            percentage: row.totalLines <= 1 ? 0 : Math.min(100, 100 * ((row.line ?? 1) - 1) / (row.totalLines - 1)) } };
    }
    async book(id) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new ReaderError(404, 'Book not found');
        const result = await this.db.execute({ sql: 'SELECT * FROM books WHERE id=?', args: [id] });
        if (!result.rows[0]) throw new ReaderError(404, 'Book not found');
        return result.rows[0];
    }
    async text(id) {
        await this.book(id);
        try { return await readFile(path.join(this.directory, 'books', `${id}.txt`), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') throw new ReaderError(404, 'Original file unavailable'); throw error; }
    }
    async lineLengths(id) {
        if (!this.lengths.has(id)) {
            this.lengths.set(id, Uint32Array.from((await this.text(id)).split('\n'), line => line.length));
            if (this.lengths.size > 8) this.lengths.delete(this.lengths.keys().next().value);
        }
        return this.lengths.get(id);
    }
    async upload(bytes, filename, encoding) {
        if (typeof filename !== 'string' || !filename.trim() || filename.length > 255 || /[\x00-\x1f<>"\\/]/.test(filename)) {
            throw new ReaderError(400, 'Invalid filename');
        }
        const text = decodeBook(bytes, encoding);
        const id = createHash('sha256').update(text, 'utf8').digest('hex');
        const metadata = TextProcessorCore.getBookNameAndAuthor(filename.replace(/\.txt$/i, ''));
        const now = new Date().toISOString();
        const target = path.join(this.directory, 'books', `${id}.txt`);
        const temporary = `${target}.${randomUUID()}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, target);
        const directory = await open(path.join(this.directory, 'books'), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        await this.db.execute({ sql: `INSERT INTO books VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            filename=excluded.filename, title=excluded.title, author=excluded.author, updatedAt=excluded.updatedAt`,
            args: [id, filename, metadata.bookName || filename, metadata.author || '', Buffer.byteLength(text), text.split('\n').length, now, now] });
        await this.ensureStats(id, text);
        return { ...await this.book(id), progress: await this.progress(id) };
    }
    async metadata(id, changes) {
        const book = await this.book(id);
        if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ReaderError(400, 'Invalid metadata');
        for (const key of ['filename', 'title', 'author']) {
            if (key in changes && (typeof changes[key] !== 'string' || changes[key].length > 255 || /[\x00-\x1f<>]/.test(changes[key]))) {
                throw new ReaderError(400, `Invalid ${key}`);
            }
        }
        const filename = changes.filename ?? book.filename;
        if (!filename.trim() || /["\\/]/.test(filename)) throw new ReaderError(400, 'Invalid filename');
        await this.db.execute({ sql: 'UPDATE books SET filename=?, title=?, author=?, updatedAt=? WHERE id=?',
            args: [filename, changes.title ?? book.title, changes.author ?? book.author, new Date().toISOString(), id] });
        return { ...await this.book(id), progress: await this.progress(id) };
    }
    async remove(id) {
        await this.book(id);
        this.lengths.delete(id);
        await this.db.execute({ sql: 'DELETE FROM books WHERE id=?', args: [id] });
        await unlink(path.join(this.directory, 'books', `${id}.txt`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    async progress(id) {
        const book = await this.book(id);
        const result = await this.db.execute({ sql: 'SELECT * FROM progress WHERE bookId=?', args: [id] });
        return this.describe({ ...book, ...result.rows[0] }).progress;
    }
    async saveProgress(id, data) {
        const book = await this.book(id);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ReaderError(400, 'Invalid progress');
        const { line, offset, clientUpdatedAt, deviceId } = data;
        if (!Number.isSafeInteger(line) || line < 1 || line > book.totalLines || !Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(clientUpdatedAt) || clientUpdatedAt < 1 || clientUpdatedAt > Date.now() + 300000 ||
            typeof deviceId !== 'string' || !deviceId || deviceId.length > 128 ||
            (data.chapter != null && (typeof data.chapter !== 'string' || data.chapter.length > 1000))) {
            throw new ReaderError(400, 'Invalid progress');
        }
        const lengths = await this.lineLengths(id);
        if (offset > lengths[line - 1]) throw new ReaderError(400, 'Offset outside original line');
        const result = await this.db.execute({ sql: `INSERT INTO progress VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(bookId) DO UPDATE SET line=excluded.line, offset=excluded.offset, chapter=excluded.chapter,
            clientUpdatedAt=excluded.clientUpdatedAt, deviceId=excluded.deviceId, serverUpdatedAt=excluded.serverUpdatedAt
            WHERE excluded.clientUpdatedAt > progress.clientUpdatedAt`,
            args: [id, line, offset, data.chapter || '', clientUpdatedAt, deviceId, new Date().toISOString()] });
        const current = await this.progress(id);
        // An identical retry (including sendBeacon) is successful without changing the record.
        if (!result.rowsAffected && !(current.clientUpdatedAt === clientUpdatedAt && current.deviceId === deviceId &&
            current.line === line && current.offset === offset && current.chapter === (data.chapter || ''))) {
            const error = new ReaderError(409, 'A newer reading action is already saved');
            error.progress = current; throw error;
        }
        return current;
    }
    close() { this.db?.close(); }
}
