import * as CONFIG from '../../config/index.js';
import { readerSync } from './reader-sync.js';
import { readerApi, storagePrefix } from './reader-catalog.js';
import { activeReadingMs } from '../../../../shared/core/reader/review-fields.js';

class ReadingTracker {
    init() {
        if (this.initialized || !readerSync.active) return;
        this.initialized = true;
        try { this.pending = JSON.parse(localStorage.getItem(storagePrefix + 'reading-time') || '{}'); } catch { this.pending = {}; }
        this.visible = !document.hidden; this.lastTick = Date.now(); this.lastInteraction = 0;
        const action = event => {
            if (!this.bookId || this.paused || document.hidden || readerSync.suppressed) return;
            const { CONTENT_CONTAINER, TOC_CONTAINER } = CONFIG.DOM_ELEMENT;
            if (event.target?.closest?.('.reader-review-ui, .reader-note-ui') ||
                !(CONTENT_CONTAINER.contains(event.target) || TOC_CONTAINER.contains(event.target) ||
                event.target?.closest?.('#pagination') || (event.type === 'keydown' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Shift'].includes(event.key)))) return;
            this.interact();
        };
        for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove']) document.addEventListener(type, action, { capture: true, passive: true });
        document.addEventListener('reader:book-opening', () => this.closeBook());
        document.addEventListener('reader:book-closed', () => this.closeBook());
        document.addEventListener('reader:book-opened', () => this.openBook());
        document.addEventListener('visibilitychange', () => {
            this.tick(); this.visible = !document.hidden;
            if (document.hidden) this.beacon(); else this.flush();
        });
        window.addEventListener('pagehide', () => { this.tick(); this.beacon(); });
        window.addEventListener('online', () => this.flush());
        setInterval(() => { this.tick(); this.flush(); }, 5000);
        if (readerSync.current && !readerSync.suppressed) this.openBook();
        this.flush();
    }
    persist() { localStorage.setItem(storagePrefix + 'reading-time', JSON.stringify(this.pending)); }
    openBook() {
        this.closeBook(); this.bookId = readerSync.current; this.lastInteraction = 0;
        this.lastTick = Date.now(); this.sessionId = null;
    }
    closeBook() {
        this.tick(); this.flush(); this.bookId = null; this.sessionId = null; this.lastInteraction = 0;
    }
    interact(now = Date.now()) {
        this.tick(now); this.lastInteraction = now;
        if (!this.sessionId) {
            this.sessionId = crypto.randomUUID();
            this.pending[this.sessionId] = { bookId: this.bookId, sessionId: this.sessionId, startedAt: now, elapsedMs: 0 };
            this.persist();
        }
    }
    tick(now = Date.now()) {
        if (!this.initialized) return;
        const delta = activeReadingMs(this.lastTick, now, this.lastInteraction,
            Boolean(this.bookId && this.visible && !this.paused && CONFIG.VARS.IS_BOOK_OPENED));
        this.lastTick = now;
        const session = this.pending[this.sessionId];
        if (session && delta) { session.elapsedMs += delta; this.persist(); }
    }
    pause(value) { this.tick(); this.paused = value; }
    async flush() {
        if (!this.initialized || this.flushing) return;
        this.flushing = true;
        try {
            for (const [id, session] of Object.entries(this.pending)) {
                const snapshot = { ...session };
                try {
                    await readerSync.request(`/books/${snapshot.bookId}/reading`, { method: 'POST',
                        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
                    if (id !== this.sessionId && this.pending[id]?.elapsedMs === snapshot.elapsedMs) delete this.pending[id];
                    if (id === this.sessionId) this.acknowledged = snapshot.elapsedMs;
                } catch (error) {
                    if (error.status === 404) delete this.pending[id];
                    else { this.unsynced = true; this.persist(); return; }
                }
            }
            this.unsynced = false; this.persist();
        } finally { this.flushing = false; }
    }
    beacon() {
        if (!this.initialized) return;
        for (const session of Object.values(this.pending)) navigator.sendBeacon(`${readerApi}/books/${session.bookId}/reading`,
            new Blob([JSON.stringify(session)], { type: 'application/json' }));
    }
}
export const readingTracker = new ReadingTracker();
