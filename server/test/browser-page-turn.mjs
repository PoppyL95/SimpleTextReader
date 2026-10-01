/** Mobile screen pagination, original-text anchors, and unique completion cards. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import { startReader } from './smoke.mjs';

const longParagraph = Array.from({ length: 130 }, (_, i) => `纸船${i}沿着河流慢慢漂远，岸边灯光映在水上。秋舟记录这一晚🙂。`).join('');
const source = `第一章 夜航\n\n${longParagraph}\n\n岸边的灯还亮着。\n第二章 清晨\n` +
    Array.from({ length: 35 }, (_, i) => `清晨${i}，新的纸船从桥下出发。远处有人招手，河面泛起涟漪。`).join('\n');
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp('/tmp/hals-page-turn-');
        const runtime = await startReader(directory, prefix), errors = [], contexts = [];
        const suffix = prefix ? '-subpath' : '';
        async function device(mobile = true) {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error('browser error', error.message); });
            await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { width: 1280, height: 900 });
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForFunction(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.initialized);
            await page.evaluate(() => window.Swal?.close()); return page;
        }
        const state = page => page.evaluate(async () => {
            const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
            const content = document.querySelector('#content');
            return { active: p.active, chapter: p.chapter, page: p.page, count: p.count, stride: p.stride, anchor: p.currentAnchor,
                width: innerWidth, docWidth: document.documentElement.scrollWidth, height: content.clientHeight,
                contentScroll: content.scrollWidth, scrollLeft: content.scrollLeft, menu: document.body.classList.contains('reader-page-menu-open'), selection: String(getSelection()), scale: visualViewport.scale };
        });
        const waitPage = (page, index) => page.waitForFunction(async index => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.page === index, {}, index);
        async function tap(page, x, y = 360) { await page.touchscreen.tap(x, y); }
        async function swipe(page, from, to) {
            const client = await page.createCDPSession();
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y: 360 }] });
            for (let i = 1; i <= 4; i++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 4, y: 360 }] });
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await client.detach();
        }
        try {
            const mobile = await device();
            await mobile.evaluate(async source => {
                const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                await FileHandler.handleSelectedFile([new File([source], '《纸船夜航》by秋舟.txt', { type: 'text/plain' })]);
                await (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false);
                await document.fonts.ready;
            }, source);
            await mobile.waitForFunction(async () => {
                const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                return p.active && p.count > 3 && Boolean(p.currentAnchor);
            });
            let before = await state(mobile);
            assert.equal(before.width, 390); assert(before.docWidth <= 390); assert.equal(before.menu, false);
            await mobile.screenshot({ path: `/tmp/hals-reader-page-turn-390${suffix}.png` });
            await tap(mobile, 350, 30); await waitPage(mobile, before.page + 1);
            await tap(mobile, 30, 30); await waitPage(mobile, before.page);
            await tap(mobile, 350); await waitPage(mobile, before.page + 1);
            const advanced = await state(mobile); assert.equal(advanced.anchor.line, 3); assert(advanced.anchor.offset > before.anchor.offset);
            await tap(mobile, 30); await waitPage(mobile, before.page);
            await swipe(mobile, 330, 60); await waitPage(mobile, before.page + 1);
            await swipe(mobile, 60, 330); await waitPage(mobile, before.page);
            await tap(mobile, 195); await mobile.waitForFunction(() => document.body.classList.contains('reader-page-menu-open'));
            await mobile.screenshot({ path: `/tmp/hals-reader-page-turn-menu-390${suffix}.png` });
            await tap(mobile, 195); await mobile.waitForFunction(() => !document.body.classList.contains('reader-page-menu-open'));
            assert.equal((await state(mobile)).page, before.page);
            // Every visible text line is fully inside the screen page, even a paragraph spanning many pages.
            const fragments = await mobile.evaluate(async () => {
                const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                const content = p.content, box = content.getBoundingClientRect(), clipped = [], visible = [];
                for (let i = 0; i < p.count; i++) {
                    p.move(i, false);
                    for (const element of content.querySelectorAll('p,h2')) {
                        const range = document.createRange(); range.selectNodeContents(element);
                        for (const rect of range.getClientRects()) if (rect.width && rect.right > 20 && rect.left < 370) {
                            visible.push([i, rect.top, rect.bottom]);
                            if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < 19 || rect.right > 371) clipped.push([i, element.id, rect.top, rect.bottom, rect.left, rect.right]);
                        }
                    }
                }
                p.move(0, false); return { clipped, lines: visible.length };
            });
            assert(fragments.lines > 100); assert.deepEqual(fragments.clipped, []);
            // A long touch and a native text selection must not trigger a turn.
            const client = await mobile.createCDPSession();
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 350, y: 360 }] });
            await new Promise(resolve => setTimeout(resolve, 450));
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await client.detach();
            assert.equal((await state(mobile)).page, 0);
            await mobile.evaluate(() => {
                const paragraph = document.querySelector('#line4'); const text = paragraph.firstChild;
                const range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 18);
                getSelection().removeAllRanges(); getSelection().addRange(range);
            });
            await mobile.waitForSelector('#reader-selection-menu:not([hidden])');
            await tap(mobile, 350, 620); assert.equal((await state(mobile)).page, 0);
            await mobile.evaluate(() => {
                const text = document.querySelector('#line4').firstChild; const range = document.createRange();
                range.setStart(text, 4); range.setEnd(text, 18); getSelection().removeAllRanges(); getSelection().addRange(range);
            });
            await mobile.waitForSelector('#reader-selection-menu:not([hidden])');
            await mobile.click('#reader-selection-menu button:first-child');
            await mobile.waitForFunction(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.notes.some(note => note.kind === 'highlight'));
            const highlight = await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.notes.find(note => note.kind === 'highlight'));
            assert.equal(highlight.startLine, 3); assert.equal(highlight.startOffset, 4); assert.equal(highlight.endOffset, 18);
            assert.equal(highlight.quote, longParagraph.slice(4, 18));
            await mobile.waitForFunction(() => CSS.highlights?.get('reader-notes')?.size > 0);
            const highlightPoint = await mobile.evaluate(() => {
                const range = [...CSS.highlights.get('reader-notes')][0]; const rect = [...range.getClientRects()].find(rect => rect.right > 270);
                return { x: Math.min(350, rect.right - 2), y: rect.top + rect.height / 2 };
            });
            await tap(mobile, highlightPoint.x, highlightPoint.y); assert.equal((await state(mobile)).page, 0, 'highlight taps preserve the annotation entry');
            await mobile.waitForSelector('#reader-paragraph-menu:not([hidden])');
            await mobile.click('#reader-paragraph-menu button'); await mobile.waitForSelector('#reader-note-thread:not([hidden]) textarea');
            await mobile.type('#reader-note-thread textarea', '一屏翻页里的批注。');
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.saveComment());
            await mobile.waitForFunction(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.notes.some(note => note.text === '一屏翻页里的批注。'));
            assert.equal((await state(mobile)).page, 0);
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.closeThread());
            // Chapter boundaries automatically continue in either direction.
            await mobile.evaluate(async () => { const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js'); p.move(p.count - 1, false); });
            const chapter = (await state(mobile)).chapter;
            await tap(mobile, 350); assert.equal((await state(mobile)).chapter, chapter + 1); assert.equal((await state(mobile)).page, 0);
            await tap(mobile, 30); assert.equal((await state(mobile)).chapter, chapter); assert.equal((await state(mobile)).page, (await state(mobile)).count - 1);
            await mobile.evaluate(async () => { const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js'); p.move(2); });
            before = await state(mobile);
            // Use the actual settings dropdown to switch both ways while preserving the raw anchor.
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.setMenu(true));
            await mobile.click('#setting-btn'); await mobile.waitForSelector('#setting_mobile_reading_mode'); await mobile.click('#setting-tab-general');
            await mobile.click('#setting_mobile_reading_mode + .select-styled');
            await mobile.click('#setting_mobile_reading_mode ~ .select-options li[rel="scroll"]');
            await mobile.waitForFunction(async () => !(await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.active && !(await import('./client/app/modules/api/reader-sync.js')).readerSync.suppressed);
            assert.equal(await mobile.evaluate(() => localStorage.getItem('mobile_reading_mode')), 'scroll');
            await mobile.keyboard.press('Escape');
            await mobile.waitForFunction(() => getComputedStyle(document.querySelector('#settings-menu')).display === 'none');
            await mobile.screenshot({ path: `/tmp/hals-reader-scroll-mode-390${suffix}.png` });
            await mobile.click('#setting-btn');
            await mobile.click('#setting-tab-general');
            await mobile.click('#setting_mobile_reading_mode + .select-styled');
            await mobile.click('#setting_mobile_reading_mode ~ .select-options li[rel="pages"]');
            await mobile.waitForFunction(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.active && !(await import('./client/app/modules/api/reader-sync.js')).readerSync.suppressed);
            await mobile.keyboard.press('Escape');
            await mobile.waitForFunction(() => getComputedStyle(document.querySelector('#settings-menu')).display === 'none');
            assert.deepEqual((await state(mobile)).anchor, before.anchor, 'changing reading modes restores the same original-text page');
            await mobile.evaluate(async () => {
                const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                p.setMode('scroll'); p.setMode('pages');
            });
            await mobile.waitForFunction(async () => !(await import('./client/app/modules/api/reader-sync.js')).readerSync.suppressed);
            assert.deepEqual((await state(mobile)).anchor, before.anchor, 'rapid mode changes retain the bookmark and release progress suppression');
            // Font and viewport reflow keep the bookmarked source character visible and do not write progress.
            await mobile.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.flush());
            const id = await mobile.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
            const progressBefore = await (await fetch(runtime.url + `/api/books/${id}/progress`, { headers: { Authorization: `Bearer ${runtime.token}` } })).json();
            await mobile.click('#setting-btn'); await mobile.click('#setting-tab-content-style');
            const originalSize = await mobile.$eval('#setting_p_fontSize', input => input.value);
            await mobile.$eval('#setting_p_fontSize', input => { input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
            await mobile.waitForFunction(async anchor => {
                const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                const rect = p.sourceRect(anchor.renderLine, anchor.offset), view = p.content.getBoundingClientRect();
                return parseFloat(getComputedStyle(p.content.querySelector('p')).fontSize) === 32 && rect.left >= view.left && rect.right <= view.right;
            }, {}, before.anchor);
            await mobile.$eval('#setting_p_fontSize', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, originalSize);
            await mobile.keyboard.press('Escape');
            await mobile.waitForFunction(() => getComputedStyle(document.querySelector('#settings-menu')).display === 'none');
            await mobile.setViewport({ width: 390, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
            await mobile.waitForFunction(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.content.clientHeight < 620);
            await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
            await mobile.waitForFunction(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.content.clientHeight > 620);
            assert.deepEqual((await state(mobile)).anchor, before.anchor);
            await mobile.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.flush());
            const progress = await (await fetch(runtime.url + `/api/books/${id}/progress`, { headers: { Authorization: `Bearer ${runtime.token}` } })).json();
            assert.deepEqual(progress, progressBefore, 'layout and setting changes must not write a new progress timestamp');
            assert.equal(progress.line, before.anchor.line); assert.equal(progress.offset, before.anchor.offset);
            const resumed = await device();
            await resumed.evaluate(async id => {
                const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                const { cacheKey } = await import('./client/app/modules/api/reader-catalog.js');
                await bookshelf.openBook(cacheKey(id));
            }, id);
            await resumed.waitForFunction(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.currentAnchor?.offset > 0);
            assert.deepEqual((await state(resumed)).anchor, before.anchor);
            // Repeated completion opens the same saved card including the reader's writing.
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.openCard((await import('./client/app/modules/api/reader-sync.js')).readerSync.current));
            await mobile.waitForSelector('#review-reflection'); await mobile.type('#review-reflection', '纸船读后感，保留我的文字。');
            await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.saveCard());
            const cardId = await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.card.id); assert(cardId);
            await mobile.evaluate(async () => { const { readerReviews: r } = await import('./client/app/modules/features/reader-reviews.js'); r.close(); await r.openCard((await import('./client/app/modules/api/reader-sync.js')).readerSync.current); });
            assert.equal(await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.card.id), cardId);
            assert.equal(await mobile.$eval('#review-reflection', input => input.value), '纸船读后感，保留我的文字。');
            await mobile.screenshot({ path: `/tmp/hals-reader-existing-card-390${suffix}.png` });
            assert.equal((await (await fetch(runtime.url + `/api/archives?bookId=${id}`, { headers: { Authorization: `Bearer ${runtime.token}` } })).json()).length, 1);
            await mobile.evaluate(async () => {
                const { readerReviews: r } = await import('./client/app/modules/features/reader-reviews.js'); r.close();
                const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                p.render(p.chapters.at(-2)[0]); p.move(p.count - 1, false); p.setMenu(false);
            });
            await tap(mobile, 350, 30);
            await mobile.waitForSelector('#reader-finish-suggestion:not([hidden])');
            await mobile.click('[data-action="open-finish-card"]'); await mobile.waitForSelector('#review-reflection');
            await mobile.waitForFunction(async id => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.card?.id === id, {}, cardId);
            assert.equal(await mobile.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.card.id), cardId);
            assert.deepEqual(errors, []); console.log(`screen pagination and single-card acceptance passed at ${prefix || '/'}`);
        } finally { for (const context of contexts) await context.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    }
} finally { await browser.close(); }
