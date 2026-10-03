import * as CONFIG from '../../config/index.js';
import { cbReg } from '../../../../shared/core/callback/callback-registry.js';

const narrowScreen = window.matchMedia('(max-width: 600px)');
export const isNarrowReader = () => narrowScreen.matches;

/** A temporary mobile drawer leaves the saved desktop sidebar width intact. */
export function initMobileReader() {
    const sidebar = document.querySelector('.sidebar-splitview-sidebar');
    const content = CONFIG.DOM_ELEMENT.CONTENT_CONTAINER;
    const toolbar = document.createElement('nav'); toolbar.id = 'reader-mobile-toolbar';
    toolbar.setAttribute('aria-label', '阅读导航');
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.id = 'reader-mobile-toc-toggle';
    toggle.textContent = '目录'; toggle.setAttribute('aria-controls', 'toc-content'); toggle.setAttribute('aria-expanded', 'false');
    toolbar.append(toggle);
    const backdrop = document.createElement('button'); backdrop.type = 'button'; backdrop.id = 'reader-mobile-toc-backdrop';
    backdrop.setAttribute('aria-label', '关闭目录'); backdrop.hidden = true;
    document.body.append(toolbar, backdrop);

    const close = (focus = false) => {
        document.body.classList.remove('reader-mobile-toc-open'); backdrop.hidden = true;
        toggle.textContent = '目录'; toggle.setAttribute('aria-expanded', 'false'); content.inert = false;
        sidebar.inert = isNarrowReader();
        if (isNarrowReader()) sidebar.setAttribute('aria-hidden', 'true'); else sidebar.removeAttribute('aria-hidden');
        if (focus) toggle.focus({ preventScroll: true });
    };
    toggle.addEventListener('click', () => {
        if (!isNarrowReader() || !CONFIG.VARS.IS_BOOK_OPENED) return;
        if (toggle.getAttribute('aria-expanded') === 'true') { close(true); return; }
        document.body.classList.add('reader-mobile-toc-open'); backdrop.hidden = false;
        toggle.textContent = '收起目录'; toggle.setAttribute('aria-expanded', 'true'); content.inert = true;
        sidebar.inert = false; sidebar.removeAttribute('aria-hidden');
        sidebar.querySelector('.toc-text:not(.hidden)')?.focus({ preventScroll: true });
    });
    backdrop.addEventListener('click', () => close(true));
    CONFIG.DOM_ELEMENT.TOC_CONTAINER.addEventListener('click', event => {
        if (isNarrowReader() && event.target.closest('a[href^="#line"]')) close(true);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.body.classList.contains('reader-mobile-toc-open')) {
            event.preventDefault(); event.stopImmediatePropagation(); close(true);
        }
    }, true);
    narrowScreen.addEventListener('change', () => close());
    for (const type of ['reader:book-opening', 'reader:book-closed']) document.addEventListener(type, () => {
        close(); document.body.classList.remove('reader-mobile-book-open');
    });
    document.addEventListener('reader:book-opened', () => {
        close(); document.body.classList.add('reader-mobile-book-open');
    });
    // Local books can open before migration into the server-backed catalog.
    cbReg.add('fileAfter', () => {
        close(); document.body.classList.toggle('reader-mobile-book-open', Boolean(CONFIG.VARS.IS_BOOK_OPENED));
    });
    document.body.classList.toggle('reader-mobile-book-open', Boolean(CONFIG.VARS.IS_BOOK_OPENED));
    close();
}

/** Mobile reading appearance is separate from the saved desktop typography/colors. */
export function applyMobileReadingTheme(value) {
    document.documentElement.dataset.readerMobileTheme = value === 'original' ? 'original' : 'warm-brown';
    document.dispatchEvent(new Event('reader:mobile-theme'));
}
applyMobileReadingTheme(localStorage.getItem('mobile_reading_theme'));
