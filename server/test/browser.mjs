/** Phase 1 browser acceptance: two devices, empty cache, offline retry, migration and both layouts. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startReader } from './smoke.mjs';

const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
const source = '第一章 同步测试\n\n中文段落一。\n\n中文段落二。\n' +
    Array.from({ length: 600 }, (_, i) => `原文${i}：这是一段用于验证排版和同步的中文。`).join('\n');
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp(path.join(tmpdir(), 'hals-browser-'));
        let runtime = await startReader(directory, prefix);
        const contexts = [];
        const errors = [];
        async function device() {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForFunction(async () => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                return bookshelf.enabled && readerSync.online;
            });
            return page;
        }
        try {
            const first = await device();
            assert.equal(await first.$eval('html', element => element.dataset.theme), 'dark');
            await first.evaluate(async text => {
                const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                await FileHandler.handleSelectedFile([new File([text], '同步测试.txt', { type: 'text/plain' })]);
            }, source);
            assert(await first.evaluate(() => document.body.innerText.includes('中文段落一')));
            const reading = await first.evaluate(async () => {
                const { reader } = await import('./client/app/modules/features/reader.js');
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
                await reader.gotoLine(35, false);
                return { id: readerSync.current, expected: readerSync.maps.get(readerSync.current).toOriginal(35) };
            });
            await first.waitForFunction(async id => (await (await fetch(`./api/books/${id}/progress`)).json()).clientUpdatedAt > 0, {}, reading.id);
            const saved = await (await fetch(runtime.url + `/api/books/${reading.id}/progress`)).json();
            assert.equal(saved.line, reading.expected);
            const second = await device(); // Empty IndexedDB and localStorage.
            assert.equal(await second.$$eval('.book', elements => elements.length), 1);
            await second.evaluate(async id => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { cacheKey } = await import('./client/app/modules/api/reader-catalog.js');
                if (!(await bookshelf.openBook(cacheKey(id)))) throw new Error('Cannot open server book');
            }, reading.id);
            const restored = await second.evaluate(async () => {
                const { getTopLineNumber } = await import('./client/app/utils/helpers-reader.js');
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                return readerSync.maps.get(readerSync.current).toOriginal(getTopLineNumber());
            });
            assert.equal(restored, saved.line);
            const afterOpen = await (await fetch(runtime.url + `/api/books/${reading.id}/progress`)).json();
            assert.deepEqual(afterOpen, saved, 'initial rendering must not overwrite server progress');
            // Save a backtrack offline and retry without manufacturing a new timestamp.
            await runtime.stop();
            await second.evaluate(async () => {
                const { reader } = await import('./client/app/modules/features/reader.js');
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
                await reader.gotoLine(15, false); await readerSync.flush();
            });
            assert.match(await second.$eval('#reader-sync-status', element => element.textContent), /尚未同步/);
            runtime = await startReader(directory, prefix, runtime.token, runtime.port);
            await second.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.retry());
            const backtracked = await (await fetch(runtime.url + `/api/books/${reading.id}/progress`)).json();
            assert(backtracked.line < saved.line); assert(backtracked.clientUpdatedAt > saved.clientUpdatedAt);
            // Exercise upstream infinite scrolling without changing its pagination/typography.
            await second.evaluate(async () => {
                const CONFIG = await import('./client/app/config/index.js');
                CONFIG.CONST_CONFIG.INFINITE_SCROLL_MODE = true;
                const { reader } = await import('./client/app/modules/features/reader.js');
                reader.toggleInfiniteScroll();
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
                await reader.gotoLine(45, false); await readerSync.flush();
            });
            const infinite = await (await fetch(runtime.url + `/api/books/${reading.id}/progress`)).json();
            const expectedInfinite = await second.evaluate(async () => { const { readerSync } = await import('./client/app/modules/api/reader-sync.js'); return readerSync.maps.get(readerSync.current).toOriginal(45); });
            assert.equal(infinite.line, expectedInfinite);
            const migration = await device();
            await migration.evaluate(async () => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                await bookshelf.db.putBook('旧书.[旧作者].txt', new File(['第一章\n\n旧正文\n下一段'], '旧书.[旧作者].txt', { type: 'text/plain' }));
                localStorage.setItem('旧书.[旧作者].txt', '4');
                localStorage.setItem('STR-Filename', '旧书.[旧作者].txt');
            });
            await migration.reload({ waitUntil: 'networkidle2' });
            await migration.waitForSelector('#reader-migration');
            assert(!(await (await fetch(runtime.url + '/api/books')).json()).some(book => book.filename === '旧书.[旧作者].txt'), 'legacy auto-open must not upload before consent');
            await migration.evaluate(() => { if (window.Swal?.isVisible()) window.Swal.close(); });
            await migration.click('#reader-migration button');
            await migration.waitForFunction(() => !document.getElementById('reader-migration') || document.getElementById('reader-sync-status')?.textContent.includes('迁移未完成'));
            assert.equal(await migration.$eval('body', () => document.getElementById('reader-migration') ? document.getElementById('reader-sync-status')?.textContent : ''), '', 'migration failed');
            const migrated = (await (await fetch(runtime.url + '/api/books')).json()).find(book => book.filename === '旧书.[旧作者].txt');
            assert.equal(migrated.progress.line, 3);
            assert.deepEqual(errors, []);
            console.log(`PASS ${prefix || '/'}: dark default, upload, debounce, two devices, restore without overwrite, offline backtrack, migration, layouts`);
        } finally {
            for (const context of contexts) await context.close();
            await runtime.stop(); await rm(directory, { recursive: true, force: true });
        }
    }
} finally { await browser.close(); }
