import { mobilePaging } from "./reader-page-turn.js";
import * as CONFIG from '../../config/index.js';
import { readerSync } from '../api/reader-sync.js';
import { readingTracker } from '../api/reading-tracker.js';
import { cacheKey, catalogEntries } from '../api/reader-catalog.js';
import { REVIEW_FIELDS, emptyReviewFields } from '../../../../shared/core/reader/review-fields.js';

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
}
function button(text, action, name) {
    const element = node('button', text); element.type = 'button';
    if (name) element.dataset.action = name;
    element.addEventListener('click', action); return element;
}
function select(options, value = '') {
    const element = node('select');
    for (const [key, label] of options) { const option = node('option', label); option.value = key; element.append(option); }
    element.value = value; return element;
}
function calendarDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function today() { return calendarDate(new Date()); }
function warningText(warning) { if (!warning.label) return warning.message; return `${warning.label}${warning.value ? `：${warning.value}` : ''}（${warning.message}）`; }
const RATING_TONES = { '值得多刷': 'favorite', '可圈可点': 'good', '文荒可看': 'okay', '看不下去': 'muted', '踩我雷点 滚': 'avoid' };
function ratingBadge(value) {
    const badge = node('span', value || '未评价', 'reader-rating-badge');
    badge.dataset.rating = RATING_TONES[value] || 'unset';
    badge.setAttribute('aria-label', `阅读进度及评价：${value || '未评价'}`); return badge;
}
function extraTags(fields) { return [...new Set((fields.extraTags || '').split(/[\s,，]+/u).filter(Boolean))]; }
function recordDate(record) { return record.finishedAt ? `${record.finishedAt} 读完` : `${(record.submittedAt || record.createdAt).slice(0, 10)} 记录`; }
function duration(milliseconds) { return milliseconds == null ? '未知' : `${Math.floor(milliseconds / 3600000)} 小时 ${Math.floor(milliseconds / 60000) % 60} 分钟`; }
function view() { return window.visualViewport || { width: document.documentElement.clientWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 }; }

