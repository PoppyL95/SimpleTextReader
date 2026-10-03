/** 390px touch/desktop acceptance; native Safari menus and keyboards require an iPhone. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { startReader } from './smoke.mjs';
const output = process.env.READER_SCREENSHOTS || '/tmp/hals-reading-polish';
await mkdir(output, { recursive: true });
const source = '第一章 夜航\n\n' + Array.from({ length: 65 }, (_, i) =>
    `河岸第${i + 1}段，晚风轻轻吹过树梢。纸船沿着河流慢慢漂远，岸边灯光映在水上。有人坐在桥头，记录这一晚的风声。` +
    (i % 5 === 0 ? '下一阵风到来时，远处的人挥了挥手。'.repeat(8) : '')).join('\n\n') + '\n第二章 清晨\n天亮了，新的一天从桥下出发。';
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of (process.env.READER_TEST_PREFIX !== undefined ? [process.env.READER_TEST_PREFIX] : ['', '/reader'])) {
        const directory = await mkdtemp('/tmp/hals-reading-polish-'), runtime = await startReader(directory, prefix);
        const errors = [], suffix = prefix ? '-subpath' : '', contexts = [];
        const api = async (endpoint, value) => {
            const response = await fetch(runtime.url + '/api' + endpoint, { method: 'POST', headers: {
                Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
            assert(response.ok); return response.json();
        };
        try {
            for (const mobile of [true, false]) {
                const context = await browser.createBrowserContext(); contexts.push(context);
                const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
                await page.setViewport(mobile ? { width: 390, height: 844, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { width: 1280, height: 900 });
                await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
                await page.waitForFunction(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.initialized);
                await page.evaluate(() => window.Swal?.close());
                await page.evaluate(async ({ source, mobile }) => {
                    const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                    await FileHandler.handleSelectedFile([new File([source + (mobile ? '\n手机' : '\n桌面')], '《纸船夜航》by秋舟.txt', { type: 'text/plain' })]);
                    await (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false);
                    await document.fonts.ready;
                }, { source, mobile });
                const id = await page.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
                const typography = await page.$eval('#content p', p => {
                    const s = getComputedStyle(p); return { color: s.color, size: parseFloat(s.fontSize), leading: parseFloat(s.lineHeight), font: s.fontFamily, indent: s.textIndent };
                });
                if (mobile) {
                    await page.waitForFunction(async () => {
                        const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                        return p.count > 3 && Boolean(p.currentAnchor);
                    });
                    assert.equal(typography.color, 'rgb(163, 154, 144)'); assert(typography.size >= 23);
                    assert(Math.abs(typography.leading / typography.size - 1.85) < .01); assert(typography.font.includes('PingFang SC'));
                    assert.equal(parseFloat(typography.indent), typography.size * 2);
                    assert.equal(await page.$eval('body', b => getComputedStyle(b).backgroundColor), 'rgb(25, 18, 12)');
                    assert.equal(await page.$eval('#content a.title', e => getComputedStyle(e).color), typography.color);
                    const pages = await page.evaluate(async () => {
                        const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                        const results = [];
                        for (let i = 0; i < p.count; i++) {
                            p.move(i, false); const visible = [], view = p.content.getBoundingClientRect();
                            for (const e of p.content.querySelectorAll('p,h2')) {
                                const range = document.createRange(); range.selectNodeContents(e);
                                for (const r of range.getClientRects()) if (r.width && r.right > view.left + 20 && r.left < view.right - 20) visible.push(r.toJSON());
                            }
                            results.push({ page: i, stride: p.stride, scroll: p.content.scrollLeft, visible });
                        }
                        p.move(0, false); return results;
                    });
                    for (const p of pages) {
                        assert(Math.abs(p.scroll - p.page * p.stride) < 1, JSON.stringify(p));
                        for (const r of p.visible) assert(r.left >= 19 && r.right <= 371, `page ${p.page}: ${JSON.stringify(r)}`);
                    }
                    for (const [label, index] of [['first', 0], ['middle', Math.floor(pages.length / 2)], ['last', pages.length - 1]]) {
                        await page.evaluate(async i => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.move(i, false), index);
                        await page.screenshot({ path: `${output}/reading-${label}-390${suffix}.png` });
                    }
                    assert.equal(await page.$eval('#pagination', e => getComputedStyle(e).display), 'none');
                    assert.match(await page.$eval('#reader-mobile-chapter', e => e.textContent), /第一章/);
                    assert.match(await page.$eval('#reader-mobile-reading-footer time', e => e.textContent), /^\d{2}:\d{2}$/);
                    assert.match(await page.$eval('#reader-mobile-reading-footer span', e => e.textContent), /^\d+\.\d{2} %$/);
                    assert.equal(await page.$eval('#reader-mobile-reading-footer', e => getComputedStyle(e).borderTopWidth), '0px');
                    await writeFile(`${output}/geometry${suffix}.json`, JSON.stringify({ typography, pages: pages.map(p => ({ page: p.page, scroll: p.scroll, stride: p.stride })) }, null, 2));
                    // Use the actual theme dropdown, then verify real failure and acknowledged retry.
                    await page.evaluate(async () => (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.setMenu(true));
                    await page.click('#setting-btn'); await page.click('#setting-tab-theme');
                    await page.click('#setting_mobile_reading_theme + .select-styled');
                    await page.click('#setting_mobile_reading_theme ~ .select-options li[rel="original"]');
                    await page.waitForFunction(() => document.documentElement.dataset.readerMobileTheme === 'original');
                    await page.click('#setting_mobile_reading_theme + .select-styled');
                    await page.click('#setting_mobile_reading_theme ~ .select-options li[rel="warm-brown"]');
                    await page.keyboard.press('Escape');
                    await page.waitForFunction(() => getComputedStyle(document.querySelector('#settings-menu')).display === 'none');
                    await page.evaluate(async () => {
                        const { readerSync: s } = await import('./client/app/modules/api/reader-sync.js');
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
                        (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.move(1);
                        clearTimeout(s.timer);
                    });
                    assert(await page.$eval('#reader-sync-status', e => e.hidden), 'debounce is quiet');
                    await page.evaluate(() => {
                        window.readerAcceptanceFetch = window.fetch;
                        window.fetch = (url, options) => options?.method === 'PUT' && String(url).endsWith('/progress')
                            ? Promise.resolve(new Response('{}', { status: 503 })) : window.readerAcceptanceFetch(url, options);
                    });
                    await page.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.flush());
                    assert.equal(await page.evaluate(async () => Object.keys((await import('./client/app/modules/api/reader-sync.js')).readerSync.failures).length), 1);
                    assert(await page.$eval('#reader-sync-status', e => e.hidden), 'fresh failure is quiet');
                    await page.evaluate(async () => {
                        const { readerSync: s } = await import('./client/app/modules/api/reader-sync.js');
                        for (const key of Object.keys(s.failures)) s.failures[key] -= 31000;
                        s.persist();
                    });
                    const dot = await page.$eval('#reader-sync-status', e => ({ hidden: e.hidden, text: e.textContent, width: e.getBoundingClientRect().width, border: getComputedStyle(e).borderTopWidth, label: e.getAttribute('aria-label') }));
                    assert(!dot.hidden && dot.width === 6 && dot.border === '0px' && dot.text === '' && dot.label.includes('尚未同步'));
                    await page.evaluate(() => { window.fetch = window.readerAcceptanceFetch; delete window.readerAcceptanceFetch; });
                    await page.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.retry());
                    assert(await page.$eval('#reader-sync-status', e => e.hidden));
                } else {
                    assert.notEqual(typography.color, 'rgb(163, 154, 144)');
                    assert.equal(await page.$eval('#reader-mobile-reading-footer', e => getComputedStyle(e).display), 'none');
                    await page.screenshot({ path: `${output}/reading-desktop${suffix}.png` });
                }
                const root = await page.evaluate(async id => {
                    const { readerSync: s } = await import('./client/app/modules/api/reader-sync.js');
                    return (await s.request(`/books/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 3, text: '读者的主批注：今晚的风很轻。' }) })).json();
                }, id);
                const longReply = await api(`/books/${id}/notes`, { parentId: root.id, text: '小克的长回复，折叠后才能完整展开。'.repeat(25) });
                await page.evaluate(async ({ id, root }) => {
                    const { readerSync: s } = await import('./client/app/modules/api/reader-sync.js');
                    await s.request(`/books/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId: root.id, text: '读者的楼中楼回复。' }) });
                }, { id, root });
                await api(`/books/${id}/notes`, { line: 51, text: '小克的主批注：这一段写得有趣。' });
                await page.evaluate(async () => {
                    (await import('./client/app/modules/features/reader-page-turn.js')).mobilePaging.setMenu(true);
                    await (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.refresh();
                });
                await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
                if (mobile) {
                    assert.equal(await page.$eval('#reader-all-notes-button', e => e.textContent), '批注');
                    const nav = await page.evaluate(() => ({ notes: document.querySelector('#reader-all-notes-button').getBoundingClientRect().toJSON(), reviews: document.querySelector('#reader-review-toolbar').getBoundingClientRect().toJSON() }));
                    assert(nav.notes.left >= nav.reviews.right && nav.notes.right <= 390, JSON.stringify(nav));
                    await page.screenshot({ path: `${output}/reading-toolbar-390${suffix}.png` });
                }
                await page.click('#reader-all-notes-button'); await page.waitForSelector('.reader-all-note');
                assert.equal(await page.$$eval('.reader-all-note', n => n.length), 2);
                assert.equal(await page.$('.reader-note-reply'), null);
                assert.match(await page.$eval('.reader-reply-count', n => n.textContent), /2 条回复/);
                await page.screenshot({ path: `${output}/notes-collapsed-${mobile ? '390' : 'desktop'}${suffix}.png` });
                const rootSelector = `.reader-all-note[data-note-id="${root.id}"]`;
                await page.click(rootSelector + ' .reader-all-note-toggle');
                assert.equal(await page.$$eval('.reader-note-reply', n => n.length), 2);
                assert.equal(await page.$eval('.reader-note-reply details', e => e.open), false);
                await page.screenshot({ path: `${output}/notes-expanded-${mobile ? '390' : 'desktop'}${suffix}.png` });
                await page.click('.reader-note-reply summary');
                assert.equal(await page.$eval('.reader-note-reply details', e => e.open), true);
                await page.evaluate(async () => (await import('./client/app/modules/features/reader-annotations.js')).readerAnnotations.renderAllNotes());
                assert.equal(await page.$eval('.reader-note-reply details', e => e.open), true, 'polling preserves long reply expansion');
                await page.click(rootSelector + ' .reader-all-note-toggle'); assert.equal(await page.$('.reader-note-reply'), null);
                await page.click('[data-filter="hals"]'); await page.click(rootSelector + ' .reader-all-note-toggle');
                assert.equal(await page.$$eval('.reader-note-reply', n => n.length), 1);
                assert.equal(await page.$eval('.reader-note-reply', n => Number(n.dataset.noteId)), longReply.id);
                await page.click('[data-filter="unread"]'); assert.equal(await page.$$eval('.reader-note-reply', n => n.length), 1);
                const fit = await page.$eval('#reader-all-notes', e => ({ width: e.scrollWidth, client: e.clientWidth, right: e.getBoundingClientRect().right }));
                assert(fit.width <= fit.client && fit.right <= (mobile ? 390 : 1280));
                await page.screenshot({ path: `${output}/notes-nested-${mobile ? '390' : 'desktop'}${suffix}.png` });
                await page.click('.reader-all-note:last-child .reader-note-jump');
                assert(await page.$eval('#reader-all-notes', e => e.hidden));
                assert(await page.$eval('#reader-note-thread', e => e.hidden), 'jump must not open the thread');
                assert(await page.evaluate(async () => {
                    const { readerSync: s } = await import('./client/app/modules/api/reader-sync.js');
                    const { mobilePaging: p } = await import('./client/app/modules/features/reader-page-turn.js');
                    const e = document.getElementById(`line${s.maps.get(s.current).toRendered(51)}`);
                    if (p.active) return Boolean(p.visibleRect(e));
                    const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight;
                }));
                await context.close(); console.log(`${mobile ? '390px touch' : 'Desktop'} reading polish passed at ${prefix || '/'}`);
            }
            assert.deepEqual(errors, []);
        } finally {
            for (const context of contexts) if (!context.closed) await context.close();
            await runtime.stop(); await rm(directory, { recursive: true, force: true });
        }
    }
} finally { await browser.close(); }
