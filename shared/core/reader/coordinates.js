/** Original UTF-8 txt coordinates are 1-based and include blank lines.
 * Render coordinates follow the existing processor: cleaned nonempty lines + title page.
 * Offsets are UTF-16 code units, matching DOM Range and JavaScript strings.
 */
export function createLineMap(text, titlePageLines = 2) {
    const raw = text.split('\n');
    const rendered = [];
    const original = new Map();
    raw.forEach((line, index) => {
        const cleaned = line.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g, '')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\r/g, '\n');
        for (const part of cleaned.split('\n')) {
            if (!part.trim()) continue;
            const renderLine = rendered.length + titlePageLines;
            rendered.push(index + 1);
            if (!original.has(index + 1)) original.set(index + 1, renderLine);
        }
    });
    return {
        raw, titlePageLines,
        toOriginal(renderLine) {
            if (renderLine < titlePageLines) return 1;
            return rendered[renderLine - titlePageLines] ?? raw.length;
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
