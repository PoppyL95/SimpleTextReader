import * as CONFIG from '../../config/index.js';
import { createLineMap } from '../../../../shared/core/reader/coordinates.js';
import { TextProcessorCore } from '../../../../shared/core/text/text-processor-core.js';
import { readerApi, storagePrefix, cacheKey, catalogBook, catalogEntries, rememberBook, forgetBook } from './reader-catalog.js';

function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(storagePrefix + key)) ?? fallback; } catch { return fallback; }
}

class ReaderSync {
    constructor() {
        this.pending = load('pending', {});
        this.deviceId = load('device', null) || crypto.randomUUID();
        localStorage.setItem(storagePrefix + 'device', JSON.stringify(this.deviceId));
        this.active = load('selfHosted', false);
        this.online = false;
        this.suppressed = true;
        this.maps = new Map();
        this.prepared = new WeakSet();
        this.lastInteraction = 0;
    }
    status(message) {
        if (!this.active) return;
        let element = document.getElementById('reader-sync-status');
        if (!element) {
            element = document.createElement('div');
            element.id = 'reader-sync-status'; element.role = 'status'; element.setAttribute('aria-live', 'polite');
            document.body.append(element);
        }
        element.textContent = message;
        element.hidden = !message;
    }
    persist() {
        localStorage.setItem(storagePrefix + 'pending', JSON.stringify(this.pending));
        this.status(Object.keys(this.pending).length || catalogEntries().some(book => book.pendingUpload) ? '尚未同步' :
            this.conflict ? '另一个设备保存了更新的进度，重新打开书籍可恢复' : '');
    }
    async request(endpoint, options = {}) {
        const response = await fetch(readerApi + endpoint, { credentials: 'same-origin', ...options,
            headers: { Accept: 'application/json', ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}), ...options.headers } });
        if (!response.ok) {
            const error = new Error(`Reader API: ${response.status}`); error.status = response.status;
            try { error.data = await response.json(); } catch { /* non-JSON response */ }
            throw error;
        }
        return response;
    }
    async connect() {
        if (this.connection) return this.connection;
        this.connection = (async () => {
            try {
                const health = await (await this.request('')).json();
                if (!health.readerSync) return false;
                this.active = true; this.online = true; this.csrf = health.csrfToken;
                localStorage.setItem(storagePrefix + 'selfHosted', 'true');
                return true;
            } catch { this.online = false; this.status(this.active ? '尚未同步：服务器连接失败' : ''); return false; }
            finally { this.connection = null; }
        })();
        return this.connection;
    }
    async fetchFile(name, loadContent = true) {
        const book = catalogBook(name);
        if (!book) throw new Error('Book not found');
        if (!loadContent) return { name, size: book.size, type: 'text/plain', isEastern: /[\u3400-\u9fff]/.test(book.title), encoding: 'utf-8' };
        const text = await (await this.request(`/books/${book.id}/download`)).text();
        const file = new File([text], cacheKey(book.id), { type: 'text/plain' });
        this.prepared.add(file);
        return file;
    }
    async normalize(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch {
            const { encoding } = await TextProcessorCore.getLanguageAndEncodingFromBook(file);
            text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        }
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        const id = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return { id, text };
    }
    async prepareFile(file) {
        if (!this.active && !(await this.connect())) return file;
        // Previously cached legacy books stay local until the reader chooses migration.
        if (file['STR-Cache-File'] && !catalogBook(file.name)) return file;
        const existing = catalogBook(file.name);
        if (existing && (this.prepared.has(file) || file['STR-Cache-File'])) return file;
        const { id, text } = await this.normalize(file);
        const metadata = TextProcessorCore.getBookNameAndAuthor(file.name.replace(/\.txt$/i, ''));
        let book = { id, filename: file.name, title: metadata.bookName, author: metadata.author,
            size: new TextEncoder().encode(text).length, totalLines: text.split('\n').length, pendingUpload: true };
        try {
            book = await (await this.request(`/books?filename=${encodeURIComponent(file.name)}`, {
                method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text })).json();
            this.online = true;
        } catch { this.online = false; }
        rememberBook(book); this.persist();
        const prepared = new File([text], cacheKey(id), { type: 'text/plain' });
        this.prepared.add(prepared);
        return prepared;
    }
    async beginOpening(file) {
        document.dispatchEvent(new Event('reader:book-opening'));
        await this.prepareFile(file);
        let book = catalogBook(file.name);
        if (!book || !this.active) { this.current = null; return; }
        this.suppressed = true;
        this.current = book.id;
        this.conflict = false;
        const text = await file.text();
        let progress = book.progress || { line: 1, offset: 0, clientUpdatedAt: 0 };
        try {
            book = await (await this.request(`/books/${book.id}`)).json();
            progress = book.progress;
            rememberBook(book); this.online = true;
        } catch { this.online = false; }
        const map = createLineMap(text, book.author ? 3 : 2);
        this.maps.set(book.id, map);
        const pending = this.pending[book.id];
        if (pending && pending.clientUpdatedAt > progress.clientUpdatedAt) progress = pending;
        this.restoring = progress;
        this.lastKnownTimestamp = progress.clientUpdatedAt;
        localStorage.setItem(file.name, map.toRendered(progress.line));
        this.status(this.online ? '' : '尚未同步：使用本地缓存');
    }
    async finishOpening(reader) {
        if (!this.current || !this.active) return;
        // Upstream schedules several rendering frames; keep initialization writes suppressed through them.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const map = this.maps.get(this.current);
        if (this.restoring && map) {
            await reader.gotoLine(map.toRendered(this.restoring.line), false);
            if (this.restoring.offset) this.scrollToOffset(map.toRendered(this.restoring.line), this.restoring.offset, map.raw[this.restoring.line - 1]);
        }
        this.lastInteraction = 0;
        this.suppressed = false;
        this.restoring = null;
        this.persist();
        document.dispatchEvent(new Event('reader:book-opened'));
    }
    scrollToOffset(renderLine, offset, raw) {
        const element = document.getElementById(`line${renderLine}`);
        if (!element) return;
        const displayed = element.textContent;
        const start = raw.indexOf(displayed);
        let remaining = Math.max(0, offset - Math.max(0, start));
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (remaining > node.length) { remaining -= node.length; continue; }
            const range = document.createRange(); range.setStart(node, remaining); range.collapse(true);
            const rect = range.getBoundingClientRect();
            window.scrollBy(0, rect.top - 8); break;
        }
    }
    viewportOffset(renderLine, raw) {
        const element = document.getElementById(`line${renderLine}`);
        if (!element || element.getBoundingClientRect().top >= 0) return 0;
        const rect = element.getBoundingClientRect();
        const caret = document.caretRangeFromPoint?.(Math.max(rect.left + 5, 5), 8);
        if (!caret || !element.contains(caret.startContainer)) return 0;
        const range = document.createRange(); range.selectNodeContents(element); range.setEnd(caret.startContainer, caret.startOffset);
        const start = raw.indexOf(element.textContent);
        return Math.min(raw.length, Math.max(0, start) + range.toString().length);
    }
    captureProgress(name, renderLine) {
        const book = catalogBook(name);
        if (!CONFIG.VARS.IS_BOOK_OPENED || !book || book.id !== this.current || this.suppressed || !this.lastInteraction ||
            Date.now() - this.lastInteraction > 120000 || !Number.isInteger(renderLine)) return;
        const map = this.maps.get(book.id); if (!map) return;
        this.conflict = false;
        const line = map.toOriginal(renderLine);
        const offset = this.viewportOffset(renderLine, map.raw[line - 1]);
        const previous = this.pending[book.id] || book.progress;
        if (previous?.line === line && previous?.offset === offset) return;
        const title = [...CONFIG.VARS.ALL_TITLES].reverse().find(item => item[1] <= renderLine)?.[0] || '';
        this.pending[book.id] = { line, offset, chapter: title,
            clientUpdatedAt: Math.max(Date.now(), (this.lastKnownTimestamp || 0) + 1), deviceId: this.deviceId };
        this.lastKnownTimestamp = this.pending[book.id].clientUpdatedAt;
        this.persist();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 2000);
    }
    async flush() {
        if (!this.active || this.flushing) return;
        this.flushing = true;
        try {
            if (!this.online && !(await this.connect())) return;
            for (const [id, progress] of Object.entries(this.pending)) {
                try {
                    const saved = await (await this.request(`/books/${id}/progress`, { method: 'PUT',
                        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(progress) })).json();
                    if (this.pending[id] === progress) delete this.pending[id];
                    const book = catalogBook(cacheKey(id)); if (book) rememberBook({ ...book, progress: saved });
                } catch (error) {
                    if (error.status === 409 && this.pending[id] === progress) {
                        delete this.pending[id];
                        const book = catalogBook(cacheKey(id)); if (book) rememberBook({ ...book, progress: error.data.progress });
                        this.conflict = true;
                    } else { this.online = false; break; }
                }
            }
        } finally { this.flushing = false; this.persist(); }
    }
    beacon() {
        if (!this.active) return;
        clearTimeout(this.timer);
        // Keep pending until an acknowledged retry. A queued beacon is not proof of persistence.
        for (const [id, progress] of Object.entries(this.pending)) {
            navigator.sendBeacon(`${readerApi}/books/${id}/progress`, new Blob([JSON.stringify(progress)], { type: 'application/json' }));
        }
    }
    async deleteBook(name) {
        const book = catalogBook(name); if (!book) return;
        await this.request(`/books/${book.id}`, { method: 'DELETE' });
        forgetBook(book.id); delete this.pending[book.id]; this.persist();
        delete CONFIG.VARS.ALL_BOOKS_INFO[name];
    }
    async retryUploads() {
        if (!this.bookshelf?.db || !this.online) return;
        for (const book of catalogEntries().filter(book => book.pendingUpload)) {
            const cached = await this.bookshelf.db.getBook(cacheKey(book.id));
            if (!(cached?.data instanceof Blob)) continue;
            try {
                const saved = await (await this.request(`/books?filename=${encodeURIComponent(book.filename)}`, {
                    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: cached.data })).json();
                rememberBook(saved);
            } catch { this.online = false; break; }
        }
        this.persist();
    }
    async migrate() {
        const local = (await this.bookshelf.db.getAllBooks()).filter(book => !catalogBook(book.name) && book.data instanceof Blob);
        for (const item of local) {
            const oldLine = Number(localStorage.getItem(item.name) || 0);
            const file = await this.prepareFile(new File([item.data], item.name, { type: 'text/plain' }));
            const book = catalogBook(file.name);
            if (!book || book.pendingUpload) throw new Error('尚未同步：迁移未完成，请稍后重试');
            const map = createLineMap(await file.text(), (TextProcessorCore.getBookNameAndAuthor(item.name.replace(/\.txt$/i, '')).author ? 3 : 2));
            // Existing server progress wins over historical local migration; do not timestamp it as a new reading action.
            if (!book.progress?.clientUpdatedAt && oldLine > 0) {
                const saved = await (await this.request(`/books/${book.id}/progress`, { method: 'PUT',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: map.toOriginal(oldLine),
                        offset: 0, clientUpdatedAt: 1, deviceId: this.deviceId }) })).json();
                rememberBook({ ...book, progress: saved });
            }
            await this.bookshelf.db.putBook(file.name, file, false, true);
            await this.bookshelf.db.removeBook(item.name);
            if (CONFIG.VARS.FILENAME === item.name) await this.bookshelf.openBook(file.name);
            if (localStorage.getItem('STR-Filename') === item.name) localStorage.setItem('STR-Filename', file.name);
        }
        await this.refreshCatalog();
        await this.bookshelf.refreshBookList(true, true);
    }
    async refreshCatalog() {
        const books = await (await this.request('/books')).json();
        const ids = new Set(books.map(book => book.id));
        for (const known of catalogEntries()) {
            if (!known.pendingUpload && !ids.has(known.id)) {
                await this.bookshelf?.db?.removeBook(cacheKey(known.id));
                delete CONFIG.VARS.ALL_BOOKS_INFO[cacheKey(known.id)];
                forgetBook(known.id); delete this.pending[known.id];
            }
        }
        for (const book of books) {
            rememberBook(book);
            const name = cacheKey(book.id);
            CONFIG.VARS.ALL_BOOKS_INFO[name] = { name, type: 'text/plain', size: book.size, isOnServer: true,
                isFromLocal: false, isEastern: /[\u3400-\u9fff]/.test(book.title), encoding: 'utf-8' };
            localStorage.setItem(`${name}_progressText`, `${book.progress.percentage.toFixed(1)}%`);
        }
        this.persist();
    }
    async init(bookshelf) {
        this.bookshelf = bookshelf;
        this.installEvents();
        if (!(await this.connect())) return;
        await this.retryUploads();
        await this.refreshCatalog();
        await bookshelf.refreshBookList(true, true);
        const local = (await bookshelf.db.getAllBooks()).filter(book => !catalogBook(book.name));
        if (local.length && !document.getElementById('reader-migration')) {
            const banner = document.createElement('div'); banner.id = 'reader-migration';
            const label = document.createElement('span'); label.textContent = `发现 ${local.length} 本浏览器中的书，可一键上传书籍和进度。`;
            const button = document.createElement('button'); button.textContent = '上传到服务器';
            button.addEventListener('click', async () => {
                button.disabled = true;
                try { await this.migrate(); banner.remove(); } catch (error) { this.status(error.message); button.disabled = false; }
            });
            banner.append(label, button); document.body.append(banner);
        }
    }
    installEvents() {
        if (this.eventsInstalled) return;
        this.eventsInstalled = true;
        const action = () => { if (!this.suppressed) this.lastInteraction = Date.now(); };
        for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove']) document.addEventListener(type, action, { capture: true, passive: true });
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.beacon(); else this.retry(); });
        window.addEventListener('pagehide', () => this.beacon());
        window.addEventListener('online', () => this.retry());
        setInterval(() => this.retry(), 15000);
    }
    async retry() {
        try { if (await this.connect()) { await this.retryUploads(); await this.flush(); } } catch { this.status('尚未同步'); }
    }
}
export const readerSync = new ReaderSync();
