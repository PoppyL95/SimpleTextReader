/** Compact shelf acceptance with invented books and real touch devices. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp, rm } from 'node:fs/promises';
import { startReader } from './smoke.mjs';

const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: true, args: ['--no-sandbox'] });
try {
    for (const prefix of ['', '/reader']) {
        const directory = await mkdtemp('/tmp/hals-mobile-shelf-');
        const runtime = await startReader(directory, prefix);
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            for (let index = 0; index < 12; index++) {
                const filename = `《${index === 4 ? '很长很长的书名用于检查两行展示' : '纸船夜航'}${index}》by秋舟.txt`;
                const response = await fetch(runtime.url + '/api/books?filename=' + encodeURIComponent(filename), {
                    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'text/plain' },
                    body: `第一章\n\n虚构书架文本${index}。\n\n第二段正文。` });
                assert.equal(response.status, 201);
            }
            await page.setViewport({ width: 1280, height: 900 });
            await page.goto(runtime.url + '/', { waitUntil: 'networkidle2' });
            await page.waitForSelector('.bookshelf .book');
            if (await page.$('.swal2-confirm')) await page.click('.swal2-confirm');
            const desktop = await page.$eval('.book .cover-container', cover => ({ width: cover.clientWidth, height: cover.clientHeight }));
            for (const width of [320, 390, 600]) {
                await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                await page.waitForSelector('.bookshelf .book');
                const layout = await page.evaluate(() => {
                    const list = document.querySelector('.bookshelf .booklist');
                    const books = [...list.querySelectorAll('.book')].slice(0, 6).map(book => {
                        const rect = book.getBoundingClientRect();
                        return { x: rect.x, y: rect.y, right: rect.right, width: rect.width };
                    });
                    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
                        columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
                        books, listWidth: list.clientWidth, listScroll: list.scrollWidth };
                });
                assert.equal(layout.columns, 3); assert.equal(layout.width, width);
                assert(layout.documentWidth <= width && layout.listScroll <= layout.listWidth);
                assert.equal(layout.books[0].y, layout.books[2].y); assert(layout.books[3].y > layout.books[0].y);
                assert(layout.books.every(book => book.x >= 0 && book.right <= width));
                await page.screenshot({ path: `/tmp/hals-bookshelf-${width}${prefix ? '-subpath' : ''}.png` });
            }
            await page.setViewport({ width: 1280, height: 900 });
            await page.waitForSelector('.bookshelf .book');
            assert.deepEqual(await page.$eval('.book .cover-container', cover => ({ width: cover.clientWidth, height: cover.clientHeight })), desktop);
            assert.equal(await page.$eval('.book-mobile-caption', caption => getComputedStyle(caption).display), 'none');
            await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
            await page.waitForSelector('.bookshelf .book');
            await page.click('.booklist-filter-btn:last-child');
            assert.equal(await page.$$eval('.book', books => books.filter(book => book.getClientRects().length).length), 0);
            await page.click('.booklist-filter-btn:first-child');
            assert.equal(await page.$$eval('.book', books => books.filter(book => book.getClientRects().length).length), 12);
            await page.click('.bookinfo-menu-btn label');
            await page.waitForSelector('.bookinfo-menu');
            await page.click('.bookinfo-menu-btn label');
            await page.tap('.book .cover-container');
            await page.waitForSelector('#content p[id^="line"]');
            assert.deepEqual(errors, []);
            console.log(`Compact mobile bookshelf passed at ${prefix || '/'}`);
        } finally { await page.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); }
    }
} finally { await browser.close(); }
