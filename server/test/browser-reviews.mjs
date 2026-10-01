/** Phase-three acceptance with invented data, real UI controls and fresh devices. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startReader } from './smoke.mjs';
import { sampleWorkbook } from './fixtures/review-workbook.mjs';

const source = '第一章\n\n开篇测试段落。\n\n' + Array.from({ length: 100 }, (_, i) => `第${i}段：这是虚构的阅读验收文本，保留上游排版。`).join('\n') + '\n第二章\n结尾测试段落。';
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp(path.join(tmpdir(), 'hals-reviews-browser-'));
        const runtime = await startReader(directory, prefix), contexts = [], errors = [];
        const workbookPath = path.join(directory, '虚构样例.xlsx'); await writeFile(workbookPath, await sampleWorkbook());
        const api = async (endpoint, options = {}) => {
            const response = await fetch(runtime.url + '/api' + endpoint, { ...options,
                headers: { ...options.headers, Authorization: `Bearer ${runtime.token}` } });
            assert(response.ok, `${endpoint}: ${response.status}`); return response.json();
        };
        const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        async function device(mobile = false) {
            const context = await browser.createBrowserContext(); contexts.push(context);
            const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => dialog.accept());
            if (mobile) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
            else await page.setViewport({ width: 1280, height: 900 });
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForFunction(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.initialized);
            await page.evaluate(() => { if (window.Swal?.isVisible()) window.Swal.close(); });
            return page;
        }
        async function upload(page, text, filename) {
            await page.evaluate(async ({ text, filename }) => {
                const { FileHandler } = await import('./client/app/modules/file/file-handler.js');
                await FileHandler.handleSelectedFile([new File([text], filename, { type: 'text/plain' })]);
            }, { text, filename });
            await page.waitForSelector('#reader-review-toolbar [data-action="finish"]:not([hidden])');
            return page.evaluate(async () => (await import('./client/app/modules/api/reader-sync.js')).readerSync.current);
        }
        async function archive(page) {
            await page.click('#reader-review-toolbar [data-action="archive"]');
            await page.waitForSelector('#reader-archive-list .reader-archive-item');
        }
        async function chooseImport(page) {
            await (await page.$('#reader-archive-import')).uploadFile(workbookPath);
            await page.waitForSelector('.reader-import-table tr[data-row="3"]');
        }
        async function readingTypography(page) {
            return page.$eval('#line3', element => {
                const style = getComputedStyle(element);
                return Object.fromEntries(['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'textIndent', 'margin', 'padding', 'width'].map(key => [key, style[key]]));
            });
        }
        try {
            const page = await device();
            const bookId = await upload(page, source, '测试书.[测试作者].txt');
            assert.equal((await api(`/books/${bookId}/stats`)).startedAt, null, 'opening alone is not reading');
            await page.evaluate(async () => (await import('./client/app/modules/features/reader.js')).reader.gotoLine(3, false));
            const originalTypography = await readingTypography(page);
            await page.click('#line3');
            await new Promise(resolve => setTimeout(resolve, 1100));
            await page.click('#reader-review-toolbar [data-action="finish"]');
            await page.waitForSelector('#review-title');
            assert.equal(await page.$eval('#review-title', input => input.value), '测试书');
            assert.equal(await page.$eval('#review-author', input => input.value), '测试作者');
            const stats = await api(`/books/${bookId}/stats`); assert(stats.readingMs >= 1000); assert(stats.startedAt); assert(stats.wordCount > 0);
            assert.equal((await api('/archives')).length, 0, 'opening a finish card does not mark complete');
            await page.select('#review-background', '现代');
            await page.click('input[name="modern"][value="娱乐圈"]');
            await page.select('#review-background', '古代');
            assert.equal(await page.$eval('input[name="modern"][value="娱乐圈"]', input => input.checked), false);
            await page.click('input[name="ancient"][value="修仙"]');
            await page.select('#review-rating', '踩我雷点 滚'); await page.select('#review-platform', '长佩');
            await page.type('#review-extraTags', '手写 标签,第三'); await page.type('#review-reflection', '人类先写的感想');
            await api(`/books/${bookId}/notes`, { method: 'POST', ...json({ line: 3, text: '给起草的虚构批注' }) });
            await page.click('[data-action="request-draft"]');
            await page.waitForFunction(async () => Boolean((await import('./client/app/modules/features/reader-reviews.js')).readerReviews.draftRequest));
            const requestId = await page.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.draftRequest.requestId);
            const queue = await api('/handoff?unread=1'); assert.equal(queue.items[0].type, 'draft_request');
            assert(queue.items[0].payload.notes.some(note => note.text === '给起草的虚构批注'));
            await page.type('#review-reflection', '，等待时继续修改');
            await api(`/books/${bookId}/review-draft`, { method: 'POST', ...json({ requestId, draft: '小克返回的独立草稿' }) });
            await page.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.refreshDraft());
            await page.waitForSelector('[data-action="adopt-draft"]');
            assert.equal(await page.$eval('#review-reflection', input => input.value), '人类先写的感想，等待时继续修改');
            await page.click('[data-action="adopt-draft"]'); await page.type('#review-reflection', '，读者修改后保存');
            await page.click('[data-action="save-review"]');
            await page.waitForFunction(() => document.querySelector('.reader-review-status').textContent === '记录已保存');
            let records = await api('/archives'), manual = records.find(record => record.source === 'manual');
            assert.equal(manual.reflection, '小克返回的独立草稿，读者修改后保存'); assert(manual.tags.includes('踩我雷点 滚'));
            assert.equal((await api(`/books/${bookId}/review-draft?archiveId=${manual.id}`)).requestId, requestId, 'saving attaches the new-card draft');
            await page.screenshot({ path: '/tmp/hals-phase3-card.png' });
            await page.click('[data-action="close"]');
            assert.deepEqual(await readingTypography(page), originalTypography, 'editing reviews must preserve reading typography and dimensions');
            await page.evaluate(async () => {
                const { reader } = await import('./client/app/modules/features/reader.js');
                const config = await import('./client/app/config/index.js'); reader.gotoPage(config.VARS.TOTAL_PAGES, 'bottom');
            });
            await page.click('#content p:last-of-type');
            await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.checkEnd(); });
            await page.waitForSelector('#reader-finish-suggestion:not([hidden])');
            await page.click('[data-action="dismiss-finish"]'); assert.equal((await api('/archives')).length, 1);
            await archive(page);
            await page.select('#archive-platform', '番茄');
            await page.waitForFunction(() => !document.querySelector('.reader-archive-item'));
            await page.select('#archive-platform', '长佩');
            await page.waitForSelector('.reader-archive-item'); await page.select('#archive-mode', 'tag');
            await page.waitForSelector('[data-tag="踩我雷点 滚"]'); await page.click('[data-tag="踩我雷点 滚"]');
            assert.equal(await page.$$eval('.reader-archive-item', items => items.length), 1);
            await page.select('#archive-platform', ''); await page.select('#archive-mode', 'book');
            await chooseImport(page);
            assert.equal((await api('/archives')).length, 1, 'preview must not import');
            const importedFields = await page.evaluate(async () => (await import('./client/app/modules/features/reader-reviews.js')).readerReviews.importPreview.rows[0].record.fields);
            assert.equal(importedFields.characters, '虚构主角'); assert.equal(importedFields.rating, '值得多刷');
            assert.equal(importedFields.platform, '晋江'); assert.equal(importedFields.completed, '已看完');
            assert.deepEqual(importedFields.ancient, ['修仙', '武侠江湖']);
            assert(await page.$('.reader-import-table tr[data-row="3"].warning'));
            assert.equal(await page.$eval('.reader-import-table tr[data-row="4"] input', input => input.disabled), true);
            assert.equal(await page.$eval('.reader-import-table tr[data-row="5"] input', input => input.disabled), true);
            await page.click('[data-action="confirm-import"]');
            await page.waitForFunction(() => document.querySelector('.reader-review-status').textContent.includes('已导入 2 条'));
            records = await api('/archives'); assert.equal(records.length, 3);
            const orphan = records.find(record => record.title === '未上传书');
            assert.equal(await page.$(`.reader-archive-item[data-record-id="${orphan.id}"] [data-action="read-book"]`), null);
            await page.click(`.reader-archive-item[data-record-id="${orphan.id}"] [data-action="edit-record"]`);
            await page.waitForSelector('#review-title'); assert.equal(await page.$eval('#review-title', input => input.value), '未上传书');
            assert(await page.$('.reader-review-warning')); assert.equal(await page.$eval('[data-action="request-draft"]', input => input.disabled), true);
            await page.click('[data-action="back-archive"]'); await page.waitForSelector('#reader-archive-import');
            await writeFile(workbookPath, await sampleWorkbook({ extraColumns: true }));
            await chooseImport(page); assert.equal(await page.$eval('[data-action="confirm-import"]', input => input.disabled), true);
            const unknownColumn = await page.$eval('.reader-import-table tr[data-row="2"]', row => ({ warning: row.classList.contains('warning'), text: row.textContent }));
            assert(unknownColumn.warning); assert(unknownColumn.text.includes('保留测试列')); assert(unknownColumn.text.includes('未识别表头'));
            await page.click('[data-action="cancel-import"]'); await page.click('[data-action="close"]');
            const laterId = await upload(page, '第一章\n\n晚到的原文内容。', '未上传书.[原作者].txt');
            await page.waitForSelector('#reader-archive-links:not([hidden])'); assert.equal((await api(`/archives/${orphan.id}`)).bookId, null);
            await page.click('[data-action="link-archives"]');
            await page.waitForFunction(() => document.querySelector('#reader-archive-links').hidden);
            assert.equal((await api(`/archives/${orphan.id}`)).bookId, laterId);
            await archive(page); await page.click(`.reader-archive-item[data-record-id="${manual.id}"] [data-action="delete-record"]`);
            await page.waitForFunction(id => !document.querySelector(`.reader-archive-item[data-record-id="${id}"]`), {}, manual.id);
            assert.equal((await api('/archives')).length, 2);
            const mobile = await device(true); await archive(mobile);
            await mobile.click(`.reader-archive-item[data-record-id="${orphan.id}"] [data-action="edit-record"]`);
            await mobile.waitForSelector('#review-title');
            const layout = await mobile.$eval('.reader-review-dialog', element => {
                const rect = element.getBoundingClientRect(); return { width: rect.width, left: rect.left, right: rect.right, viewport: visualViewport.width };
            });
            assert(layout.left >= 0 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
            await mobile.select('#review-background', '架空(衍生)');
            await mobile.waitForFunction(() => document.querySelector('input[name="fanfiction"]').getClientRects().length > 0);
            await mobile.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
            assert.equal(await mobile.$eval('.reader-review-dialog', element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
            await mobile.screenshot({ path: '/tmp/hals-phase3-mobile.png' });
            await page.select('#archive-layout', 'table');
            await page.waitForSelector('.reader-archive-table');
            assert((await page.$eval('.reader-archive-table', table => table.textContent)).includes('视角 / 关系'));
            await page.select('#archive-layout', 'cards');
            await page.waitForSelector('.reader-archive-grid');
            const samples = [
                { title: '折纸星河', rating: '值得多刷', perspective: '主受', relationship: '1v1', background: '未来', future: ['星际', 'ABO'], style: ['青梅竹马', '暗恋酸涩'], extraTags: '久别重逢 双向救赎,星际冒险' },
                { title: '雾色回廊', rating: '可圈可点', perspective: '女主', relationship: '无cp', background: '古代', ancient: ['朝堂权谋'], style: ['论坛体'], extraTags: '悬疑 破案,群像' },
                { title: '城市慢车', rating: '文荒可看', perspective: '双视角', relationship: '1v1', background: '现代', modern: ['职场'], style: ['小甜饼', '天降'], extraTags: '日常 治愈' },
                { title: '远山来信', rating: '看不下去', perspective: '主攻', relationship: 'np', background: '古代', ancient: ['武侠江湖'], style: ['追妻火葬场'], extraTags: '节奏缓慢' },
                { title: '月下空城', rating: '踩我雷点 滚', perspective: '男主', relationship: '1v1', background: '现代', modern: ['豪门'], style: ['替身/白月光'], extraTags: '误会过多' },
            ];
            await page.evaluate(async samples => {
                const { readerReviews } = await import('./client/app/modules/features/reader-reviews.js');
                for (const [index, sample] of samples.entries()) {
                    const { title, ...fields } = sample;
                    await readerReviews.json('/archives', { title, author: `虚构作者${index + 1}`, finishedAt: '2026-09-20',
                        fields: { ...fields, platform: '晋江', completed: '已看完' } });
                }
                await readerReviews.loadArchive();
            }, samples);
            const visibleFields = await page.$eval('.reader-archive-grid', grid => grid.textContent);
            for (const value of ['主受', '1v1', 'ABO', '青梅竹马', '久别重逢']) assert(visibleFields.includes(value), `${value} should be visible without opening the editor`);
            async function assertRatingColors(page, theme) {
                // Read one live DOM snapshot: a pending filter response can
                // replace cards between Puppeteer's query and $$eval callback.
                const badges = await page.evaluate(theme => {
                    document.documentElement.setAttribute('data-theme', theme);
                    return [...document.querySelectorAll('.reader-archive-grid .reader-rating-badge')].map(element => ({ text: element.textContent, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
                }, theme);
                const ratings = samples.map(sample => badges.find(badge => badge.text === sample.rating));
                assert(ratings.every(Boolean)); assert.equal(new Set(ratings.map(badge => badge.color)).size, 5, `ratings need distinct colors in ${theme} mode: ${JSON.stringify(ratings)}`);
                assert.notEqual(ratings[0].background, ratings[1].background, 'the highest rating needs a more prominent fill');
            }
            await assertRatingColors(page, 'dark');
            await page.screenshot({ path: '/tmp/hals-archive-cards-dark.png' });
            await page.click('.reader-archive-chips.style [data-filter-tag="青梅竹马"]');
            assert.equal(await page.$$eval('.reader-archive-item', items => items.length), 1);
            assert.equal(await page.$eval('#archive-mode', select => select.value), 'tag');
            await page.click('[data-action="clear-tag"]'); await page.select('#archive-mode', 'book');
            await assertRatingColors(page, 'light'); await page.screenshot({ path: '/tmp/hals-archive-cards-light.png' });
            await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
            await page.select('#archive-layout', 'table'); await page.waitForSelector('.reader-archive-table');
            assert.equal(await page.$$eval('.reader-archive-table .reader-rating-badge', badges => badges.length), 7);
            await page.screenshot({ path: '/tmp/hals-archive-table.png' });
            await mobile.click('[data-action="close"]'); await archive(mobile);
            await mobile.select('#archive-layout', 'table');
            const mobileTable = await mobile.$eval('.reader-archive-table-wrap', wrapper => ({ scroll: wrapper.scrollWidth, width: wrapper.clientWidth, dialogScroll: wrapper.closest('.reader-review-dialog').scrollWidth, dialogWidth: wrapper.closest('.reader-review-dialog').clientWidth }));
            assert(mobileTable.scroll > mobileTable.width, 'wide tables should scroll inside their own region');
            assert(mobileTable.dialogScroll <= mobileTable.dialogWidth + 1, 'the mobile review dialog must not overflow horizontally');
            await mobile.select('#archive-layout', 'cards'); await mobile.screenshot({ path: '/tmp/hals-archive-mobile.png' });
            assert.deepEqual(errors, []); console.log(`Phase-three browser acceptance passed at ${prefix || '/'}`);
        } finally { await Promise.all(contexts.map(context => context.close())); await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    }
} finally { await browser.close(); }
