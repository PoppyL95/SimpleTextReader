/** Phase-two acceptance through the reader UI, with fresh devices and a mobile viewport. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startReader } from './smoke.mjs';

const source = '第一章 批注测试\r\n\r\n  甲\u200b段中文🙂。\r\n\r\n乙段中文。\r\n' +
    Array.from({ length: 200 }, (_, i) => `原文${i}：这是一段用于验证划线与批注的中文。`).join('\n');
const expected = { startLine: 3, startOffset: 5, endLine: 5, endOffset: 3,
    quote: source.split('\n').slice(2, 5).map((line, i) => i === 0 ? line.slice(5) : i === 2 ? line.slice(0, 3) : line).join('\n') };
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp(path.join(tmpdir(), 'hals-notes-browser-'));
        let runtime = await startReader(directory, prefix);
        const contexts = [], errors = [];
        const api = async (endpoint, options = {}) => {
            const response = await fetch(runtime.url + '/api' + endpoint, { ...options,
                headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
            assert(response.ok, `${endpoint}: ${response.status}`); return response.json();
        };
        async function device(mobile = false) {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            if (mobile) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForFunction(async () => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { readerAnnotations } = await import('./client/app/modules/features/reader-annotations.js');
                return bookshelf.enabled && readerAnnotations.initialized;
            });
            await page.evaluate(() => { if (window.Swal?.isVisible()) window.Swal.close(); });
            return page;
        }
        async function showOpening(page, id) {
            await page.evaluate(async id => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { cacheKey } = await import('./client/app/modules/api/reader-catalog.js');
                const { reader } = await import('./client/app/modules/features/reader.js');
                if (!await bookshelf.openBook(cacheKey(id))) throw new Error('Book did not open');
                await reader.gotoLine(3, false);
            }, id);
            await page.waitForSelector('.reader-note-marker[data-line="3"]');
        }
        async function selectCrossParagraph(page) {
            await page.evaluate(() => {
                const first = document.getElementById('line3'), last = document.getElementById('line4');
                const point = (root, offset) => {
                    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                        if (offset <= node.length) return [node, offset]; offset -= node.length;
                    }
                    throw new Error('Selection point not found');
                };
                const range = document.createRange(); range.setStart(...point(first, 2)); range.setEnd(...point(last, 3));
                window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
            });
            await page.waitForSelector('#reader-selection-menu:not([hidden])');
        }
        async function touchTap(page, selector) {
            // The cloud Chromium touch driver uses the emulated screen size. Upstream's
            // 500px minimum layout expands innerWidth on a 390px mobile viewport.
            const point = await page.$eval(selector, node => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, height: innerHeight };
            });
            const screen = page.viewport();
            await page.touchscreen.tap(point.x * screen.width / point.width, point.y * screen.height / point.height);
        }
        try {
            const first = await device();
            await first.evaluate(async text => {
                const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                await FileHandler.handleSelectedFile([new File([text], '批注测试.txt', { type: 'text/plain' })]);
            }, source);
            await first.waitForSelector('.reader-note-marker[data-line="3"]');
            const id = await first.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
            // Drag with the mouse across paragraphs; this uses the browser's native Selection.
            const coordinates = await first.evaluate(() => {
                const point = (id, offset) => {
                    const node = document.getElementById(id).firstChild, range = document.createRange();
                    range.setStart(node, offset); range.collapse(true); const rect = range.getBoundingClientRect();
                    return { x: rect.x, y: rect.y + rect.height / 2 };
                };
                return { start: point('line3', 2), end: point('line4', 3) };
            });
            await first.mouse.move(coordinates.start.x, coordinates.start.y); await first.mouse.down();
            await first.mouse.move(coordinates.end.x, coordinates.end.y, { steps: 15 }); await first.mouse.up();
            await first.waitForSelector('#reader-selection-menu:not([hidden])');
            await first.click('#reader-selection-menu button:nth-child(1)');
            await first.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).length === 1, {}, id);
            let notes = await api(`/books/${id}/notes`);
            const highlight = notes[0];
            for (const [key, value] of Object.entries(expected)) assert.equal(highlight[key], value, key);
            assert.equal(highlight.author, 'reader');
            // Persistence can finish before the requestAnimationFrame that paints
            // the confirmed highlight. Wait for the rendered result as well.
            await first.waitForFunction(() => CSS.highlights.get('reader-notes')?.size === 2);
            const highlighted = await first.evaluate(() => [...CSS.highlights.get('reader-notes')].map(range => range.toString()).join('|'));
            assert.equal(highlighted, '中文🙂。|乙段中');
            // Selecting again sends the exact same original quote, including CR and blank lines.
            await selectCrossParagraph(first); await first.click('#reader-selection-menu button:nth-child(2)');
            await first.waitForFunction(async () => (await (await fetch('./api/handoff?unread=1')).json()).items.length === 1);
            const item = (await api('/handoff?unread=1')).items[0];
            assert.equal(item.payload.quote, expected.quote); assert.equal(item.payload.title, '批注测试');
            // A companion comment is fetched, safely displayed, and unread until the thread is opened.
            const hals = await api(`/books/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: 3, text: '<img src=x onerror=alert(1)>来自小克', author: 'reader', parentId: highlight.id }) });
            await first.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh());
            await first.waitForSelector('.reader-note-marker[data-line="3"].unread');
            assert.equal((await api(`/books/${id}/notes`)).find(note => note.id === hals.id).readAt, null);
            await first.click('.reader-note-marker[data-line="3"]');
            await first.waitForSelector('#reader-note-thread:not([hidden])');
            assert.equal(await first.$eval('#reader-note-thread img', () => true).catch(() => false), false);
            assert((await first.$eval('#reader-note-thread', node => node.textContent)).includes('<img src=x onerror=alert(1)>来自小克'));
            await first.waitForFunction(async ({ id, noteId }) => Boolean((await (await fetch(`./api/books/${id}/notes`)).json()).find(note => note.id === noteId).readAt), {}, { id, noteId: hals.id });
            assert.match(await first.$eval(`#reader-note-thread article[data-note-id="${highlight.id}"] .reader-note-meta`, node => node.textContent), /^我 · /);
            await api(`/books/${id}/notes/${hals.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: '新到的编辑仍需确认' }) });
            await first.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh());
            await first.waitForSelector('.reader-note-marker[data-line="3"].unread');
            assert.equal((await api(`/books/${id}/notes`)).find(note => note.id === hals.id).readAt, null, 'an open panel must not consume later edits');
            await first.click('.reader-note-marker[data-line="3"]');
            await first.waitForFunction(async ({ id, noteId }) => Boolean((await (await fetch(`./api/books/${id}/notes`)).json()).find(note => note.id === noteId).readAt), {}, { id, noteId: hals.id });
            // Reply to a highlight, then edit and delete via UI.
            await first.click('#reader-note-thread article:first-of-type .reader-note-actions button:first-child');
            await first.type('#reader-note-thread textarea', '读者在划线处的回复');
            const pageBeforeTyping = await first.evaluate(async () => (await import('./client/app/config/index.js')).VARS.CURRENT_PAGE);
            await first.keyboard.press('ArrowLeft');
            assert.equal(await first.evaluate(async () => (await import('./client/app/config/index.js')).VARS.CURRENT_PAGE), pageBeforeTyping);
            assert.equal(await first.$eval('#reader-note-thread textarea', node => node.selectionStart), '读者在划线处的回复'.length - 1);
            await first.click('#reader-note-thread > button:nth-last-child(3)');
            await first.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).length === 3, {}, id);
            notes = await api(`/books/${id}/notes`); const reply = notes.find(note => note.text === '读者在划线处的回复');
            assert.equal(reply.parentId, highlight.id); assert.equal(reply.line, 3);
            await first.click(`#reader-note-thread article[data-note-id="${reply.id}"] .reader-note-actions button:nth-child(2)`);
            await first.$eval('#reader-note-thread textarea', node => { node.value = '已修改的回复'; });
            await first.click('#reader-note-thread > button:nth-last-child(3)');
            await first.waitForFunction(async ({ id, noteId }) => (await (await fetch(`./api/books/${id}/notes`)).json()).find(note => note.id === noteId)?.text === '已修改的回复', {}, { id, noteId: reply.id });
            first.once('dialog', dialog => dialog.accept());
            await first.click(`#reader-note-thread article[data-note-id="${reply.id}"] .reader-note-actions button:nth-child(3)`);
            await first.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).length === 2, {}, id);
            // Close the panel, restart the server and open on a device with empty storage.
            await first.keyboard.press('Escape');
            assert.equal(await first.$eval('#reader-note-thread', node => node.hidden), true);
            assert.equal(await first.evaluate(async () => (await import('./client/app/config/index.js')).VARS.IS_BOOK_OPENED), true);
            await runtime.stop(); runtime = await startReader(directory, prefix, runtime.token, runtime.port);
            const second = await device(); await showOpening(second, id);
            await second.waitForFunction(() => CSS.highlights.get('reader-notes')?.size === 2);
            assert.equal((await api('/handoff?unread=1')).items[0].id, item.id);
            // Page away and back in both upstream modes: coordinates and highlights are unchanged.
            for (const infinite of [false, true]) {
                await second.evaluate(async infinite => {
                    const CONFIG = await import('./client/app/config/index.js');
                    CONFIG.CONST_CONFIG.INFINITE_SCROLL_MODE = infinite;
                    const { reader } = await import('./client/app/modules/features/reader.js');
                    reader.toggleInfiniteScroll(); await reader.gotoLine(150, false); await reader.gotoLine(3, false);
                }, infinite);
                await selectCrossParagraph(second);
                const selected = await second.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.selection);
                for (const [key, value] of Object.entries(expected)) assert.equal(selected[key], value, `${infinite}: ${key}`);
                await second.waitForFunction(() => CSS.highlights.get('reader-notes')?.size === 2);
            }
            // Exercise the fallback renderer as well as the native CSS Highlight path.
            await second.evaluate(async () => {
                Object.defineProperty(CSS, 'highlights', { value: undefined, configurable: true });
                (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.paint();
            });
            assert.equal(await second.$$eval('mark.reader-highlight', nodes => nodes.map(node => node.textContent).join('|')), '中文🙂。|乙段中');
            await selectCrossParagraph(second);
            const fallbackSelection = await second.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.selection);
            assert.equal(fallbackSelection.quote, expected.quote);
            const mobile = await device(true); await showOpening(mobile, id);
            await selectCrossParagraph(mobile);
            const bounds = await mobile.$eval('#reader-selection-menu', node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
            assert(bounds.left >= 0 && bounds.right <= 390);
            await touchTap(mobile, '#reader-selection-menu button:nth-child(2)');
            await mobile.waitForFunction(async () => (await (await fetch('./api/handoff?unread=1')).json()).items.length === 2);
            // Offline comment failure retains the draft; retry writes it exactly once.
            await mobile.$eval('.reader-note-marker[data-line="5"]', node => node.click());
            await mobile.waitForSelector('#reader-note-thread:not([hidden]) textarea');
            await mobile.type('#reader-note-thread textarea', '断网保留的批注'); await runtime.stop();
            await mobile.$eval('#reader-note-thread > button:nth-last-child(3)', node => node.click());
            await mobile.waitForFunction(() => document.querySelector('#reader-note-thread .reader-note-error').textContent.includes('尚未保存'));
            assert.equal(await mobile.$eval('#reader-note-thread textarea', node => node.value), '断网保留的批注');
            runtime = await startReader(directory, prefix, runtime.token, runtime.port);
            await mobile.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.connect());
            await mobile.$eval('#reader-note-thread > button:nth-last-child(3)', node => node.click());
            await mobile.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).some(note => note.text === '断网保留的批注'), {}, id);
            await api(`/books/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: 2, text: '空行上的批注也要能展开' }) });
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh());
            await mobile.waitForSelector('.reader-note-marker[data-line="2"].unread');
            await mobile.$eval('.reader-note-marker[data-line="2"]', node => node.click());
            assert((await mobile.$eval('#reader-note-thread header', node => node.textContent)).includes('原文第 2 行'));
            assert.deepEqual(errors, []);
            console.log(`PASS ${prefix || '/'}: drag, raw blank-line selection, highlight restore, handoff, unread, safe threads, CRUD, layouts, fallback, mobile, offline draft`);
        } finally {
            for (const context of contexts) await context.close();
            await runtime.stop(); await rm(directory, { recursive: true, force: true });
        }
    }
} finally { await browser.close(); }
