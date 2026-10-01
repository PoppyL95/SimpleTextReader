import { ReaderError } from './errors.js';

// Additive migration: existing phase-one books and progress remain untouched.
export const ANNOTATION_SCHEMA = `
    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('highlight','comment')),
        parentId INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        line INTEGER NOT NULL,
        startLine INTEGER, startOffset INTEGER, endLine INTEGER, endOffset INTEGER, quote TEXT,
        text TEXT NOT NULL DEFAULT '', author TEXT NOT NULL CHECK(author IN ('reader','hals')),
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, readAt TEXT
    );
    CREATE INDEX IF NOT EXISTS notes_book ON notes(bookId, createdAt, id);
    CREATE INDEX IF NOT EXISTS notes_parent ON notes(parentId);
    CREATE TABLE IF NOT EXISTS handoff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookId TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        type TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL, acknowledgedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS handoff_unread ON handoff(acknowledgedAt, id);
`;

function object(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ReaderError(400, 'Expected a JSON object');
}
function integer(value, label = 'id', minimum = 1) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < minimum) throw new ReaderError(400, `Invalid ${label}`);
    return number;
}
function noteText(value, required = true) {
    if (typeof value !== 'string' || value.length > 10000 || (required && !value.trim())) {
        throw new ReaderError(400, 'Note text must contain 1–10000 characters');
    }
    return value;
}

