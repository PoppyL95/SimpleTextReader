/** Original UTF-8 txt coordinates are 1-based and include blank lines.
 * Render coordinates follow the existing processor: cleaned nonempty lines + title page.
 * Offsets are UTF-16 code units, matching DOM Range and JavaScript strings.
 */
export function createLineMap(text, titlePageLines = 2) {
    const raw = text.split('\n');
    const rendered = [];
    const original = new Map();
    raw.forEach((line, index) => {
        let start = 0;
        for (const segment of line.split('\r')) {
            const part = segment.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
            const source = { line: index + 1, start, end: start + segment.length };
            start += segment.length + 1;
            if (!part.trim()) continue;
            const renderLine = rendered.length + titlePageLines;
            rendered.push(source);
            if (!original.has(index + 1)) original.set(index + 1, renderLine);
        }
    });
    return {
        raw, titlePageLines,
        toOriginal(renderLine) {
            if (renderLine < titlePageLines) return 1;
            return rendered[renderLine - titlePageLines]?.line ?? raw.length;
        },
        source(renderLine) { return rendered[renderLine - titlePageLines] ?? null; },
        characters(renderLine, visibleText) {
            const source = this.source(renderLine);
            return source ? alignCharacters(raw[source.line - 1], visibleText, source.start, source.end) : null;
        },
        toRendered(rawLine) {
            if (original.has(rawLine)) return original.get(rawLine);
            // Blank lines have no DOM node. Use the next visible line, otherwise the previous one.
            for (let line = rawLine + 1; line <= raw.length; line++) if (original.has(line)) return original.get(line);
            for (let line = rawLine - 1; line > 0; line--) if (original.has(line)) return original.get(line);
            return titlePageLines;
        },
    };
}

/** Map rendered UTF-16 characters back through trimming, removed symbols, HTML and drop caps.
 * Refuse unrecognizable transformations rather than saving an incorrect anchor.
 */
export function alignCharacters(raw, visible, start = 0, end = raw.length) {
    const characters = [];
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    for (let i = start; i < end;) {
        if (raw[i] === '<') {
            const tag = /^<[^>]*>/.exec(raw.slice(i, end));
            if (tag) { i += tag[0].length; continue; }
        }
        if (raw[i] === '&') {
            const entity = /^&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/i.exec(raw.slice(i, end));
            if (entity) {
                const code = entity[1][0] === '#' ? Number.parseInt(entity[1].slice(entity[1][1].toLowerCase() === 'x' ? 2 : 1), entity[1][1].toLowerCase() === 'x' ? 16 : 10) : null;
                const decoded = code == null ? entities[entity[1].toLowerCase()] : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
                if (decoded) {
                    for (const char of decoded.split('')) characters.push({ char, start: i, end: i + entity[0].length });
                    i += entity[0].length; continue;
                }
            }
        }
        if (!/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD\x00-\x08\x0B\x0C\x0E-\x1F\x7F\r]/.test(raw[i])) {
            characters.push({ char: raw[i], start: i, end: i + 1 });
        }
        i++;
    }
    // Prefer a contiguous match so an earlier partial repetition (e.g. stripped
    // advertising text) cannot steal characters from the displayed paragraph.
    const cleaned = characters.map(item => item.char).join('');
    const exact = cleaned.indexOf(visible);
    if (exact >= 0 && cleaned.indexOf(visible, exact + 1) < 0) return characters.slice(exact, exact + visible.length);
    if (exact >= 0) return null; // Ambiguous repeated text must not produce a guessed anchor.
    const positions = [];
    const matches = (original, displayed) => original.toLowerCase() === displayed.toLowerCase() ||
        (displayed === ' ' && /[:：\u00a0]/.test(original));
    let cursor = 0;
    for (const char of visible.split('')) {
        while (cursor < characters.length && !matches(characters[cursor].char, char)) cursor++;
        if (cursor === characters.length) return null;
        positions.push(characters[cursor++]);
    }
    // The earliest and latest possible alignment must agree. Otherwise repeated
    // characters around removed content make the anchor ambiguous.
    cursor = characters.length - 1;
    for (let index = visible.length - 1; index >= 0; index--) {
        while (cursor >= 0 && !matches(characters[cursor].char, visible[index])) cursor--;
        if (cursor < 0 || characters[cursor].start !== positions[index].start || characters[cursor].end !== positions[index].end) return null;
        cursor--;
    }
    return positions;
}

export function selectionQuote(rawLines, { startLine, startOffset, endLine, endOffset }) {
    const lines = rawLines.slice(startLine - 1, endLine);
    lines[lines.length - 1] = lines.at(-1).slice(0, endOffset);
    lines[0] = lines[0].slice(startOffset);
    return lines.join('\n');
}