class ReaderReviews {
    init() {
        if (this.initialized || !readerSync.active) return;
        this.initialized = true; this.suggested = new Set(); this.linkQueue = new Map(); this.dismissedLinks = new Set();
        readingTracker.init();
        this.toolbar = node('nav', null, 'reader-review-ui'); this.toolbar.id = 'reader-review-toolbar'; this.toolbar.setAttribute('aria-label', '读书记录');
        this.finishButton = button('读完了', () => this.openCard(readerSync.current), 'finish');
        this.toolbar.append(button('档案', () => this.openArchive(), 'archive'), this.finishButton);
        this.overlay = node('div', null, 'reader-review-ui'); this.overlay.id = 'reader-review-overlay'; this.overlay.hidden = true;
        this.dialog = node('section', null, 'reader-review-dialog'); this.dialog.setAttribute('role', 'dialog'); this.dialog.setAttribute('aria-modal', 'true');
        this.dialog.setAttribute('aria-labelledby', 'reader-review-title'); this.overlay.append(this.dialog);
        this.suggestion = node('div', null, 'reader-review-ui'); this.suggestion.id = 'reader-finish-suggestion'; this.suggestion.hidden = true;
        this.suggestion.setAttribute('role', 'status');
        this.links = node('div', null, 'reader-review-ui'); this.links.id = 'reader-archive-links'; this.links.hidden = true;
        document.body.append(this.toolbar, this.overlay, this.suggestion, this.links);
        this.dialog.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        document.addEventListener('keydown', event => {
            if (this.overlay.hidden) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
            else if (this.overlay.contains(event.target)) {
                if (event.key === 'Tab') this.trapFocus(event);
                event.stopPropagation();
            }
        }, true);
        document.addEventListener('reader:book-opened', () => { this.finishButton.hidden = false; this.checkEnd(); });
        for (const type of ['reader:book-opening', 'reader:book-closed']) document.addEventListener(type, () => { this.finishButton.hidden = true; this.suggestion.hidden = true; });
        document.addEventListener('reader:book-uploaded', event => this.checkLinks(event.detail.id));
        const observer = new MutationObserver(() => this.scheduleEnd());
        observer.observe(CONFIG.DOM_ELEMENT.CONTENT_CONTAINER, { childList: true });
        document.addEventListener('reader:screen-page', () => this.checkEnd());
        window.addEventListener('scroll', () => this.scheduleEnd(), { passive: true });
        window.addEventListener('resize', () => this.position()); window.visualViewport?.addEventListener('resize', () => this.position());
        setInterval(() => {
            if (!this.overlay.hidden && this.mode === 'card' && !document.hidden) this.refreshDraft();
            this.finishButton.hidden = !CONFIG.VARS.IS_BOOK_OPENED || !readerSync.current;
            this.checkEnd();
        }, 5000);
        this.finishButton.hidden = !CONFIG.VARS.IS_BOOK_OPENED || !readerSync.current;
        this.position();
        for (const book of catalogEntries()) this.checkLinks(book.id);
    }
    position() {
        const viewport = view();
        const width = Math.min(this.mode === 'archive' ? 1180 : 900, viewport.width - 32);
        this.toolbar.style.left = `${viewport.offsetLeft + viewport.width / 2}px`;
        this.dialog.style.width = `${width}px`;
        this.dialog.style.maxHeight = `${Math.max(120, viewport.height - 32)}px`;
        this.overlay.style.placeItems = 'start';
        this.dialog.style.position = 'fixed';
        this.dialog.style.left = `${viewport.offsetLeft + Math.max(16, (viewport.width - width) / 2)}px`;
        this.dialog.style.top = `${viewport.offsetTop + 16}px`;
    }
    trapFocus(event) {
        const controls = [...this.dialog.querySelectorAll('button,input,select,textarea,summary')].filter(element => !element.disabled && element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    shell(title, mode) {
        this.mode = mode; this.dialog.replaceChildren(); this.overlay.hidden = false; readingTracker.pause(true);
        this.dialog.dataset.mode = mode;
        const header = node('header'), heading = node('h2', title); heading.id = 'reader-review-title';
        const close = button('关闭', () => this.close(), 'close'); header.append(heading, close); this.dialog.append(header);
        this.status = node('div', '', 'reader-review-status'); this.status.setAttribute('role', 'status'); this.dialog.append(this.status);
        this.position(); close.focus();
    }
    close() {
        if (this.dirty && !window.confirm('这张卡片还没有保存，确定关闭？')) return;
        this.overlay.hidden = true; this.dirty = false; this.card = null; readingTracker.pause(false);
        this.toolbar.querySelector('button').focus();
    }
    async json(endpoint, data, method = 'POST') {
        return (await readerSync.request(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
    }
    async openCard(bookId = null, recordId = null) {
        this.dirty = false; this.cardGeneration = (this.cardGeneration || 0) + 1;
        const generation = this.cardGeneration;
        this.shell(recordId ? '编辑读书记录' : '读完卡片', 'card'); this.status.textContent = '正在读取…';
        try {
            readingTracker.tick(); await readingTracker.flush();
            if (bookId && !recordId) {
                const existing = await (await readerSync.request(`/archives?bookId=${encodeURIComponent(bookId)}`)).json();
                recordId = existing[0]?.id ?? null;
            }
            const record = recordId ? await (await readerSync.request(`/archives/${recordId}`)).json() : null;
            bookId = record ? record.bookId : bookId;
            const book = bookId ? await (await readerSync.request(`/books/${bookId}`)).json() : null;
            const stats = bookId ? await (await readerSync.request(`/books/${bookId}/stats`)).json() : null;
            if (this.mode !== 'card' || generation !== this.cardGeneration || this.overlay.hidden) return;
            this.card = record || { bookId, title: book?.title || '', author: book?.author || '',
                startedAt: stats?.startedAt ? calendarDate(new Date(stats.startedAt)) : (book ? today() : null), finishedAt: book ? today() : null,
                readingMs: stats?.readingMs ?? null, wordCount: stats?.wordCount ?? null,
                fields: { ...emptyReviewFields(), completed: book ? '已看完' : '未看完' }, reflection: '' };
            this.cardBook = book; this.inputs = {}; this.draftRequest = null;
            this.renderCard(); await this.refreshDraft();
        } catch { this.status.textContent = '读取失败，请重新打开卡片。'; }
    }
    renderCard() {
        this.shell(this.card.id ? '编辑读书记录' : '读完卡片', 'card');
        const content = node('div', null, 'reader-review-card-content'); this.dialog.append(content);
        const form = node('form', null, 'reader-review-form'); form.id = 'reader-review-form';
        const group = (title, hint = '') => {
            const section = node('fieldset', null, 'reader-review-form-section');
            section.append(node('legend', title));
            if (hint) section.append(node('p', hint, 'reader-review-hint'));
            const grid = node('div', null, 'reader-review-form-grid'); section.append(grid); form.append(section); return grid;
        };
        const bookGroup = group('书籍与阅读');
        const opinionGroup = group('评价与人物');
        const genreGroup = group('题材与标签', '选择背景，展开对应题材；补充标签用空格或逗号分隔。');
        const thoughtsGroup = group('读后感'); thoughtsGroup.classList.add('reader-review-thoughts');
        const field = (key, label, type = 'text', required = false) => {
            const wrapper = node('div', null, 'reader-review-field');
            const caption = node('label', label), input = node(type === 'textarea' ? 'textarea' : 'input');
            input.id = `review-${key}`; input.name = key; caption.htmlFor = input.id;
            if (type !== 'textarea') input.type = type;
            input.required = required; input.value = this.card[key] || ''; input.maxLength = type === 'textarea' ? 50000 : 255;
            if (type === 'textarea') wrapper.classList.add('wide');
            wrapper.append(caption, input); this.inputs[key] = input;
            (key === 'reflection' ? thoughtsGroup : bookGroup).append(wrapper); return input;
        };
        field('title', '书名', 'text', true); field('author', '作者', 'text', true);
        field('startedAt', '开始阅读日期', 'date'); field('finishedAt', '读完日期', 'date');
        const statistics = node('div', null, 'reader-review-statistics');
        statistics.append(node('span', `累计阅读：${duration(this.card.readingMs)}`), node('span', `字数：${this.card.wordCount ?? '未知'}`));
        bookGroup.append(statistics);
        if (readingTracker.unsynced) content.append(node('p', '阅读时长尚未同步，联网后重新打开卡片可刷新。', 'reader-review-status'));
        this.choiceWrappers = {};
        for (const definition of REVIEW_FIELDS) {
            const wrapper = node('div', null, `reader-review-field${definition.type === 'multi' ? ' multi' : ''}`);
            const caption = node('label', definition.label); wrapper.append(caption); this.choiceWrappers[definition.key] = wrapper;
            const value = this.card.fields[definition.key];
            if (definition.type === 'single') {
                const input = select([['', '请选择'], ...definition.options.map(option => [option, option])], value);
                input.id = `review-${definition.key}`; caption.htmlFor = input.id; this.inputs[definition.key] = input; wrapper.append(input);
                if (definition.key === 'background') input.addEventListener('change', () => this.updateConditional(true));
                if (definition.key === 'completed') input.addEventListener('change', () => {
                    if (input.value === '未看完') this.inputs.finishedAt.value = '';
                    else if (input.value === '已看完' && !this.inputs.finishedAt.value) this.inputs.finishedAt.value = today();
                });
                if (definition.key === 'rating') {
                    const preview = node('div', null, 'reader-review-rating-preview'); preview.append(ratingBadge(value));
                    input.addEventListener('change', () => preview.replaceChildren(ratingBadge(input.value))); wrapper.append(preview);
                }
            } else if (definition.type === 'multi') {
                const choices = node('div', null, 'reader-review-checkboxes');
                this.inputs[definition.key] = [];
                for (const option of definition.options) {
                    const label = node('label'), input = node('input'); input.type = 'checkbox'; input.value = option; input.checked = value?.includes(option);
                    input.name = definition.key; label.append(input, node('span', option)); choices.append(label); this.inputs[definition.key].push(input);
                }
                wrapper.append(choices);
            } else {
                const input = node('input'); input.type = 'text'; input.value = value || ''; input.maxLength = definition.key === 'extraTags' ? 10000 : 1000;
                input.id = `review-${definition.key}`; caption.htmlFor = input.id; this.inputs[definition.key] = input; wrapper.append(input);
            }
            if (definition.key === 'extraTags') wrapper.classList.add('wide');
            (['background', 'modern', 'ancient', 'future', 'fanfiction', 'style', 'extraTags'].includes(definition.key) ? genreGroup : opinionGroup).append(wrapper);
        }
        opinionGroup.append(...['rating', 'completed', 'platform', 'characters', 'perspective', 'relationship'].map(key => this.choiceWrappers[key]));
        field('reflection', '感想', 'textarea');
        thoughtsGroup.querySelector('.reader-review-field').classList.remove('wide');
        form.addEventListener('input', () => { this.dirty = true; }); form.addEventListener('change', () => { this.dirty = true; });
        form.addEventListener('submit', event => { event.preventDefault(); this.saveCard(); });
        content.append(form); this.updateConditional();
        if (this.card.warnings?.length) content.append(node('div', this.card.warnings.map(warningText).join('\n'), 'reader-review-warning'));
        if (this.card.source === 'import') {
            const details = node('details', null, 'reader-review-import-details'); details.append(node('summary', '原始导入字段'), node('pre', JSON.stringify(this.card.original, null, 2), 'reader-review-original')); content.append(details);
        }
        const actions = node('div', null, 'reader-review-actions reader-review-savebar');
        this.saveButton = button('保存记录', () => { if (form.reportValidity()) this.saveCard(); }, 'save-review');
        this.saveButton.classList.add('reader-review-primary');
        this.draftButton = button('让小克起草', () => this.requestDraft(), 'request-draft'); this.draftButton.disabled = !this.card.bookId;
        actions.append(this.saveButton, button('返回档案', () => {
            if (!this.dirty || window.confirm('尚未保存，确定返回档案？')) { this.dirty = false; this.openArchive(); }
        }, 'back-archive'));
        actions.append(this.status);
        this.dialog.append(actions);
        this.draftBox = node('section', null, 'reader-review-draft'); thoughtsGroup.append(this.draftBox); this.paintDraft();
    }
    updateConditional(clear = false) {
        const background = this.inputs.background.value;
        for (const field of REVIEW_FIELDS.filter(field => field.when)) {
            const active = field.when === background; this.choiceWrappers[field.key].hidden = !active;
            if (!active && clear) for (const input of this.inputs[field.key]) input.checked = false;
        }
    }
    collectCard() {
        const fields = Object.fromEntries(REVIEW_FIELDS.map(field => [field.key, field.type === 'multi'
            ? this.inputs[field.key].filter(input => input.checked).map(input => input.value) : this.inputs[field.key].value]));
        return { bookId: this.card.bookId, title: this.inputs.title.value, author: this.inputs.author.value,
            startedAt: this.inputs.startedAt.value || null, finishedAt: this.inputs.finishedAt.value || null,
            fields, reflection: this.inputs.reflection.value, ...(this.draftRequest ? { draftRequestId: this.draftRequest.requestId } : {}),
            ...(this.card.id ? { updatedAt: this.card.updatedAt } : {}) };
    }
    async saveCard() {
        if (this.saving || !this.card) return;
        const card = this.card, data = this.collectCard(), saveButton = this.saveButton;
        if (data.startedAt && data.finishedAt && data.finishedAt < data.startedAt) { this.status.textContent = '读完日期不能早于开始日期。'; return; }
        this.saving = true; this.saveButton.disabled = true;
        try {
            const saved = await this.json(`/archives${card.id ? `/${card.id}` : ''}`, data, card.id ? 'PATCH' : 'POST');
            if (this.card !== card) return;
            this.card = saved; this.dirty = false; this.status.textContent = '记录已保存'; this.saveButton.textContent = '保存修改';
        } catch (error) {
            if (this.card !== card) return;
            this.status.textContent = error.data?.code === 'archive_book_conflict' ? '这本 TXT 已有卡片；请先保留当前输入，再打开已有卡片。' : error.status === 409 ? '这条档案已在另一处更新，请先保留感想，再重新打开。' : '尚未保存：请检查必填项、日期或连接后重试；输入内容仍保留。';
            if (error.data?.archiveId) this.status.append(button('打开已有卡片', () => { if (!this.dirty || window.confirm('当前输入尚未保存，已自行保留后打开已有卡片？')) this.openCard(card.bookId, error.data.archiveId); }, 'open-existing-card'));
        } finally { this.saving = false; saveButton.disabled = false; }
    }
    async requestDraft() {
        if (!this.card?.bookId || this.requestingDraft) return;
        const card = this.card; this.requestingDraft = true; this.draftButton.disabled = true;
        try {
            const request = await this.json(`/books/${card.bookId}/draft-request`, { archiveId: card.id || null });
            if (this.card !== card) return;
            this.draftRequest = request; this.paintDraft(); this.status.textContent = '已递给小克，草稿写好后会显示在下方。';
        } catch { this.status.textContent = '起草请求尚未提交，请重试。'; }
        finally { this.requestingDraft = false; this.draftButton.disabled = !this.card?.bookId; }
    }
    async refreshDraft() {
        const card = this.card;
        if (!card?.bookId || this.draftLoading || this.mode !== 'card' || this.overlay.hidden) return;
        this.draftLoading = true;
        const expectedRequestId = this.draftRequest?.requestId || null;
        try {
            const suffix = this.draftRequest ? `?requestId=${encodeURIComponent(this.draftRequest.requestId)}` : `?archiveId=${card.id || 'new'}`;
            const draft = await (await readerSync.request(`/books/${card.bookId}/review-draft${suffix}`)).json();
            if (this.card !== card || this.mode !== 'card' || this.requestingDraft || (this.draftRequest?.requestId || null) !== expectedRequestId) return;
            if (JSON.stringify(draft) !== JSON.stringify(this.draftRequest)) { this.draftRequest = draft; this.paintDraft(); }
        } catch { /* Draft polling never changes the reader's input. */ }
        finally { this.draftLoading = false; }
    }
    paintDraft() {
        if (!this.draftBox) return;
        const heading = node('div', null, 'reader-review-draft-heading'); heading.append(node('h3', '小克草稿'), this.draftButton);
        this.draftBox.replaceChildren(heading);
        if (!this.card?.bookId) { this.draftBox.append(node('p', '关联原文后，可以让小克根据划线和批注起草。', 'reader-review-hint')); return; }
        if (!this.draftRequest) { this.draftBox.append(node('p', '点“让小克起草”，把这本书的划线和批注递过去。')); return; }
        if (this.draftRequest.status !== 'ready') { this.draftBox.append(node('p', '小克还在起草，你可以先填写或保存自己的感想。')); return; }
        this.draftBox.append(node('pre', this.draftRequest.draft), button('采用草稿', () => {
            if (this.inputs.reflection.value && !window.confirm('将用草稿替换当前感想，确定采用？')) return;
            this.inputs.reflection.value = this.draftRequest.draft; this.dirty = true; this.inputs.reflection.focus();
        }, 'adopt-draft'), node('p', '采用后可继续修改，再点“保存记录”。'));
    }
    scheduleEnd() {
        if (this.endFrame) return;
        this.endFrame = requestAnimationFrame(() => { this.endFrame = null; this.checkEnd(); });
    }
    checkEnd() {
        const bookId = readerSync.current;
        if (mobilePaging.active && !mobilePaging.atEnd) return;
        if (!bookId || readerSync.suppressed || !CONFIG.VARS.IS_BOOK_OPENED || document.hidden || !this.overlay.hidden ||
            !readingTracker.lastInteraction || Date.now() - readingTracker.lastInteraction > 120000 ||
            this.suggested.has(bookId) || (!mobilePaging.active && CONFIG.VARS.CURRENT_PAGE !== CONFIG.VARS.TOTAL_PAGES)) return;
        const map = readerSync.maps.get(bookId), chunks = CONFIG.VARS.FILE_CONTENT_CHUNKS;
        let last = chunks.length - 1;
        while (last >= 0 && (!map?.source(last) || (typeof chunks[last] === 'object' && chunks[last].type === 'empty'))) last--;
        const paragraph = document.getElementById(`line${last}`), viewport = view();
        if (!mobilePaging.active && (!paragraph || paragraph.getBoundingClientRect().bottom > viewport.offsetTop + viewport.height + 3)) return;
        this.suggested.add(bookId);
        this.suggestion.replaceChildren(node('p', '读到末尾了，要留一张读完卡片吗？'), button('填写卡片', () => {
            this.suggestion.hidden = true; this.openCard(bookId);
        }, 'open-finish-card'), button('继续阅读', () => { this.suggestion.hidden = true; }, 'dismiss-finish'));
        this.suggestion.hidden = false;
    }
    async openArchive(notice = '') {
        this.card = null; this.dirty = false; this.filter = this.filter || { mode: 'book', q: '', rating: '', platform: '', background: '', tag: '' };
        this.filter.layout ||= 'cards';
        this.filter.sort ||= 'default';
        this.shell('读书档案', 'archive'); this.status.textContent = notice;
        const actions = node('div', null, 'reader-review-actions reader-archive-toolbar');
        this.fileInput = node('input'); this.fileInput.type = 'file'; this.fileInput.accept = '.xlsx'; this.fileInput.hidden = true; this.fileInput.id = 'reader-archive-import';
        this.fileInput.addEventListener('change', () => { if (this.fileInput.files[0]) this.previewImport(this.fileInput.files[0]); });
        const create = button('新建记录', () => this.openCard(), 'new-record'); create.classList.add('reader-review-primary');
        actions.append(create, button('导入 xlsx', () => this.fileInput.click(), 'import-xlsx'), this.fileInput); this.dialog.append(actions);
        const filters = node('div', null, 'reader-archive-filters');
        const control = (label, input, className = '') => {
            const wrapper = node('label', null, `reader-archive-filter ${className}`); wrapper.append(node('span', label), input); filters.append(wrapper);
        };
        const mode = select([['book', '按书'], ['tag', '按标签']], this.filter.mode); mode.setAttribute('aria-label', '档案分法'); mode.id = 'archive-mode';
        mode.addEventListener('change', () => { this.filter.mode = mode.value; this.filter.tag = ''; this.loadArchive(); }); control('分组', mode);
        const layout = select([['cards', '卡片'], ['table', '表格']], this.filter.layout); layout.id = 'archive-layout'; layout.setAttribute('aria-label', '展示方式');
        layout.addEventListener('change', () => { this.filter.layout = layout.value; this.paintArchive(); }); control('展示', layout);
        const sort = select([['default', '默认顺序'], ['finished', '最近读完优先']], this.filter.sort); sort.id = 'archive-sort'; sort.setAttribute('aria-label', '档案排序');
        sort.addEventListener('change', () => { this.filter.sort = sort.value; this.archivePage = 0; this.paintArchive(); }); control('排序', sort);
        const search = node('input'); search.type = 'search'; search.placeholder = '书名或作者'; search.value = this.filter.q; search.setAttribute('aria-label', '搜索书名或作者');
        search.addEventListener('input', () => { this.filter.q = search.value; clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.loadArchive(), 250); }); control('查找', search, 'search');
        for (const key of ['rating', 'platform', 'background']) {
            const field = REVIEW_FIELDS.find(field => field.key === key);
            const input = select([['', `全部${field.label}`], ...field.options.map(value => [value, value])], this.filter[key]); input.id = `archive-${key}`; input.setAttribute('aria-label', field.label);
            input.addEventListener('change', () => { this.filter[key] = input.value; this.loadArchive(); }); control(key === 'rating' ? '评价' : key === 'background' ? '背景' : field.label, input);
        }
        this.tags = node('div', null, 'reader-archive-tags'); this.archiveList = node('div'); this.archiveList.id = 'reader-archive-list';
        this.dialog.append(filters, this.tags, this.archiveList); await this.loadArchive();
    }
    async loadArchive() {
        const generation = this.archiveGeneration = (this.archiveGeneration || 0) + 1;
        try {
            const params = new URLSearchParams(Object.entries(this.filter).filter(([key, value]) => !['mode', 'tag', 'layout', 'sort'].includes(key) && value));
            const records = await (await readerSync.request(`/archives?${params}`)).json();
            if (this.mode !== 'archive' || this.overlay.hidden || generation !== this.archiveGeneration) return;
            this.records = records; this.archivePage = 0; this.paintArchive();
        } catch { this.status.textContent = '档案读取失败，请稍后重新打开。'; }
    }
    paintArchive() {
        this.tags.replaceChildren(); this.archiveList.replaceChildren();
        if (this.filter.mode === 'tag') {
            const counts = new Map(); for (const record of this.records) for (const tag of record.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
            for (const [tag, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
                const chip = button(`${tag} (${count})`, () => this.filterTag(this.filter.tag === tag ? '' : tag));
                chip.dataset.tag = tag; chip.classList.toggle('selected', this.filter.tag === tag); chip.setAttribute('aria-pressed', String(this.filter.tag === tag)); this.tags.append(chip);
            }
        }
        const records = this.records.filter(record => this.filter.mode !== 'tag' || !this.filter.tag || record.tags.includes(this.filter.tag));
        if (this.filter.sort === 'finished') records.sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || b.id - a.id);
        else if (this.filter.mode === 'book') records.sort((a, b) => `${a.title}\0${a.author}`.localeCompare(`${b.title}\0${b.author}`, 'zh') || b.id - a.id);
        const overview = node('div', null, 'reader-archive-overview');
        const bookCount = new Set(records.map(record => `${record.title}\0${record.author}`)).size;
        for (const [value, label] of [[records.length, '条记录'], [bookCount, '本书'], [records.filter(record => record.fields.completed === '已看完').length, '条已看完']]) {
            const metric = node('div'); metric.append(node('strong', value), node('span', label)); overview.append(metric);
        }
        this.archiveList.append(overview);
        if (this.filter.tag) {
            const active = node('div', null, 'reader-archive-active-filter'); active.append(node('span', `标签：${this.filter.tag}`), button('清除筛选', () => this.filterTag(''), 'clear-tag'));
            this.archiveList.append(active);
        }
        const pageRecords = records.slice(this.archivePage * 30, (this.archivePage + 1) * 30);
        if (this.filter.layout === 'table' && records.length) {
            this.archiveList.append(node('p', '表格可左右滚动，查看全部字段。', 'reader-review-hint'), this.archiveTable(pageRecords));
        }
        else {
            const grid = node('div', null, 'reader-archive-grid');
            for (const record of pageRecords) {
                const item = node('article', null, 'reader-archive-item'); item.dataset.recordId = record.id; item.dataset.rating = RATING_TONES[record.fields.rating] || 'unset';
                const heading = node('div', null, 'reader-archive-book-heading'); heading.append(this.archiveTitle(record), ratingBadge(record.fields.rating)); item.append(heading);
                item.append(node('div', [recordDate(record), record.fields.platform, record.fields.completed].filter(Boolean).join(' · '), 'reader-archive-summary'));
                if (record.fields.characters) item.append(node('p', `角色：${record.fields.characters}`, 'reader-archive-characters'));
                const details = node('dl', null, 'reader-archive-details');
                for (const [label, values, kind] of this.archiveDimensions(record)) {
                    const row = node('div'); row.append(node('dt', label), this.archiveChips(values, kind, 'dd')); details.append(row);
                }
                item.append(details);
                if (record.reflection) item.append(node('p', record.reflection, 'reader-archive-reflection'));
                if (record.warnings.length) item.append(node('div', '含导入警告 · 查看记录了解详情', 'reader-review-warning'));
                item.append(this.archiveActions(record)); grid.append(item);
            }
            this.archiveList.append(grid);
        }
        if (!records.length) {
            const empty = node('div', null, 'reader-archive-empty'); empty.append(node('h3', '还没有符合条件的记录'), node('p', '试试调整筛选，或导入以前的问卷记录。')); this.archiveList.append(empty);
        }
        if (records.length > 30) {
            const previous = button('上一页', () => { this.archivePage--; this.paintArchive(); }); previous.disabled = this.archivePage === 0;
            const next = button('下一页', () => { this.archivePage++; this.paintArchive(); }); next.disabled = (this.archivePage + 1) * 30 >= records.length;
            const pagination = node('nav', null, 'reader-archive-pagination'); pagination.setAttribute('aria-label', '档案分页');
            pagination.append(previous, node('span', ` ${this.archivePage + 1} / ${Math.ceil(records.length / 30)} `), next); this.archiveList.append(pagination);
        }
    }
    filterTag(tag) {
        this.filter.mode = 'tag'; this.filter.tag = tag; this.archivePage = 0;
        this.dialog.querySelector('#archive-mode').value = 'tag'; this.paintArchive();
    }
    archiveTitle(record) {
        const title = node('div', null, 'reader-archive-book-title'); title.append(node('h3', record.title), node('span', record.author, 'reader-archive-author')); return title;
    }
    archiveDimensions(record) {
        const fields = record.fields;
        const subjects = REVIEW_FIELDS.filter(field => field.when === fields.background).flatMap(field => fields[field.key] || []);
        return [['视角 / 关系', [fields.perspective, fields.relationship].filter(Boolean), 'relationship'],
            ['背景 / 题材', [fields.background, ...subjects].filter(Boolean), 'subject'],
            ['故事风格', fields.style || [], 'style'], ['补充标签', extraTags(fields), 'extra']];
    }
    archiveChips(values, kind, tag = 'div') {
        const chips = node(tag, null, `reader-archive-chips ${kind}`);
        if (!values.length) chips.append(node('span', '未填写', 'reader-review-hint'));
        for (const value of values) {
            const chip = button(value, () => this.filterTag(value)); chip.dataset.filterTag = value; chip.title = `按“${value}”筛选档案`; chips.append(chip);
        }
        return chips;
    }
    archiveActions(record) {
        const actions = node('div', null, 'reader-review-actions reader-archive-record-actions');
        actions.append(button('查看 / 编辑', () => this.openCard(record.bookId, record.id), 'edit-record'));
        if (record.hasBook) actions.append(button('去阅读', () => this.readBook(record.bookId), 'read-book'));
        else actions.append(node('span', '无对应原文', 'reader-review-hint'));
        actions.append(button(record.hasBook ? '更换关联原文' : '选一本书关联', () => this.openBookLink(record), 'link-book'));
        const remove = button('删除', () => this.deleteRecord(record), 'delete-record'); remove.classList.add('reader-review-danger'); actions.append(remove); return actions;
    }
    archiveTable(records) {
        const wrapper = node('div', null, 'reader-archive-table-wrap'); wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '读书档案表格，可横向滚动');
        const table = node('table', null, 'reader-archive-table'), head = node('thead'), headings = node('tr');
        for (const label of ['书籍', '评价', '视角 / 关系', '背景 / 题材', '故事风格', '补充标签', '平台 / 日期', '操作']) { const heading = node('th', label); heading.scope = 'col'; headings.append(heading); }
        head.append(headings); table.append(head); const body = node('tbody'); table.append(body);
        for (const record of records) {
            const row = node('tr', null, 'reader-archive-item'); row.dataset.recordId = record.id; row.dataset.rating = RATING_TONES[record.fields.rating] || 'unset';
            const book = node('td'); book.append(this.archiveTitle(record));
            if (record.fields.characters) book.append(node('p', `角色：${record.fields.characters}`, 'reader-archive-characters'));
            if (record.warnings.length) book.append(node('span', '含导入警告', 'reader-review-warning'));
            const rating = node('td'); rating.append(ratingBadge(record.fields.rating), node('div', record.fields.completed || '未填写', 'reader-review-hint')); row.append(book, rating);
            for (const [, values, kind] of this.archiveDimensions(record)) { const cell = node('td'); cell.append(this.archiveChips(values, kind)); row.append(cell); }
            const metadata = node('td'); metadata.append(node('div', record.fields.platform || '未填写'));
            const date = node('time', recordDate(record).split(' ')[0]); date.dateTime = date.textContent; date.title = recordDate(record); metadata.append(date); row.append(metadata);
            const actions = node('td'); actions.append(this.archiveActions(record)); row.append(actions); body.append(row);
        }
        wrapper.append(table); return wrapper;
    }
    async openBookLink(record) {
        const generation = this.linkGeneration = (this.linkGeneration || 0) + 1;
        this.shell('选一本书关联', 'link'); this.status.textContent = '正在读取已上传的书籍…';
        const status = this.status;
        const active = () => this.mode === 'link' && !this.overlay.hidden && generation === this.linkGeneration;
        const cancel = button('返回档案', () => this.openArchive(), 'cancel-book-link');
        this.dialog.append(node('p', `为《${record.title}》选择原文；书名或作者不同也可以关联，档案里的评价、标签和感想会保留。`));
        try {
            const [books, archives] = await Promise.all([readerSync.request('/books').then(r => r.json()), readerSync.request('/archives').then(r => r.json())]);
            const occupied = new Set(archives.filter(card => card.bookId && card.id !== record.id).map(card => card.bookId));
            if (!active()) return;
            books.sort((a, b) => `${a.title}\0${a.author}`.localeCompare(`${b.title}\0${b.author}`, 'zh'));
            status.textContent = '';
            const search = node('input'); search.type = 'search'; search.id = 'archive-book-search'; search.placeholder = '搜索书名、作者或文件名';
            const label = node('label', '查找已上传的 TXT', 'reader-archive-book-search'); label.htmlFor = search.id;
            this.dialog.append(label, search);
            const list = node('div', null, 'reader-archive-book-options');
            let selectedId = record.bookId, saving = false;
            const confirm = button('确认关联', async () => {
                if (saving || !selectedId || selectedId === record.bookId) return;
                const book = books.find(book => book.id === selectedId);
                saving = true; confirm.disabled = true;
                try {
                    await this.json(`/archives/${record.id}`, { bookId: book.id, updatedAt: record.updatedAt }, 'PATCH');
                    for (const [bookId, candidates] of this.linkQueue) {
                        const remaining = candidates.filter(candidate => candidate.id !== record.id);
                        if (remaining.length) this.linkQueue.set(bookId, remaining); else this.linkQueue.delete(bookId);
                    }
                    this.paintLinks();
                    if (active()) await this.openArchive(`已为《${record.title}》关联《${book.title}》。`);
                } catch (error) {
                    if (active()) status.textContent = error.data?.code === 'archive_book_conflict' ? error.data.error : error.status === 409 ? '这条档案已在另一处更新，请返回档案后重新关联。' : '关联未完成，请检查连接或原文是否仍在书架后重试。';
                } finally { saving = false; confirm.disabled = !selectedId || selectedId === record.bookId; }
            }, 'confirm-book-link');
            confirm.classList.add('reader-review-primary'); confirm.disabled = true;
            const selection = node('p', '', 'reader-review-hint'); selection.setAttribute('aria-live', 'polite');
            const updateSelection = () => {
                const book = books.find(book => book.id === selectedId);
                selection.textContent = book ? `已选：${book.title} · ${book.author || '作者未识别'} · ${book.filename}` : '请选择一本书，再确认关联。';
                confirm.disabled = saving || !book || selectedId === record.bookId;
            };
            const paint = () => {
                list.replaceChildren();
                const query = search.value.trim().toLowerCase();
                const matches = books.filter(book => `${book.title} ${book.author} ${book.filename}`.toLowerCase().includes(query));
                for (const book of matches) {
                    const option = node('label', null, 'reader-archive-book-option');
                    const radio = node('input'); radio.type = 'radio'; radio.name = 'archive-book'; radio.value = book.id; radio.checked = book.id === selectedId; radio.disabled = occupied.has(book.id);
                    radio.addEventListener('change', () => { selectedId = book.id; updateSelection(); });
                    const details = node('div'); details.append(node('strong', book.title), node('span', book.author || '作者未识别'),
                        node('span', `${book.filename} · ${(book.size / 1024).toFixed(1)} KB · 上传于 ${book.createdAt.slice(0, 10)}`, 'reader-review-hint'));
                    if (occupied.has(book.id)) details.append(node('span', '已有读书卡片，不能重复关联', 'reader-review-hint'));
                    option.append(radio, details); list.append(option);
                }
                if (!matches.length) list.append(node('p', books.length ? '没有匹配的书，试试其他关键词。' : '还没有已上传的 TXT，请先在书架上传，再回来关联。', 'reader-review-hint'));
            };
            search.addEventListener('input', paint);
            const actions = node('div', null, 'reader-review-actions'); actions.append(confirm, cancel);
            this.dialog.append(list, selection, actions); updateSelection(); paint(); search.focus();
        } catch { if (active()) { status.textContent = '书籍列表读取失败，请返回档案后重试。'; this.dialog.append(cancel); } }
    }
    async readBook(bookId) {
        try {
            const { bookshelf } = await import('./bookshelf.js');
            this.close(); if (!await bookshelf.openBook(cacheKey(bookId))) throw new Error('Open failed');
        } catch { this.openArchive('原文暂时无法打开，请检查连接。'); }
    }
    async deleteRecord(record) {
        if (!window.confirm(`删除《${record.title}》的这条读书记录？`)) return;
        try { await readerSync.request(`/archives/${record.id}`, { method: 'DELETE' }); this.loadArchive(); }
        catch { this.status.textContent = '删除尚未完成，请重试。'; }
    }
    async previewImport(file) {
        this.status.textContent = '正在预览文件…';
        try {
            const preview = await (await readerSync.request(`/archive-import/preview?filename=${encodeURIComponent(file.name)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: await file.arrayBuffer() })).json();
            if (this.overlay.hidden) return;
            this.importPreview = preview; this.importPage = 0;
            this.importSelected = new Set(preview.rows.filter(row => !row.errors.length && !row.duplicate).map(row => row.row));
            this.importLinks = Object.fromEntries(preview.rows.filter(row => row.record).map(row => [row.row, row.record.bookId])); this.paintImport();
        } catch (error) { this.status.textContent = error.data?.error || '文件预览失败，请检查 xlsx 或连接。'; }
    }
    paintImport() {
        this.shell('导入预览', 'import');
        const preview = this.importPreview;
        const errors = preview.rows.filter(row => row.errors.length).length, duplicates = preview.rows.filter(row => row.duplicate).length;
        this.dialog.append(node('p', `${preview.filename} · ${preview.rows.length} 行 · ${errors} 行错误 · ${duplicates} 行重复`),
            node('p', '黄底含未识别列、未知选项或联动不一致；未识别列保存在原始字段，未知或不适用选项放入补充标签。错误行不会导入，确认后才写入档案。'));
        const actions = node('div', null, 'reader-review-actions');
        actions.append(button('全选可导入行', () => { this.importSelected = new Set(preview.rows.filter(row => !row.errors.length && !row.duplicate).map(row => row.row)); this.paintImport(); }),
            button('清空选择', () => { this.importSelected.clear(); this.paintImport(); })); this.dialog.append(actions);
        const wrapper = node('div', null, 'reader-import-table-wrap'), table = node('table', null, 'reader-import-table'), head = node('thead'), headings = node('tr');
        for (const text of ['选择', '原表行', '书名 / 作者', '提交时间', '状态 / 提示', '关联原文']) headings.append(node('th', text));
        head.append(headings); table.append(head); const body = node('tbody'); table.append(body); wrapper.append(table); this.dialog.append(wrapper);
        for (const row of preview.rows.slice(this.importPage * 100, (this.importPage + 1) * 100)) {
            const tr = node('tr'); tr.dataset.row = row.row; tr.classList.toggle('invalid', Boolean(row.errors.length)); tr.classList.toggle('warning', Boolean(row.warnings.length));
            const chosen = node('input'); chosen.type = 'checkbox'; chosen.checked = this.importSelected.has(row.row); chosen.disabled = Boolean(row.errors.length || row.duplicate);
            chosen.setAttribute('aria-label', `导入第 ${row.row} 行`); chosen.addEventListener('change', () => { if (chosen.checked) this.importSelected.add(row.row); else this.importSelected.delete(row.row); this.updateImportButton(); });
            const choice = node('td'); choice.append(chosen); tr.append(choice, node('td', row.row), node('td', row.record ? `${row.record.title}\n${row.record.author}` : '无效记录'), node('td', row.record?.submittedAt || ''));
            const messages = [...row.errors, ...row.warnings.map(warningText), ...(row.duplicate ? ['重复记录，将跳过'] : [])];
            tr.append(node('td', messages.join('\n') || '可导入'));
            const association = node('td');
            if (row.candidates.length) {
                const input = select([['', '不关联'], ...row.candidates.map(book => [book.id, book.filename + (book.hasArchive ? '（已有卡片）' : '')])], this.importLinks[row.row] || '');
                for (const option of input.options) if (row.candidates.some(book => book.id === option.value && book.hasArchive)) option.disabled = true;
                input.setAttribute('aria-label', `第 ${row.row} 行关联书籍`); input.addEventListener('change', () => { this.importLinks[row.row] = input.value || null; }); association.append(input);
            } else association.append(node('span', '暂无对应 txt'));
            tr.append(association); body.append(tr);
        }
        if (preview.rows.length > 100) {
            const previous = button('上一页', () => { this.importPage--; this.paintImport(); }); previous.disabled = this.importPage === 0;
            const next = button('下一页', () => { this.importPage++; this.paintImport(); }); next.disabled = (this.importPage + 1) * 100 >= preview.rows.length;
            this.dialog.append(previous, node('span', ` ${this.importPage + 1} / ${Math.ceil(preview.rows.length / 100)} `), next);
        }
        this.importButton = button('', () => this.commitImport(), 'confirm-import');
        this.dialog.append(this.importButton, button('返回档案', () => this.openArchive(), 'cancel-import')); this.updateImportButton();
    }
    updateImportButton() { this.importButton.textContent = `导入已选 ${this.importSelected.size} 行`; this.importButton.disabled = !this.importSelected.size || this.importing; }
    async commitImport() {
        if (this.importing) return;
        this.importing = true; this.updateImportButton();
        try {
            const result = await this.json('/archive-import/commit', { previewId: this.importPreview.previewId,
                rows: [...this.importSelected], links: this.importLinks });
            await this.openArchive(`已导入 ${result.imported} 条，跳过 ${result.duplicates} 条重复记录。`);
        } catch (error) { this.status.textContent = error.status === 410 ? '预览已过期，请重新选择文件。' : '导入未完成，请重新预览或检查连接后重试。'; }
        finally { this.importing = false; if (this.mode === 'import') this.updateImportButton(); }
    }
    async checkLinks(bookId) {
        if (this.dismissedLinks.has(bookId)) return;
        try {
            const candidates = await (await readerSync.request(`/books/${bookId}/archive-candidates`)).json();
            if (candidates.length) this.linkQueue.set(bookId, candidates); else this.linkQueue.delete(bookId);
            this.paintLinks();
        } catch { /* An offline upload will be checked when its retry succeeds. */ }
    }
    paintLinks() {
        this.links.replaceChildren(); this.links.hidden = this.linkQueue.size === 0;
        for (const [bookId, records] of this.linkQueue) {
            const choice = node('select'); choice.setAttribute('aria-label', '选择唯一关联的档案');
            for (const record of records) { const option = node('option', `记录 #${record.id} · ${record.submittedAt || '未填写日期'}`); option.value = record.id; choice.append(option); }
            const item = node('div'); item.append(node('p', `《${records[0].title}》有 ${records.length} 条同名同作者档案，请选一张关联。`), choice,
                button('关联原文', async () => {
                    try { await this.json(`/books/${bookId}/archive-link`, { recordIds: [Number(choice.value)] }); this.linkQueue.delete(bookId); this.paintLinks(); if (this.mode === 'archive' && !this.overlay.hidden) this.loadArchive(); }
                    catch { item.append(node('p', '关联未完成，请重新打开档案后重试。')); }
                }, 'link-archives'), button('暂不关联', () => { this.dismissedLinks.add(bookId); this.linkQueue.delete(bookId); this.paintLinks(); }));
            this.links.append(item);
        }
    }
}
export const readerReviews = new ReaderReviews();
