import * as CONFIG from '../../config/index.js';

const screen = window.matchMedia('(max-width: 600px)');
const selectionActive = () => !window.getSelection()?.isCollapsed;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

/** Screen pages are a view of the original DOM, never a new source coordinate system. */
export const mobilePaging = {
    mode: localStorage.getItem('mobile_reading_mode') === 'scroll' ? 'scroll' : 'pages',
    chapter: -1, page: 0, count: 1, stride: 0, currentAnchor: null,
    get active() { return screen.matches && this.mode === 'pages'; },
    get narrow() { return screen.matches; },
    get content() { return CONFIG.DOM_ELEMENT.CONTENT_CONTAINER; },
    get chapters() {
        const starts = [...new Set([0, ...CONFIG.VARS.ALL_TITLES.map(title => Number(title[1]))])]
            .filter(line => line >= 0 && line < CONFIG.VARS.FILE_CONTENT_CHUNKS.length).sort((a, b) => a - b);
        return starts.map((start, i) => [start, starts[i + 1] ?? CONFIG.VARS.FILE_CONTENT_CHUNKS.length]);
    },
    get atEnd() { return this.chapter === this.chapters.length - 1 && this.page === this.count - 1; },
    init(reader, sync) {
        this.reader = reader; this.sync = sync;
        this.applyClass(); this.installGestures();
        screen.addEventListener('change', () => this.changeView());
        document.addEventListener('reader:book-opening', () => {
            this.viewGeneration = (this.viewGeneration || 0) + 1; this.switching = false;
            this.chapter = -1; this.currentAnchor = null; this.scrollAnchor = null; this.setMenu(false); this.applyClass();
        });
        document.addEventListener('reader:book-closed', () => {
            this.viewGeneration = (this.viewGeneration || 0) + 1; this.switching = false;
            this.chapter = -1; this.currentAnchor = null; document.body.classList.remove('reader-page-menu-open');
        });
        document.addEventListener('reader:book-opened', () => {
            if (this.active) this.reflow();
        });
        const observer = new ResizeObserver(() => this.scheduleReflow());
        observer.observe(this.content.parentElement);
        document.fonts.addEventListener('loadingdone', () => this.scheduleReflow());
    },
    applyClass() { this.viewActive = this.active; document.body.classList.toggle('reader-page-mode', this.active); },
    setMode(mode) {
        const next = mode === 'scroll' ? 'scroll' : 'pages';
        if (next === this.mode) { this.scheduleReflow(); return; }
        const anchor = this.switching ? this.viewAnchor : this.anchor(); this.mode = next;
        localStorage.setItem('mobile_reading_mode', next);
        if (screen.matches) this.changeView(anchor);
    },
    async changeView(saved = this.switching ? this.viewAnchor : this.anchor()) {
        this.applyClass(); this.chapter = -1;
        if (!this.reader || !CONFIG.VARS.IS_BOOK_OPENED) return;
        const generation = this.viewGeneration = (this.viewGeneration || 0) + 1;
        if (!this.switching) this.beforeViewSuppression = this.sync.suppressed;
        this.switching = true; this.viewAnchor = saved; this.sync.suppressed = true;
        try {
            this.reader.toggleInfiniteScroll();
            this.content.scrollLeft = 0;
            for (const key of ['--reader-page-height', '--reader-page-column']) this.content.style.removeProperty(key);
            this.reader.showCurrentPageContent(); this.reader.generatePagination();
            if (saved) {
                await this.reader.gotoLine(saved.renderLine, false);
                if (generation !== this.viewGeneration) return;
                if (this.active) this.gotoOffset(saved.renderLine, saved.offset);
                else {
                    const map = this.sync.maps.get(this.sync.current);
                    if (map) this.sync.scrollToOffset(saved.renderLine, saved.offset, map.raw[saved.line - 1]);
                    // A scroll line may start before the saved character. Keep the bookmark
                    // while it remains visible, until the reader actually scrolls.
                    this.scrollAnchor = saved;
                }
            }
            await nextFrame();
        } finally {
            if (generation === this.viewGeneration) { this.switching = false; this.sync.suppressed = this.beforeViewSuppression; }
        }
    },
    scheduleReflow() {
        cancelAnimationFrame(this.layoutFrame);
        this.layoutFrame = requestAnimationFrame(() => {
            if (this.active && CONFIG.VARS.IS_BOOK_OPENED) this.reflow();
        });
    },
    reflow() {
        const saved = this.layoutAnchor || this.currentAnchor; this.measure();
        if (saved) this.gotoOffset(saved.renderLine, saved.offset, false);
        else this.move(Math.min(this.page, this.count - 1), false);
    },
    measure() {
        const content = this.content;
        const p = content.querySelector('p') || content;
        const style = getComputedStyle(p);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
        const available = content.parentElement.clientHeight - 24;
        const height = Math.max(lineHeight, Math.floor(available / lineHeight) * lineHeight);
        content.style.setProperty('--reader-page-height', `${height}px`);
        content.style.setProperty('--reader-page-column', `${content.parentElement.clientWidth - 40}px`);
        this.stride = content.clientWidth;
        this.count = Math.max(1, Math.ceil((content.scrollWidth - content.clientWidth - 1) / this.stride) + 1);
    },
    render(line = CONFIG.VARS.PAGE_BREAKS[CONFIG.VARS.CURRENT_PAGE - 1] || 0) {
        const chapters = this.chapters;
        const chapter = Math.max(0, chapters.findIndex(([start, end]) => line >= start && line < end));
        this.chapter = chapter; this.page = 0; this.currentAnchor = null; this.layoutAnchor = null;
        const range = chapters[chapter];
        if (!range) return;
        this.reader.renderRange(...range); this.content.scrollLeft = 0; this.measure(); this.move(0, false);
    },
    turn(direction) {
        if (!this.active || !CONFIG.VARS.IS_BOOK_OPENED || selectionActive()) return false;
        const next = this.page + direction;
        if (next >= 0 && next < this.count) { this.move(next); return true; }
        const chapter = this.chapter + direction, range = this.chapters[chapter];
        if (!range) return false;
        this.render(range[0]); this.move(direction > 0 ? 0 : this.count - 1); return true;
    },
    move(page, save = true) {
        this.page = Math.max(0, Math.min(page, this.count - 1));
        this.content.scrollTo({ left: this.page * this.stride, top: 0, behavior: 'instant' });
        this.currentAnchor = this.readAnchor();
        if (save || !this.layoutAnchor) this.layoutAnchor = this.currentAnchor && { ...this.currentAnchor };
        if (this.currentAnchor) {
            const breaks = CONFIG.VARS.PAGE_BREAKS;
            const next = breaks.findIndex(line => line > this.currentAnchor.renderLine);
            CONFIG.VARS.CURRENT_PAGE = Math.max(1, Math.min(next < 0 ? breaks.length : next, CONFIG.VARS.TOTAL_PAGES));
        }
        this.controls(); this.reader.onMobilePageChanged(save);
        document.dispatchEvent(new CustomEvent('reader:screen-page', { detail: this.currentAnchor }));
    },
    gotoLine(line) {
        const range = this.chapters[this.chapter];
        if (!range || line < range[0] || line >= range[1]) this.render(line);
        return this.gotoOffset(line, 0) ? 0 : -1;
    },
    gotoOffset(renderLine, originalOffset, save = true) {
        const rect = this.sourceRect(renderLine, originalOffset);
        if (!rect) return false;
        const left = this.content.getBoundingClientRect().left + 20;
        this.move(Math.floor((rect.left - left + this.content.scrollLeft + 1) / this.stride), save);
        const map = this.sync?.maps.get(this.sync.current);
        this.layoutAnchor = { renderLine, line: map?.toOriginal(renderLine) || 1, offset: originalOffset };
        return true;
    },
    sourceRect(renderLine, originalOffset) {
        const element = CONFIG.DOM_ELEMENT.GET_LINE(renderLine);
        if (!element) return null;
        const map = this.sync?.maps.get(this.sync.current);
        const characters = map?.characters(renderLine, element.textContent);
        let offset = originalOffset ? characters?.findIndex(char => char.end > originalOffset) : 0;
        if (offset == null || offset < 0) offset = Math.max(0, element.textContent.length - 1);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text, remaining = offset, rect;
        while ((text = walker.nextNode())) {
            if (remaining >= text.length) { remaining -= text.length; continue; }
            const range = document.createRange(); range.setStart(text, remaining); range.setEnd(text, remaining + 1);
            rect = range.getBoundingClientRect(); break;
        }
        return rect || element.getClientRects()[0] || null;
    },
    visibleRect(element) {
        if (!element) return null;
        const range = document.createRange(); range.selectNodeContents(element);
        const view = this.content.getBoundingClientRect();
        return [...range.getClientRects()].find(rect => rect.width && rect.left >= view.left - 1 && rect.right <= view.right + 1 && rect.top >= view.top && rect.bottom <= view.bottom + 1) || null;
    },
    readAnchor() {
        const map = this.sync?.maps.get(this.sync.current);
        const view = this.content.getBoundingClientRect();
        for (const element of this.content.querySelectorAll('[id^="line"]')) {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text, renderOffset = 0;
            while ((text = walker.nextNode())) {
                const range = document.createRange(); range.selectNodeContents(text);
                const fragment = [...range.getClientRects()].find(rect => rect.width && rect.left >= view.left - 1 &&
                    rect.right <= view.right + 1 && rect.top >= view.top + 11 && rect.bottom <= view.bottom - 11);
                if (!fragment) { renderOffset += text.length; continue; }
                // DOM geometry remains reliable when a settings/annotation overlay covers the text.
                // Hit-testing the screen would instead return that overlay and lose the offset.
                const column = rect => this.active ? Math.floor((rect.left - view.left - 20 + this.content.scrollLeft + 1) / this.stride) : 0;
                const targetColumn = column(fragment);
                let lo = 0, hi = text.length;
                while (lo < hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    range.setStart(text, mid); range.setEnd(text, mid + 1);
                    const rect = range.getBoundingClientRect(), position = column(rect);
                    if (position > targetColumn || (position === targetColumn && rect.top >= fragment.top - 1)) hi = mid;
                    else lo = mid + 1;
                }
                const renderLine = Number(element.id.slice(4)), line = map?.toOriginal(renderLine) || 1;
                const offset = map?.characters(renderLine, element.textContent)?.[renderOffset + lo]?.start || 0;
                return { renderLine, line, offset };
            }
        }
        return null;
    },
    anchor() {
        if (this.viewActive && this.currentAnchor) return { ...(this.layoutAnchor || this.currentAnchor) };
        if (screen.matches) {
            const saved = this.scrollAnchor, rect = saved && this.sourceRect(saved.renderLine, saved.offset), view = this.content.getBoundingClientRect();
            if (rect && rect.top >= view.top + 11 && rect.bottom <= view.bottom - 11 && rect.left >= view.left && rect.right <= view.right) return { ...saved };
            return this.readAnchor();
        }
        const map = this.sync?.maps.get(this.sync.current);
        if (!map) return null;
        const view = this.content.getBoundingClientRect();
        const element = [...this.content.querySelectorAll('[id^="line"]')].find(node => node.getBoundingClientRect().bottom > view.top + 12);
        if (!element) return null;
        const renderLine = Number(element.id.slice(4)), line = map.toOriginal(renderLine);
        return { renderLine, line, offset: this.sync.viewportOffset(renderLine, map.raw[line - 1]) };
    },
    setMenu(open) {
        document.body.classList.toggle('reader-page-menu-open', open);
        if (!open && document.body.classList.contains('reader-mobile-toc-open')) document.querySelector('#reader-mobile-toc-toggle')?.click();
        document.dispatchEvent(new Event('reader:page-menu'));
    },
    controls() {
        if (!this.active) return;
        const container = CONFIG.DOM_ELEMENT.PAGINATION_CONTAINER;
        const previous = document.createElement('button'); previous.textContent = '上一页'; previous.disabled = this.chapter === 0 && this.page === 0;
        previous.addEventListener('click', () => this.turn(-1));
        const status = document.createElement('button'); status.id = 'reader-screen-page-status';
        status.textContent = `本章 ${this.page + 1} / ${this.count}`; status.setAttribute('aria-label', `${status.textContent}，显示或收起阅读菜单`);
        status.addEventListener('click', () => this.setMenu(!document.body.classList.contains('reader-page-menu-open')));
        const next = document.createElement('button'); next.textContent = '下一页'; next.disabled = this.atEnd;
        next.addEventListener('click', () => this.turn(1)); container.replaceChildren(previous, status, next);
    },
    protectedTarget(event) {
        if (event.target.closest('a, button, input, textarea, select, .reader-note-ui, mark')) return true;
        // Native CSS highlights have no element: their ranges still protect annotation taps.
        for (const highlight of window.CSS?.highlights?.values() || []) for (const range of highlight) {
            if ([...range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return true;
        }
        return false;
    },
    handleTap(event) {
        const rect = this.content.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width;
        if (x < 1 / 3 || x > 2 / 3) this.turn(x < 1 / 3 ? -1 : 1);
        else {
            const open = !document.body.classList.contains('reader-page-menu-open'); this.setMenu(open);
            if (open) document.dispatchEvent(new CustomEvent('reader:paragraph-tap', { detail: { target: event.target } }));
        }
    },
    installGestures() {
        const content = document.querySelector('.sidebar-splitview-outer') || this.content;
        for (const type of ['wheel', 'touchmove']) content.addEventListener(type, () => {
            if (!this.active) this.scrollAnchor = null;
        }, { passive: true });
        content.addEventListener('pointerdown', event => {
            this.ignoreNextClick = false;
            if (!this.active || !CONFIG.VARS.IS_BOOK_OPENED || document.body.classList.contains('reader-mobile-toc-open') ||
                !event.isPrimary || event.button !== 0 || selectionActive() || this.protectedTarget(event)) { this.gesture = null; return; }
            this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
        }, { passive: true });
        content.addEventListener('pointermove', event => {
            const gesture = this.gesture;
            if (gesture && event.pointerId === gesture.id && performance.now() - gesture.at < 350 && Math.abs(event.clientX - gesture.x) > 12) gesture.swiping = true;
        }, { passive: true });
        content.addEventListener('pointerup', event => {
            const gesture = this.gesture; this.gesture = null;
            const elapsed = gesture ? performance.now() - gesture.at : Infinity;
            if (!this.active || !gesture || gesture.id !== event.pointerId || elapsed > 900 || (elapsed >= 350 && !gesture.swiping) || selectionActive() || this.protectedTarget(event)) return;
            const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
            if (Math.abs(dx) >= 50 && Math.abs(dy) < Math.abs(dx) * 0.6) {
                this.ignoreNextClick = true; this.turn(dx < 0 ? 1 : -1);
            } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
                this.ignoreNextClick = true; this.handleTap(event);
            }
        });
        for (const type of ['pointercancel', 'contextmenu']) content.addEventListener(type, () => { this.gesture = null; });
        content.addEventListener('touchstart', event => { if (event.touches.length > 1) this.gesture = null; }, { passive: true });
        content.addEventListener('click', event => {
            if (!this.active || selectionActive()) return;
            if (this.ignoreNextClick) { this.ignoreNextClick = false; event.stopImmediatePropagation(); return; }
        }, true);
    },
};
