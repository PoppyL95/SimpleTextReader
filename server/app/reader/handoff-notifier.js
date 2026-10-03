/** Best-effort, metadata-only notification after a fixed per-book batching window. */
export class HandoffNotifier {
    constructor({ url = process.env.HANDOFF_NOTIFY_URL, fetch = globalThis.fetch,
        schedule = setTimeout, cancel = clearTimeout, log = message => console.warn(message) } = {}) {
        this.url = url; this.fetch = fetch; this.schedule = schedule; this.cancel = cancel; this.log = log;
        this.pending = new Map();
    }
    enqueue({ type, bookId, title }) {
        if (!this.url) return;
        const existing = this.pending.get(bookId);
        if (existing) { existing.batch.count++; return; }
        const batch = { type, bookId, title, count: 1 };
        const timer = this.schedule(() => {
            this.pending.delete(bookId);
            void this.send(batch);
        }, 10000);
        timer?.unref?.();
        this.pending.set(bookId, { batch, timer });
    }
    async send(batch) {
        try {
            const url = new URL(this.url);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid notification protocol');
            const response = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch), signal: AbortSignal.timeout(3000), redirect: 'error' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            // Do not log URLs, book contents, credentials, or receiver response bodies.
            this.log(`Handoff notification failed: ${error.name || 'Error'}`);
        }
    }
    close() { for (const entry of this.pending.values()) this.cancel(entry.timer); this.pending.clear(); }
}
