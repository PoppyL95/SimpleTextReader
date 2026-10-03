import { mobilePaging } from "./reader-page-turn.js";
/** Server-backed annotations. Original coordinates never depend on pagination or margin UI. */
import * as CONFIG from '../../config/index.js';
import { readerSync } from '../api/reader-sync.js';
import { selectionQuote } from '../../../../shared/core/reader/coordinates.js';
import { isNarrowReader } from './reader-mobile.js';

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(text, action) {
    const node = element('button', text); node.type = 'button';
    node.addEventListener('click', action); return node;
}
function textPoint(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        last = node;
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
    }
    return last ? [last, last.length] : [root, 0];
}
function textRange(root, start, end) {
    const range = document.createRange();
    range.setStart(...textPoint(root, start)); range.setEnd(...textPoint(root, end)); return range;
}
function viewport() {
    const view = window.visualViewport;
    return { left: view?.offsetLeft || 0, top: view?.offsetTop || 0,
        width: view?.width || document.documentElement.clientWidth,
        height: view?.height || document.documentElement.clientHeight };
}

class ReaderAnnotations {
    init() {
        if (this.initialized || !readerSync.active) return;
        this.initialized = true; this.notes = []; this.bookId = null; this.revision = 0;
        this.content = CONFIG.DOM_ELEMENT.CONTENT_CONTAINER;
        this.menu = element('div', null, 'reader-note-ui'); this.menu.id = 'reader-selection-menu'; this.menu.hidden = true;
        this.menu.setAttribute('role', 'toolbar'); this.menu.setAttribute('aria-label', '选中文字操作');
        this.paragraphMenu = element('div', null, 'reader-note-ui'); this.paragraphMenu.id = 'reader-paragraph-menu'; this.paragraphMenu.hidden = true;
        this.paragraphMenu.setAttribute('role', 'toolbar'); this.paragraphMenu.setAttribute('aria-label', '段落批注操作');
        this.paragraphMenu.append(button('添加 / 查看批注', () => {
            if (this.paragraphLine) this.openThread(this.paragraphLine);
            this.paragraphMenu.hidden = true;
        }));
        this.menu.append(button('划线', () => this.saveSelection('highlight')), button('递给小克', () => this.saveSelection('handoff')),
            button('批注', () => { if (this.selection) this.openThread(this.selection.startLine); this.menu.hidden = true; }));
        this.menu.addEventListener('pointerdown', event => {
            // Snapshot the latest handle adjustment before dismissing the native selection bubble.
            this.captureSelection();
            this.interactingSelection = event.pointerType !== 'mouse'; clearTimeout(this.selectionTimer);
            if (event.pointerType === 'mouse') event.preventDefault();
            else window.getSelection().removeAllRanges();
            clearTimeout(this.selectionInteractionTimer);
            this.selectionInteractionTimer = setTimeout(() => { this.interactingSelection = false; this.captureSelection(); }, 400);
        });
        this.markers = element('div'); this.markers.id = 'reader-note-markers';
        this.panel = element('section', null, 'reader-note-ui'); this.panel.id = 'reader-note-thread'; this.panel.hidden = true;
        this.panel.setAttribute('role', 'dialog'); this.panel.setAttribute('aria-label', '页边批注');
        this.allPanel = element('section', null, 'reader-note-ui'); this.allPanel.id = 'reader-all-notes'; this.allPanel.hidden = true;
        this.allPanel.setAttribute('role', 'dialog'); this.allPanel.setAttribute('aria-label', '全部批注');
        this.allButton = button('全部批注', () => this.openAllNotes()); this.allButton.id = 'reader-all-notes-button'; this.allButton.className = 'reader-note-ui'; this.allButton.hidden = true;
        this.notice = element('div', null, 'reader-note-ui'); this.notice.id = 'reader-note-notice'; this.notice.hidden = true;
        this.notice.setAttribute('role', 'status');
        document.body.append(this.menu, this.paragraphMenu, this.markers, this.panel, this.allPanel, this.allButton, this.notice);
        this.content.addEventListener('click', event => this.captureParagraph(event));
        document.addEventListener('reader:paragraph-tap', event => this.captureParagraph(event.detail));
        document.addEventListener('reader:screen-page', () => { this.paragraphMenu.hidden = true; this.menu.hidden = true; this.schedulePosition(); });
        document.addEventListener('reader:page-menu', () => { if (!document.body.classList.contains('reader-page-menu-open')) this.paragraphMenu.hidden = true; this.schedulePosition(); });
        this.content.addEventListener('scroll', () => {
            if (!isNarrowReader()) this.menu.hidden = true; this.paragraphMenu.hidden = true; this.schedulePosition();
        }, { passive: true });
        document.addEventListener('reader:book-opening', () => this.reset());
        document.addEventListener('reader:book-closed', () => this.reset());
        document.addEventListener('reader:book-opened', () => this.openBook());
        document.addEventListener('selectionchange', () => {
            clearTimeout(this.selectionTimer); this.selectionTimer = setTimeout(() => this.captureSelection(), 180);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && (!this.menu.hidden || !this.paragraphMenu.hidden || !this.panel.hidden || !this.allPanel.hidden)) {
                event.preventDefault(); event.stopImmediatePropagation(); this.menu.hidden = true; this.paragraphMenu.hidden = true; this.closeThread(); this.closeAllNotes();
            } else if (this.panel.contains(event.target) || this.menu.contains(event.target) || this.paragraphMenu.contains(event.target) || this.allPanel.contains(event.target)) {
                // Cursor/navigation keys in the editor must not turn the reader's pages.
                event.stopPropagation();
            }
        }, true);
        for (const panel of [this.panel, this.allPanel]) panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        document.addEventListener('pointerdown', event => {
            if (!this.menu.contains(event.target) && !this.content.contains(event.target)) this.menu.hidden = true;
            if (!this.paragraphMenu.contains(event.target)) this.paragraphMenu.hidden = true;
        });
        this.observer = new MutationObserver(() => this.schedulePaint()); this.observe();
        window.addEventListener('scroll', () => {
            if (!isNarrowReader()) this.menu.hidden = true; this.paragraphMenu.hidden = true; this.schedulePosition();
        }, { passive: true });
        window.addEventListener('resize', () => { this.paragraphMenu.hidden = true; this.schedulePosition(); });
        window.visualViewport?.addEventListener('resize', () => this.schedulePosition());
        window.visualViewport?.addEventListener('scroll', () => this.schedulePosition());
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
        // Companion additions arrive without requiring a reload. GET never marks them read.
        setInterval(() => {
            if (!CONFIG.VARS.IS_BOOK_OPENED) this.reset();
            else if (!document.hidden) this.refresh();
        }, 5000);
        if (readerSync.current && !readerSync.suppressed) this.openBook();
    }
    observe() { this.observer.observe(this.content, { childList: true, subtree: true }); }
    reset() {
        this.revision++;
        this.bookId = null; this.notes = []; this.selection = null; this.paragraphLine = null; this.markers?.replaceChildren();
        if (this.menu) this.menu.hidden = true;
        if (this.paragraphMenu) this.paragraphMenu.hidden = true;
        this.closeThread(); this.closeAllNotes(); if (this.allButton) this.allButton.hidden = true; this.clearHighlights();
    }
    openBook() {
        this.reset(); this.bookId = readerSync.current; this.allButton.hidden = !this.bookId; this.refresh(); this.schedulePaint();
    }
    async refresh() {
        const bookId = this.bookId;
        if (!bookId || this.loading === bookId || !CONFIG.VARS.IS_BOOK_OPENED) return;
        this.loading = bookId;
        const revision = this.revision;
        try {
            const notes = await (await readerSync.request(`/books/${bookId}/notes`)).json();
            if (this.bookId !== bookId || this.revision !== revision) return;
            const changed = JSON.stringify(notes) !== JSON.stringify(this.notes);
            this.notes = notes;
            if (changed) {
                this.schedulePaint();
                // Do not mark newly arriving comments read until the reader explicitly opens the thread again.
                if (this.thread) {
                    const previous = this.panel.querySelector('.reader-note-thread-content');
                    if (previous) { const scrollTop = previous.scrollTop, content = this.threadContent(); previous.replaceWith(content); content.scrollTop = scrollTop; }
                }
                if (!this.allPanel.hidden) this.renderAllNotes();
            }
        } catch { /* Keep the last displayed annotations; writes report failures explicitly. */ }
        finally {
            if (this.loading === bookId) this.loading = null;
            if (this.bookId === bookId && this.revision !== revision) this.refresh();
        }
    }
    message(text) {
        const view = viewport(); this.notice.style.left = `${view.left + view.width / 2}px`;
        this.notice.textContent = text; this.notice.hidden = false;
        clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => { this.notice.hidden = true; }, 4500);
    }
    lines() {
        const map = readerSync.maps.get(this.bookId);
        return [...this.content.querySelectorAll('[id^="line"]')].filter(node => map?.source(Number(node.id.slice(4))) && node.textContent);
    }
    captureSelection() {
        if (this.interactingSelection) return;
        if (!this.bookId || readerSync.suppressed || !CONFIG.VARS.IS_BOOK_OPENED) return;
        const selected = window.getSelection();
        if (!selected.rangeCount || selected.isCollapsed) { this.menu.hidden = true; return; }
        this.paragraphMenu.hidden = true;
        const range = selected.getRangeAt(0);
        if (!this.content.contains(range.startContainer) || !this.content.contains(range.endContainer)) { this.menu.hidden = true; return; }
        const map = readerSync.maps.get(this.bookId);
        const points = [];
        for (const node of this.lines()) {
            if (!range.intersectsNode(node)) continue;
            const prefix = document.createRange(); prefix.selectNodeContents(node);
            let start = 0, end = node.textContent.length;
            if (node.contains(range.startContainer)) { prefix.setEnd(range.startContainer, range.startOffset); start = prefix.toString().length; }
            if (node.contains(range.endContainer)) { prefix.selectNodeContents(node); prefix.setEnd(range.endContainer, range.endOffset); end = prefix.toString().length; }
            if (start >= end) continue;
            const renderLine = Number(node.id.slice(4));
            const characters = map.characters(renderLine, node.textContent);
            if (!characters) { this.menu.hidden = true; this.message('这段文字无法对应原文，请改选正文。'); return; }
            points.push({ line: map.toOriginal(renderLine), start: characters[start].start, end: characters[end - 1].end, renderLine });
        }
        if (!points.length) { this.menu.hidden = true; return; }
        const first = points[0], last = points.at(-1);
        const anchor = { startLine: first.line, startOffset: first.start, endLine: last.line, endOffset: last.end };
        const quote = selectionQuote(map.raw, anchor);
        if (!quote || quote.length > 20000) { this.menu.hidden = true; this.message('请选取不超过 20000 字符的片段。'); return; }
        const chapter = [...CONFIG.VARS.ALL_TITLES].reverse().find(title => title[1] <= first.renderLine)?.[0] || '';
        this.selection = { ...anchor, quote, chapter, bookId: this.bookId };
        this.selectionRect = range.getBoundingClientRect(); this.menu.hidden = false; this.positionSelectionMenu();
    }
    positionSelectionMenu() {
        if (this.menu.hidden) return;
        const view = viewport(), rect = this.selectionRect;
        if (isNarrowReader()) {
            this.menu.style.left = `${view.left + 12}px`; this.menu.style.width = `${view.width - 24}px`;
            this.menu.style.top = `${view.top + view.height - this.menu.offsetHeight - 104}px`;
        } else {
            this.menu.style.width = '';
            this.menu.style.left = `${Math.max(view.left + 8, Math.min(rect.left, view.left + view.width - this.menu.offsetWidth - 8))}px`;
            this.menu.style.top = `${Math.max(view.top + 8, Math.min(rect.top - this.menu.offsetHeight - 8, view.top + view.height - this.menu.offsetHeight - 8))}px`;
        }
    }
    captureParagraph(event) {
        if (!isNarrowReader() || !this.bookId || readerSync.suppressed || !CONFIG.VARS.IS_BOOK_OPENED || !window.getSelection().isCollapsed) return;
        if (event.target.closest('a,button,input')) return;
        const paragraph = event.target.closest('p[id^="line"]');
        const source = paragraph && readerSync.maps.get(this.bookId)?.source(Number(paragraph.id.slice(4)));
        if (!source) return;
        this.paragraphLine = source.line; this.paragraphMenu.hidden = false; this.menu.hidden = true;
        const rect = paragraph.getBoundingClientRect(), view = viewport();
        this.paragraphMenu.style.left = `${view.left + view.width - this.paragraphMenu.offsetWidth - 12}px`;
        this.paragraphMenu.style.top = `${Math.max(view.top + 60, Math.min(rect.top - this.paragraphMenu.offsetHeight - 8, view.top + view.height - this.paragraphMenu.offsetHeight - 104))}px`;
    }
    async saveSelection(action) {
        const selection = this.selection;
        if (!selection || selection.bookId !== this.bookId || this.savingSelection) return;
        this.savingSelection = true;
        for (const control of this.menu.querySelectorAll('button')) control.disabled = true;
        try {
            const endpoint = action === 'highlight' ? 'notes' : 'handoff';
            const result = await (await readerSync.request(`/books/${selection.bookId}/${endpoint}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...selection, kind: 'highlight' }) })).json();
            if (selection.bookId === this.bookId) {
                this.revision++;
                if (action === 'highlight') { this.notes.push(result); this.schedulePaint(); }
                this.menu.hidden = true; window.getSelection().removeAllRanges();
            }
            this.message(action === 'highlight' ? '划线已保存' : '已递给小克');
        } catch { this.message('尚未保存：连接失败，请重试。'); }
        finally {
            this.savingSelection = false;
            for (const control of this.menu.querySelectorAll('button')) control.disabled = false;
        }
    }
    schedulePaint() {
        if (this.paintFrame) return;
        this.paintFrame = requestAnimationFrame(() => { this.paintFrame = null; this.paint(); });
    }
    clearHighlights() {
        CSS.highlights?.delete('reader-notes');
        for (const mark of this.content?.querySelectorAll('mark.reader-highlight') || []) mark.replaceWith(...mark.childNodes);
    }
    paint() {
        this.observer.disconnect(); this.clearHighlights(); this.markers.replaceChildren();
        if (!this.bookId || !CONFIG.VARS.IS_BOOK_OPENED) { this.observe(); return; }
        const map = readerSync.maps.get(this.bookId), ranges = [];
        for (const node of this.lines()) {
            const renderLine = Number(node.id.slice(4)), source = map.source(renderLine);
            const characters = map.characters(renderLine, node.textContent);
            if (characters) for (const note of this.notes.filter(note => note.kind === 'highlight' && note.startLine <= source.line && note.endLine >= source.line)) {
                const start = source.line === note.startLine ? note.startOffset : 0;
                const end = source.line === note.endLine ? note.endOffset : map.raw[source.line - 1].length;
                const from = characters.findIndex(char => char.end > start);
                let to = characters.length;
                while (to > 0 && characters[to - 1].start >= end) to--;
                if (from >= 0 && to > from) ranges.push(textRange(node, from, to));
            }
            // Blank original lines have no paragraph: keep a separate anchor beside
            // their next (or last) visible paragraph, rather than losing the comment.
            const anchorLines = [...new Set([source.line, ...this.notes.filter(note => map.toRendered(note.line) === renderLine).map(note => note.line)])];
            for (const [anchorIndex, anchorLine] of anchorLines.entries()) {
                const notes = this.notes.filter(note => note.line === anchorLine);
                const unread = notes.filter(note => note.author === 'hals' && !note.readAt).length;
                const marker = button(unread ? '●' : notes.length ? '•' : '+', () => this.openThread(anchorLine));
                marker.className = `reader-note-marker${notes.length ? ' has-notes' : ''}${unread ? ' unread' : ''}`;
                marker.dataset.line = anchorLine; marker.dataset.renderLine = renderLine; marker.dataset.anchorIndex = anchorIndex;
                const label = `原文第 ${anchorLine} 行${unread ? `，${unread} 条未读批注` : notes.length ? '，查看批注' : '，添加批注'}`;
                marker.setAttribute('aria-label', label); marker.title = label; this.markers.append(marker);
            }
        }
        if (CSS.highlights && typeof Highlight !== 'undefined') CSS.highlights.set('reader-notes', new Highlight(...ranges));
        else this.fallbackHighlights(ranges);
        this.positionMarkers(); this.observe();
    }
    fallbackHighlights(ranges) {
        // Wrap text nodes only, preserving upstream paragraph/drop-cap elements and layout.
        const segments = new Map();
        for (const range of ranges) {
            const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!range.intersectsNode(node)) continue;
                const start = node === range.startContainer ? range.startOffset : 0;
                const end = node === range.endContainer ? range.endOffset : node.length;
                if (end > start) { if (!segments.has(node)) segments.set(node, []); segments.get(node).push([start, end]); }
            }
        }
        for (const [node, spans] of segments) {
            spans.sort((a, b) => a[0] - b[0]);
            const merged = [];
            for (const span of spans) {
                if (merged.length && span[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(span[1], merged.at(-1)[1]);
                else merged.push([...span]);
            }
            for (const [start, end] of merged.reverse()) {
                node.splitText(end); const selected = node.splitText(start);
                const mark = element('mark', null, 'reader-highlight'); selected.replaceWith(mark); mark.append(selected);
            }
        }
    }
    schedulePosition() {
        if (this.positionFrame) return;
        this.positionFrame = requestAnimationFrame(() => { this.positionFrame = null; this.positionMarkers(); this.positionSelectionMenu(); });
    }
    positionMarkers() {
        const view = viewport();
        const narrow = isNarrowReader(), readingRect = this.content.getBoundingClientRect();
        if (!isNarrowReader()) this.paragraphMenu.hidden = true;
        const panelWidth = Math.min(360, view.width - 32);
        this.panel.style.width = `${panelWidth}px`; this.panel.style.right = 'auto';
        this.panel.style.left = `${view.left + view.width - panelWidth - 16}px`;
        const panelTop = narrow ? 12 : 64, panelHeight = Math.max(100, view.height - (narrow ? 24 : 96));
        for (const panel of [this.panel, this.allPanel]) {
            panel.style.width = `${panelWidth}px`; panel.style.left = `${view.left + view.width - panelWidth - 16}px`;
            panel.style.top = `${view.top + panelTop}px`; panel.style.maxHeight = `${panelHeight}px`;
            panel.style.setProperty('--reader-note-panel-height', `${panelHeight}px`);
        }
        this.allButton.style.left = `${view.left + view.width - this.allButton.offsetWidth - 12}px`; this.allButton.style.top = `${view.top + 8}px`;
        for (const marker of this.markers.children) {
            const node = document.getElementById(`line${marker.dataset.renderLine}`);
            const rect = mobilePaging.active ? mobilePaging.visibleRect(node) : node?.getBoundingClientRect();
            marker.hidden = !CONFIG.VARS.IS_BOOK_OPENED || !rect || rect.bottom < view.top || rect.top > view.top + view.height;
            if (narrow && rect && (rect.top < readingRect.top || rect.top + 28 * (Number(marker.dataset.anchorIndex) + 1) > readingRect.bottom)) marker.hidden = true;
            if (rect) {
                marker.style.left = `${isNarrowReader() ? view.left + 1 : Math.max(2, rect.left - 26 - Number(marker.dataset.anchorIndex) * 24)}px`;
                marker.style.top = `${Math.max(2, rect.top + 2 + (isNarrowReader() ? Number(marker.dataset.anchorIndex) * 28 : 0))}px`;
            }
        }
    }
    threadNotes() {
        if (!this.thread) return [];
        return this.notes.filter(note => this.thread.highlightId
            ? note.id === this.thread.highlightId || note.parentId === this.thread.highlightId
            : note.line === this.thread.line).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    }
    async openThread(line, highlightId = null) {
        this.closeAllNotes();
        this.thread = { line, highlightId, bookId: this.bookId }; this.editingId = null;
        this.menu.hidden = true; this.paragraphMenu.hidden = true; this.renderThread(); this.panel.hidden = false;
        const unread = this.threadNotes().filter(note => note.author === 'hals' && !note.readAt);
        const ids = unread.map(note => note.id), versions = Object.fromEntries(unread.map(note => [note.id, note.updatedAt]));
        if (!ids.length) return;
        const bookId = this.bookId;
        try {
            const result = await (await readerSync.request(`/books/${bookId}/notes/read`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, versions }) })).json();
            if (this.bookId !== bookId) return;
            this.revision++;
            for (const note of this.notes) if (ids.includes(note.id) && versions[note.id] === note.updatedAt) note.readAt = result.readAt;
            // Update labels without replacing an input the reader may already be typing into.
            for (const article of this.panel.querySelectorAll('article')) {
                const note = this.notes.find(item => item.id === Number(article.dataset.noteId));
                if (note?.author === 'hals' && note.readAt) article.querySelector('.reader-note-meta').textContent = `小克 · ${new Date(note.createdAt).toLocaleString()}`;
            }
            this.schedulePaint();
        } catch { this.message('已读标记尚未同步，下次打开会重试。'); }
    }
    closeThread() { this.thread = null; this.editingId = null; if (this.panel) this.panel.hidden = true; }
    threadContent() {
        const notes = this.threadNotes(), content = element('div', null, 'reader-note-thread-content');
        if (this.thread.highlightId) content.append(button('查看本段全部批注', () => this.openThread(this.thread.line)));
        else content.append(element('blockquote', readerSync.maps.get(this.bookId)?.raw[this.thread.line - 1] || '（空行）'));
        for (const note of notes) {
            const article = element('article'); article.dataset.noteId = note.id;
            article.append(element('div', `${note.author === 'hals' ? '小克' : '我'} · ${new Date(note.createdAt).toLocaleString()}${note.author === 'hals' && !note.readAt ? ' · 未读' : ''}`, 'reader-note-meta'));
            if (note.kind === 'highlight') article.append(element('blockquote', note.quote));
            if (note.text) article.append(element('div', note.text, 'reader-note-body'));
            const actions = element('div', null, 'reader-note-actions');
            actions.append(button(note.kind === 'highlight' ? '在划线处批注' : '回复', () => {
                this.replyId = note.kind === 'highlight' ? note.id : note.parentId ?? note.id;
                this.editingId = null; this.editor.placeholder = '写一条回复…'; this.focusEditor();
            }));
            if (note.kind === 'highlight' && !this.thread.highlightId) actions.append(button('查看此划线', () => this.openThread(note.line, note.id)));
            if (note.author === 'reader') {
                actions.append(button('编辑', () => {
                    this.editingId = note.id; this.editor.value = note.text;
                    this.editor.placeholder = note.kind === 'highlight' ? '划线说明…' : '修改批注…'; this.focusEditor();
                }), button('删除', () => this.deleteNote(note)));
            } else actions.append(button('标为未读', () => this.markUnread(note)));
            article.append(actions); content.append(article);
        }
        if (!notes.length) content.append(element('p', '这一段还没有批注。'));
        return content;
    }
    renderThread() {
        if (!this.thread) return;
        this.panel.replaceChildren();
        const header = element('header');
        header.append(element('strong', `原文第 ${this.thread.line} 行`), button('关闭', () => this.closeThread())); this.panel.append(header);
        this.panel.append(this.threadContent());
        this.replyId = this.thread.highlightId;
        this.editor = element('textarea'); this.editor.maxLength = 10000;
        this.editor.placeholder = this.replyId ? '在划线处写批注…' : '在这一段写批注…'; this.editor.setAttribute('aria-label', '批注内容');
        this.error = element('div', '', 'reader-note-error'); this.error.setAttribute('role', 'status');
        this.submit = button('保存批注', () => this.saveComment());
        this.panel.append(this.editor, this.submit, button('取消编辑', () => { this.editingId = null; this.renderThread(); }), this.error);
    }
    focusEditor() {
        // Keep focus inside the trusted tap/click; async focus does not open the iOS keyboard.
        this.editor.focus({ preventScroll: true });
    }
    closeAllNotes() { if (this.allPanel) this.allPanel.hidden = true; }
    openAllNotes() {
        if (!this.bookId) return;
        this.closeThread(); this.menu.hidden = true; this.paragraphMenu.hidden = true;
        this.allFilter ||= { hals: false, unread: false };
        this.allPanel.hidden = false; this.renderAllNotes(); this.positionMarkers(); this.refresh();
    }
    renderAllNotes() {
        this.allPanel.replaceChildren();
        const header = element('header'); header.append(element('strong', '全部批注'), button('关闭', () => this.closeAllNotes()));
        const filters = element('div', null, 'reader-all-notes-filters');
        for (const [key, label] of [['hals', '只看小克的'], ['unread', '只看未读']]) {
            const wrapper = element('label'), input = element('input'); input.type = 'checkbox'; input.checked = this.allFilter[key];
            input.dataset.filter = key;
            input.addEventListener('change', () => { this.allFilter[key] = input.checked; this.renderAllNotes(); });
            wrapper.append(input, document.createTextNode(label)); filters.append(wrapper);
        }
        const list = element('div', null, 'reader-all-notes-list');
        const notes = this.notes.filter(note => (!this.allFilter.hals || note.author === 'hals') &&
            (!this.allFilter.unread || note.author === 'hals' && !note.readAt)).sort((a, b) => a.line - b.line || a.id - b.id);
        for (const note of notes) {
            const item = button('', () => this.jumpToNote(note)); item.className = 'reader-all-note'; item.dataset.noteId = note.id;
            item.append(element('strong', `第 ${note.line} 行 · ${note.author === 'hals' ? '小克' : '我'} · ${note.kind === 'highlight' ? '划线' : '批注'}${note.author === 'hals' && !note.readAt ? ' · 未读' : ''}`),
                element('blockquote', note.quote || readerSync.maps.get(this.bookId)?.raw[note.line - 1] || '（空行）'),
                element('div', note.text || '（无附加批注）', 'reader-note-body')); list.append(item);
        }
        if (!notes.length) list.append(element('p', '没有符合条件的划线或批注。'));
        this.allPanel.append(header, filters, list);
    }
    async jumpToNote(note) {
        const bookId = this.bookId, map = readerSync.maps.get(bookId);
        this.closeAllNotes();
        const { reader } = await import('./reader.js');
        if (this.bookId !== bookId) return;
        await reader.gotoLine(map.toRendered(note.line), false);
        if (this.bookId === bookId) this.openThread(note.line, note.kind === 'highlight' ? note.id : null);
    }
    async saveComment() {
        const thread = this.thread;
        if (!thread || this.savingComment) return;
        const text = this.editor.value;
        const editing = this.notes.find(note => note.id === this.editingId);
        if (!text.trim() && editing?.kind !== 'highlight') { this.error.textContent = '请先写一点内容。'; return; }
        this.savingComment = true; this.submit.disabled = true;
        try {
            const endpoint = `/books/${thread.bookId}/notes${editing ? `/${editing.id}` : ''}`;
            const body = editing ? { text } : { line: thread.line, text, ...(this.replyId ? { parentId: this.replyId } : {}) };
            const note = await (await readerSync.request(endpoint, { method: editing ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
            if (this.bookId !== thread.bookId) return;
            this.revision++;
            if (editing) this.notes = this.notes.map(existing => existing.id === note.id ? note : existing);
            else this.notes.push(note);
            this.editingId = null; this.schedulePaint();
            if (this.thread === thread) this.renderThread();
            this.message('批注已保存');
        } catch { if (this.thread === thread) this.error.textContent = '尚未保存：内容保留在输入框，可重试。'; }
        finally { this.savingComment = false; if (this.submit) this.submit.disabled = false; }
    }
    async deleteNote(note) {
        const replies = this.notes.filter(item => item.parentId === note.id);
        if (!window.confirm(replies.length ? '删除这条记录及其回复？' : '删除这条记录？')) return;
        const bookId = this.bookId;
        try {
            await readerSync.request(`/books/${bookId}/notes/${note.id}`, { method: 'DELETE' });
            if (this.bookId !== bookId) return;
            this.revision++;
            this.notes = this.notes.filter(item => item.id !== note.id && item.parentId !== note.id);
            if (this.thread?.highlightId === note.id) this.thread.highlightId = null;
            this.editingId = null; this.renderThread(); this.schedulePaint();
        } catch { this.message('删除尚未完成，请重试。'); }
    }
    async markUnread(note) {
        const bookId = this.bookId;
        try {
            await readerSync.request(`/books/${bookId}/notes/read`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [note.id], read: false,
                    versions: { [note.id]: note.updatedAt } }) });
            if (this.bookId !== bookId) return;
            this.revision++;
            const current = this.notes.find(item => item.id === note.id);
            if (current?.updatedAt === note.updatedAt) current.readAt = null;
            this.schedulePaint(); this.renderThread();
        } catch { this.message('未读标记尚未同步，请重试。'); }
    }
}

export const readerAnnotations = new ReaderAnnotations();
