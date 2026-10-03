/** Desktop and 390px touch acceptance; OS Safari menus/keyboards require a real iPhone. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import { startReader } from './smoke.mjs';
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
const source = '第一章\n\n' + Array.from({ length: 80 }, (_, i) => `虚构原文第${i}段，书里的一句话。`).join('\n');
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp('/tmp/hals-note-panels-'), runtime = await startReader(directory, prefix);
        const errors = [];
        const api = async (endpoint, value, method = 'POST') => {
            const response = await fetch(runtime.url + '/api' + endpoint, { method, headers: {
                Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: value ? JSON.stringify(value) : undefined });
            assert(response.ok, `${endpoint}: ${response.status}`); return response.json();
        };
        try {
            for (const mobile of [false, true]) {
                const context = await browser.createBrowserContext(), page = await context.newPage();
                page.on('pageerror', error => errors.push(error.message));
                await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
                await page.evaluateOnNewDocument(() => localStorage.setItem('mobile_reading_mode', 'scroll'));
                await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
                await page.waitForFunction(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.initialized);
                if (await page.$('.swal2-confirm')) await page.click('.swal2-confirm');
                await page.evaluate(async ({ source, mobile }) => {
                    const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                    await FileHandler.handleSelectedFile([new File([source + (mobile ? '\n手机' : '\n桌面')], '面板测试.txt', { type: 'text/plain' })]);
                    (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false);
                }, { source, mobile });
                const id = await page.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
                await page.evaluate(async id => {
                    const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                    await readerSync.request(`/books/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ kind: 'highlight', startLine: 3, endLine: 3, startOffset: 0, endOffset: 4, quote: '虚构原文' }) });
                }, id);
                const hals = await api(`/books/${id}/notes`, { line: 3, text: '<img src=x>小克的批注' });
                await api(`/books/${id}/notes`, { line: 50, text: '远处的一条小克批注' });
                await page.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh());
                await page.click('#reader-all-notes-button');
                await page.waitForSelector('.reader-all-note');
                const preview = await page.$$eval('.reader-all-note', items => items.map(item => item.textContent));
                assert.equal(preview.length, 3); assert(preview[0].includes('划线')); assert(preview[2].includes('第 50 行'));
                assert.equal(await page.$('#reader-all-notes img'), null);
                assert.equal((await api(`/books/${id}/notes`, null, 'GET')).find(note => note.id === hals.id).readAt, null);
                await page.click('[data-filter="hals"]'); assert.equal(await page.$$eval('.reader-all-note', items => items.length), 2);
                await page.click('[data-filter="unread"]'); assert.equal(await page.$$eval('.reader-all-note', items => items.length), 2);
                await page.screenshot({ path: `/tmp/hals-all-notes-${mobile ? '390' : 'desktop'}${prefix ? '-subpath' : ''}.png` });
                await page.click('.reader-all-note:last-child');
                await page.waitForSelector('#reader-note-thread:not([hidden])');
                assert((await page.$eval('#reader-note-thread header', node => node.textContent)).includes('第 50 行'));
                assert(await page.evaluate(async id => {
                    const { readerSync } = await import('./client/app/modules/api/reader-sync.js');
                    const line = readerSync.maps.get(id).toRendered(50);
                    const rect = document.getElementById(`line${line}`).getBoundingClientRect();
                    const content = document.getElementById('content').getBoundingClientRect();
                    return rect.bottom >= content.top && rect.top <= content.bottom;
                }, id), 'the clicked original line must be visible in the reader');
                await page.click('#reader-note-thread header button');
                await page.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.openThread(3));
                if (mobile) await page.tap('#reader-note-thread .reader-note-actions button');
                else await page.click('#reader-note-thread .reader-note-actions button');
                assert(await page.$eval('#reader-note-thread textarea', node => node === document.activeElement));
                const editor = await page.$('#reader-note-thread textarea');
                if (mobile) {
                    await editor.evaluate(node => node.blur());
                    await page.tap('#reader-note-thread textarea');
                    assert(await editor.evaluate(node => node === document.activeElement), 'direct tapping the reply field must focus it');
                }
                await page.evaluate(async () => {
                    const { handleGlobalScrolling } = await import('./client/app/utils/helpers-ui.js');
                    handleGlobalScrolling({ isScrolling: true, delay: null });
                    handleGlobalScrolling({ isScrolling: false });
                });
                assert(await editor.evaluate(node => node === document.activeElement), 'scroll tooltip cleanup must preserve the editor focus');
                // Incoming notes must not replace a focused, empty editor and dismiss its keyboard.
                await api(`/books/${id}/notes`, { line: 3, text: '输入时新到的批注' });
                await page.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh());
                const focusState = await editor.evaluate(node => ({ connected: node.isConnected, active: document.activeElement?.tagName, same: node === document.activeElement, panelHidden: document.querySelector('#reader-note-thread').hidden }));
                assert(focusState.connected && focusState.same, JSON.stringify({ prefix, mobile, focusState }));
                await page.keyboard.type('读者回复');
                await page.screenshot({ path: `/tmp/hals-note-reply-${mobile ? '390' : 'desktop'}${prefix ? '-subpath' : ''}.png` });
                if (mobile) {
                    // A shrunken visual viewport exercises keyboard geometry without pretending to launch an OS keyboard.
                    await page.evaluate(() => {
                        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
                        window.visualViewport.dispatchEvent(new Event('resize'));
                    });
                    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
                    const fit = await page.$eval('#reader-note-thread', panel => {
                        const rect = panel.getBoundingClientRect(), editor = panel.querySelector('textarea').getBoundingClientRect();
                        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, editorBottom: editor.bottom, overflow: panel.scrollWidth > panel.clientWidth };
                    });
                    assert(fit.top >= 0 && fit.bottom <= 360 && fit.left >= 0 && fit.right <= 390 && fit.editorBottom <= 360 && !fit.overflow, JSON.stringify(fit));
                    await page.screenshot({ path: `/tmp/hals-note-keyboard-390${prefix ? '-subpath' : ''}.png` });
                    await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
                }
                await page.click('#reader-note-thread > button:nth-last-child(3)');
                await page.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).some(note => note.text === '读者回复'), {}, id);
                await page.click('#reader-note-thread header button');
                await page.evaluate(async () => {
                    const { reader } = await import('./client/app/modules/features/reader.js'); await reader.gotoLine(3, false);
                    const node = document.getElementById('line3').firstChild, range = document.createRange();
                    range.setStart(node, 0); range.setEnd(node, 4); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                });
                await page.waitForSelector('#reader-selection-menu:not([hidden])');
                const selectionBox = await page.$eval('#reader-selection-menu', menu => menu.getBoundingClientRect().toJSON());
                if (mobile) assert(selectionBox.left >= 0 && selectionBox.right <= 390 && selectionBox.top > 500);
                await page.screenshot({ path: `/tmp/hals-selection-${mobile ? '390' : 'desktop'}${prefix ? '-subpath' : ''}.png` });
                if (mobile) await page.tap('#reader-selection-menu button:nth-child(2)');
                else await page.click('#reader-selection-menu button:nth-child(2)');
                await page.waitForFunction(async id => (await (await fetch('./api/handoff')).json()).items.some(item => item.bookId === id), {}, id);
                await context.close();
            }
            assert.deepEqual(errors, []); console.log(`Note panel acceptance passed at ${prefix || '/'}`);
        } finally { await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    }
} finally { await browser.close(); }