export class AnnotationStore {
    async selection(bookId, data) {
        object(data);
        const lines = (await this.text(bookId)).split('\n');
        const { startLine, startOffset, endLine, endOffset, quote } = data;
        if (![startLine, startOffset, endLine, endOffset].every(Number.isSafeInteger) ||
            startLine < 1 || endLine < startLine || endLine > lines.length ||
            startOffset < 0 || endOffset < 0 || startOffset > lines[startLine - 1].length ||
            endOffset > lines[endLine - 1].length || (startLine === endLine && endOffset <= startOffset)) {
            throw new ReaderError(400, 'Invalid original selection coordinates');
        }
        const selected = lines.slice(startLine - 1, endLine);
        selected[selected.length - 1] = selected.at(-1).slice(0, endOffset);
        selected[0] = selected[0].slice(startOffset);
        const original = selected.join('\n');
        if (typeof quote !== 'string' || !quote || quote.length > 20000 || quote !== original) {
            throw new ReaderError(400, 'Quote must match the original selection (maximum 20000 characters)');
        }
        return { startLine, startOffset, endLine, endOffset, quote };
    }
    async notes(bookId) {
        await this.book(bookId);
        return (await this.db.execute({ sql: 'SELECT * FROM notes WHERE bookId=? ORDER BY createdAt, id', args: [bookId] })).rows;
    }
    async note(bookId, noteId) {
        await this.book(bookId);
        const result = await this.db.execute({ sql: 'SELECT * FROM notes WHERE bookId=? AND id=?',
            args: [bookId, integer(noteId)] });
        if (!result.rows[0]) throw new ReaderError(404, 'Note not found in this book');
        return result.rows[0];
    }
    async createNote(bookId, data, identity) {
        object(data);
        const book = await this.book(bookId);
        const kind = data.kind ?? 'comment';
        if (!['highlight', 'comment'].includes(kind)) throw new ReaderError(400, 'Invalid note kind');
        let anchor = {}, parentId = null, line;
        if (kind === 'highlight') {
            if (data.parentId != null) throw new ReaderError(400, 'Highlights cannot be replies');
            anchor = await this.selection(bookId, data); line = anchor.startLine;
        } else if (data.parentId != null) {
            const parent = await this.note(bookId, data.parentId);
            // Replies to replies stay in the same chronological, flat thread.
            parentId = parent.parentId ?? parent.id; line = parent.line;
            if (data.line != null && data.line !== line) throw new ReaderError(400, 'Reply line must match its anchor');
        } else {
            line = integer(data.line, 'original line');
            if (line > book.totalLines) throw new ReaderError(400, 'Line outside original text');
        }
        const now = new Date().toISOString();
        const result = await this.db.execute({ sql: `INSERT INTO notes
            (bookId,kind,parentId,line,startLine,startOffset,endLine,endOffset,quote,text,author,createdAt,updatedAt,readAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`, args: [bookId, kind, parentId, line,
            anchor.startLine ?? null, anchor.startOffset ?? null, anchor.endLine ?? null, anchor.endOffset ?? null,
            anchor.quote ?? null, noteText(data.text ?? (kind === 'highlight' ? '' : undefined), kind === 'comment'),
            identity.author, now, now, identity.author === 'reader' ? now : null] });
        return result.rows[0];
    }
    async editNote(bookId, noteId, data, identity) {
        object(data);
        const note = await this.note(bookId, noteId);
        if (note.author !== identity.author) throw new ReaderError(403, 'Only the author can edit this note');
        if (['kind', 'parentId', 'line'].some(key => key in data && data[key] !== note[key])) {
            throw new ReaderError(400, 'Comment thread anchors cannot be changed');
        }
        let anchor = note;
        const coordinateKeys = ['startLine', 'startOffset', 'endLine', 'endOffset', 'quote'];
        if (coordinateKeys.some(key => key in data)) {
            if (note.kind !== 'highlight') throw new ReaderError(400, 'Only highlights have a selection');
            anchor = await this.selection(bookId, { ...note, ...data });
            if (anchor.startLine !== note.line && (await this.db.execute({ sql: 'SELECT id FROM notes WHERE parentId=? LIMIT 1', args: [note.id] })).rows.length) {
                throw new ReaderError(400, 'A highlight with replies must remain on its original line');
            }
        }
        const text = 'text' in data ? noteText(data.text, note.kind === 'comment') : note.text;
        const now = new Date(Math.max(Date.now(), Date.parse(note.updatedAt) + 1)).toISOString();
        await this.db.execute({ sql: `UPDATE notes SET line=?,startLine=?,startOffset=?,endLine=?,endOffset=?,quote=?,
            text=?,updatedAt=?,readAt=? WHERE id=?`, args: [anchor.startLine ?? note.line, anchor.startLine,
            anchor.startOffset, anchor.endLine, anchor.endOffset, anchor.quote, text, now,
            note.author === 'hals' ? null : now, note.id] });
        return this.note(bookId, note.id);
    }
    async deleteNote(bookId, noteId, identity) {
        const note = await this.note(bookId, noteId);
        if (note.author !== identity.author) throw new ReaderError(403, 'Only the author can delete this note');
        await this.db.execute({ sql: 'DELETE FROM notes WHERE id=?', args: [note.id] });
    }
    async markNotes(bookId, data, identity) {
        object(data);
        if (identity.author !== 'reader') throw new ReaderError(403, 'Read state belongs to the reader');
        if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 500 ||
            (data.read != null && typeof data.read !== 'boolean')) throw new ReaderError(400, 'Invalid read request');
        const ids = [...new Set(data.ids.map(id => integer(id)))];
        await this.book(bookId);
        const marks = ids.map(() => '?').join(',');
        const found = await this.db.execute({ sql: `SELECT id,updatedAt FROM notes WHERE bookId=? AND id IN (${marks})`, args: [bookId, ...ids] });
        if (found.rows.length !== ids.length) throw new ReaderError(404, 'Note not found in this book');
        if (data.versions != null) {
            object(data.versions);
            if (found.rows.some(note => typeof data.versions[note.id] !== 'string')) throw new ReaderError(400, 'Missing note version');
            if (found.rows.some(note => data.versions[note.id] !== note.updatedAt)) throw new ReaderError(409, 'Notes changed; open the thread again');
        }
        const readAt = data.read === false ? null : new Date().toISOString();
        await this.db.execute({ sql: `UPDATE notes SET readAt=? WHERE bookId=? AND id IN (${marks})`, args: [readAt, bookId, ...ids] });
        return { ids, readAt };
    }
    async sendSelection(bookId, data, identity) {
        if (identity.author !== 'reader') throw new ReaderError(403, 'Only the reader can send a selection');
        const book = await this.book(bookId);
        const selection = await this.selection(bookId, data);
        if (data.chapter != null && (typeof data.chapter !== 'string' || data.chapter.length > 1000)) throw new ReaderError(400, 'Invalid chapter');
        // The action creates a server-defined queue item; callers cannot supply type, author or payload.
        const payload = { bookId, title: book.title, author: book.author, chapter: data.chapter || '', ...selection };
        const result = await this.db.execute({ sql: `INSERT INTO handoff (bookId,type,payload,createdAt)
            VALUES (?,'selection',?,?) RETURNING *`, args: [bookId, JSON.stringify(payload), new Date().toISOString()] });
        return this.describeHandoff(result.rows[0]);
    }
    describeHandoff(row) { return { ...row, payload: JSON.parse(row.payload) }; }
    async handoffs(query) {
        const cursor = query.cursor == null ? 0 : integer(query.cursor, 'cursor', 0);
        const limit = query.limit == null ? 50 : integer(query.limit, 'limit');
        if (limit > 200 || (query.unread != null && !['0', '1'].includes(query.unread))) throw new ReaderError(400, 'Invalid queue query');
        const result = await this.db.execute({ sql: `SELECT * FROM handoff WHERE id>? ${query.unread === '1' ? 'AND acknowledgedAt IS NULL' : ''}
            ORDER BY id ASC LIMIT ?`, args: [cursor, limit + 1] });
        const items = result.rows.slice(0, limit).map(row => this.describeHandoff(row));
        return { items, nextCursor: result.rows.length > limit ? items.at(-1).id : null };
    }
    async ackHandoff(handoffId) {
        const id = integer(handoffId);
        const result = await this.db.execute({ sql: `UPDATE handoff SET acknowledgedAt=COALESCE(acknowledgedAt,?) WHERE id=? RETURNING *`,
            args: [new Date().toISOString(), id] });
        if (!result.rows[0]) throw new ReaderError(404, 'Handoff not found');
        return this.describeHandoff(result.rows[0]);
    }
}
