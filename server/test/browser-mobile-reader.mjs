/** Narrow reading acceptance uses real 390px touch controls and invented text. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import { startReader } from './smoke.mjs';

const source = '第一章 夜航\n\n' + Array.from({ length: 150 }, (_, index) =>
    `第${index}段：纸船沿着河流慢慢漂远，岸边的灯光映在水上。秋舟记录了这一晚，也留下清晰的阅读段落。`).join('\n') +
    '\n第二章 清晨\n' + 'LongUnbrokenReadingText'.repeat(30) + '\n新的一天开始了。';
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp('/tmp/hals-mobile-reader-');
        const runtime = await startReader(directory, prefix), contexts = [], errors = [];
        const suffix = prefix ? '-subpath' : '';
        async function device(mobile) {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { width: 1280, height: 900 });
            await page.evaluateOnNewDocument(() => {
                localStorage.setItem('show_toc', 'true');
                localStorage.setItem('sidebar-splitview-toc-width', '32');
            });
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForFunction(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.initialized);
            await page.evaluate(() => { if (window.Swal?.isVisible()) window.Swal.close(); });
            return page;
        }
        async function opening(page, id) {
            await page.evaluate(async ({ id, source }) => {
                if (id) {
                    const { bookshelf } = await import('./client/app/modules/features/bookshelf.js');
                    const { cacheKey } = await import('./client/app/modules/api/reader-catalog.js');
                    if (!await bookshelf.openBook(cacheKey(id))) throw new Error('Book failed to open');
                } else {
                    const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                    await FileHandler.handleSelectedFile([new File([source], '《纸船夜航》by秋舟.txt', { type: 'text/plain' })]);
                }
                (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false);
            }, { id, source });
            await page.waitForSelector('#content p[id^="line"]');
            await page.waitForSelector('.reader-note-marker');
            await page.evaluate(() => document.fonts.ready);
        }
        async function typography(page) {
            return page.evaluate(() => Object.fromEntries(['#content', '#content p[id^="line"]', '#content h2', '.sidebar-splitview-container'].map(selector => {
                const style = getComputedStyle(document.querySelector(selector));
                return [selector, Object.fromEntries(['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'textIndent', 'width', 'margin', 'padding', 'columnCount', 'gridTemplateColumns'].map(key => [key, style[key]]))];
            })));
        }
        async function fit(page) {
            const layout = await page.evaluate(() => {
                const rect = selector => {
                    const box = document.querySelector(selector).getBoundingClientRect();
                    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
                };
                const content = document.querySelector('#content'), overflow = [];
                for (const paragraph of content.querySelectorAll('p[id^="line"], h2')) {
                    const range = document.createRange(); range.selectNodeContents(paragraph);
                    for (const fragment of range.getClientRects()) if (fragment.left < -1 || fragment.right > 391) overflow.push(paragraph.id);
                }
                return { width: innerWidth, viewport: visualViewport.width, documentWidth: document.documentElement.scrollWidth, bodyClass: document.body.className,
                    content: rect('#content'), toolbar: rect('#reader-review-toolbar'), pagination: rect('#pagination'), footer: rect('#main-btn-wrapper'),
                    columns: getComputedStyle(content).columnCount, contentWidth: content.clientWidth, contentScroll: content.scrollWidth, overflow };
            });
            assert.equal(layout.width, 390); assert.equal(layout.viewport, 390);
            assert(layout.documentWidth <= 390, JSON.stringify(layout));
            assert(layout.content.left >= 0 && layout.content.right <= 390, JSON.stringify(layout));
            assert(layout.contentScroll <= layout.contentWidth + 1, JSON.stringify(layout));
            assert.equal(layout.columns, '1'); assert.deepEqual(layout.overflow, []);
            assert(layout.toolbar.bottom <= layout.content.top, `top actions must occupy their own space: ${JSON.stringify(layout)}`);
            assert(layout.content.bottom <= layout.pagination.top, 'pagination must have space below the text');
            assert(layout.pagination.bottom <= layout.footer.top + 1, 'footer controls must fit below pagination');
            assert.equal(await page.$eval('.sidebar-splitview-sidebar', sidebar => getComputedStyle(sidebar).visibility), 'hidden');
            assert.equal(await page.$$eval('.reader-note-marker:not(.has-notes)', markers => markers.filter(marker => marker.getClientRects().length).length), 0);
        }
        async function tap(page, selector) {
            const point = await page.$eval(selector, node => {
                const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            });
            await page.touchscreen.tap(point.x, point.y);
        }
        try {
            const desktop = await device(false); await opening(desktop);
            const id = await desktop.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
            const original = await typography(desktop);
            assert.equal(await desktop.$eval('#reader-mobile-toolbar', toolbar => getComputedStyle(toolbar).display), 'none');
            await desktop.setViewport({ width: 390, height: 844 }); await fit(desktop);
            await desktop.setViewport({ width: 1280, height: 900 });
            await desktop.waitForFunction(() => getComputedStyle(document.querySelector('#reader-mobile-toolbar')).display === 'none');
            assert.deepEqual(await typography(desktop), original, 'returning to desktop must restore the exact typography and layout');
            assert.equal(await desktop.evaluate(() => localStorage.getItem('sidebar-splitview-toc-width')), '32');

            const mobile = await device(true); await opening(mobile, id); await fit(mobile);
            await mobile.screenshot({ path: `/tmp/hals-reader-mobile-390${suffix}.png` });
            await tap(mobile, '#reader-mobile-toc-toggle');
            await mobile.waitForFunction(() => document.querySelector('#reader-mobile-toc-toggle').getAttribute('aria-expanded') === 'true');
            const drawer = await mobile.$eval('.sidebar-splitview-sidebar', node => {
                const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, visibility: getComputedStyle(node).visibility };
            });
            assert.equal(drawer.visibility, 'visible'); assert(drawer.left >= 0 && drawer.right <= 390);
            const chapterRows = await mobile.$$eval('#toc-content .chapter-title-container', rows => rows.map(row => row.getBoundingClientRect().top));
            assert(new Set(chapterRows).size === chapterRows.length, 'virtual chapter rows must retain distinct positions when initially collapsed');
            await mobile.screenshot({ path: `/tmp/hals-reader-mobile-toc-390${suffix}.png` });
            const chapter = await mobile.evaluate(() => [...document.querySelectorAll('#toc-content a.toc-text:not(.hidden)')].find(link => link.textContent.includes('第二章'))?.id);
            assert(chapter, 'the drawer must show chapter titles without hover');
            await tap(mobile, `#${chapter}`);
            await mobile.waitForFunction(() => document.querySelector('#reader-mobile-toc-toggle').getAttribute('aria-expanded') === 'false');
            await mobile.waitForFunction(() => [...document.querySelectorAll('#content h2')].some(node => node.textContent.includes('第二章')));
            await fit(mobile);
            assert.equal(await mobile.evaluate(() => localStorage.getItem('sidebar-splitview-toc-width')), '32', 'the mobile drawer must not replace the saved desktop width');
            await mobile.evaluate(async () => { (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false); });
            const paragraph = await mobile.evaluate(() => {
                const bounds = document.querySelector('#content').getBoundingClientRect();
                return [...document.querySelectorAll('#content p[id^="line"]')].find(node => {
                    const rect = node.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
                })?.id;
            });
            assert(paragraph); await tap(mobile, `#${paragraph}`);
            await mobile.waitForSelector('#reader-paragraph-menu:not([hidden])', { visible: true });
            const popup = await mobile.$eval('#reader-paragraph-menu', node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
            assert(popup.left >= 0 && popup.right <= 390);
            await mobile.screenshot({ path: `/tmp/hals-reader-mobile-note-390${suffix}.png` });
            await tap(mobile, '#reader-paragraph-menu button'); await mobile.waitForSelector('#reader-note-thread:not([hidden]) textarea');
            await mobile.type('#reader-note-thread textarea', '手机点击段落留下的虚构批注');
            await tap(mobile, '#reader-note-thread > button:nth-last-child(3)');
            await mobile.waitForFunction(async id => (await (await fetch(`./api/books/${id}/notes`)).json()).some(note => note.text === '手机点击段落留下的虚构批注'), {}, id);
            await tap(mobile, '#reader-note-thread header button');
            await tap(mobile, `#${paragraph}`); await mobile.waitForSelector('#reader-paragraph-menu:not([hidden])');
            await mobile.evaluate(() => document.querySelector('#content').scrollBy(0, 150));
            await mobile.waitForFunction(() => document.querySelector('#reader-paragraph-menu').hidden);
            await fit(mobile);
            await mobile.evaluate(async () => {
                const CONFIG = await import('./client/app/config/index.js'); CONFIG.CONST_CONFIG.INFINITE_SCROLL_MODE = true;
                const { reader } = await import('./client/app/modules/features/reader.js'); reader.toggleInfiniteScroll(); reader.gotoLine(3, false);
            });
            await fit(mobile);
            await tap(mobile, '#reader-review-toolbar [data-action="archive"]'); await mobile.waitForSelector('#archive-sort');
            await mobile.screenshot({ path: `/tmp/hals-reader-mobile-archive-390${suffix}.png` });
            await tap(mobile, '.reader-review-dialog [data-action="close"]');
            await tap(mobile, '#reader-review-toolbar [data-action="finish"]'); await mobile.waitForSelector('#review-title');
            await tap(mobile, '.reader-review-dialog [data-action="close"]'); await fit(mobile);
            assert.deepEqual(errors, []);
            console.log(`PASS ${prefix || '/'}: 390px text bounds, collapsed chapters, touch annotations, reserved controls, desktop restoration`);
        } finally { await Promise.all(contexts.map(context => context.close())); await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    }
} finally { await browser.close(); }
