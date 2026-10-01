/** Stable IndexedDB cache keys; displayed filenames remain reader-facing metadata. */
export const readerRoot = new URL('../../../../', import.meta.url);
export const readerApi = new URL('api', readerRoot).pathname;
export const storagePrefix = `reader:${readerRoot.pathname}:`;
export const cacheKey = id => `hals-${id}.txt`;
let catalog = {};
try { catalog = JSON.parse(localStorage.getItem(`${storagePrefix}catalog`) || '{}'); } catch { /* unavailable cache */ }
export function catalogBook(key) { return catalog[key.endsWith('.txt') ? key : `${key}.txt`]; }
export function catalogEntries() { return Object.values(catalog); }
export function rememberBook(book) {
    catalog[cacheKey(book.id)] = book;
    localStorage.setItem(`${storagePrefix}catalog`, JSON.stringify(catalog));
}
export function forgetBook(id) {
    delete catalog[cacheKey(id)];
    localStorage.setItem(`${storagePrefix}catalog`, JSON.stringify(catalog));
}
