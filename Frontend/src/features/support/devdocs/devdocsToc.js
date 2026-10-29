/**
 * devdocsToc.js — heading slugs and table-of-contents extraction.
 *
 * ONE SLUGIFY, TWO CALLERS. `MarkdownDoc` uses it to put `id` on each rendered
 * heading; `buildToc` uses it to produce the nav entries. Sharing the function
 * is what stops the two drifting into pointing at anchors that do not exist —
 * the earlier version collected entries during the render pass to guarantee
 * that, which meant writing to a ref mid-render and pushing state up through an
 * effect. Deriving both from the same pure function gets the same guarantee
 * with none of that.
 *
 * The one place a naive extraction WOULD drift from the renderer is a "#" at
 * the start of a line inside a fenced code block: markdown does not treat it as
 * a heading, but a line-by-line regex does. `buildToc` strips fences first, so
 * the two agree on what a heading is as well as on what it is called.
 */

/**
 * Turns heading text into a stable anchor slug.
 *
 * Stability matters more than prettiness: an admin links a colleague to a
 * section, so the same heading must yield the same slug on every render and
 * across restarts.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
    return String(text ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Extracts the h2/h3 outline of a markdown document.
 *
 * h1 is the document title and is already shown in the breadcrumb; h4 and
 * deeper is detail that would make the nav longer than the reader's screen.
 *
 * @param {string} markdown
 * @returns {Array<{ id: string, depth: number, text: string }>}
 */
export function buildToc(markdown) {
    if (!markdown) return [];

    // Strip fenced blocks before scanning — see the file header.
    const withoutFences = String(markdown).replace(/^```[\s\S]*?^```/gm, "");

    const out = [];
    for (const line of withoutFences.split(/\r?\n/)) {
        const match = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
        if (!match) continue;
        const depth = match[1].length;
        // Strip inline markdown so "## `foo` bar" slugs the same way the
        // rendered heading's text content does.
        const text = match[2].replace(/[`*_]/g, "").trim();
        const id = slugify(text);
        if (!id) continue;
        out.push({ id, depth, text });
    }
    return out;

    // NOT DEDUPED, on purpose. Appending "-1" to a repeated heading here would
    // require the renderer to count occurrences in render order to match —
    // which is the render-time state this module exists to avoid. Two headings
    // with identical text therefore share an anchor, and a click on the second
    // lands on the first. That is a small, predictable miss; a TOC whose links
    // point at ids the document does not contain is a worse one.
}
