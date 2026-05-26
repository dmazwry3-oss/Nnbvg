/* ===================================================================
   classifier.js
   Assigns a semantic `type` to every block:
     "title" | "authors" | "abstract" | "heading" | "paragraph" |
     "caption" | "table" | "figure" | "reference" |
     "header" | "footer" | "pagenum"

   Decision rules (in order):
     1. kind === "figure"             → "figure"
     2. position in top 6% / bottom 6% → "header" / "footer"
        (pure number → "pagenum")
     3. starts with caption marker     → "caption"
     4. >= 3 lines with multiple wide-gap columns → "table"
        (also fills b.rows[][])
     5. font ≥ 1.15× median or short bold line → "heading"
     6. else                           → "paragraph"

   Then a section-aware sweep promotes:
     - largest first-page block       → "title"
     - block right after title        → "authors"
     - paragraphs under "Abstract"    → "abstract"
     - paragraphs under "References"  → "reference"
   =================================================================== */

export function classifyDocument(pages) {
    // Flatten and attach page metadata
    const all = [];
    for (const p of pages) {
        for (const b of p.blocks) {
            b.page = p.pageNumber;
            b.pageW = p.width;
            b.pageH = p.height;
            all.push(b);
        }
    }

    // Compute global median font size across actual text blocks
    const sizes = all.filter((b) => b.kind === "text").map((b) => b.fontSize || 0);
    const medianSize = median(sizes) || 10;

    // First pass: rule-based per-block classification
    for (const b of all) classifyBlock(b, medianSize);

    // Second pass: section-aware promotion
    promoteTitleAndAuthors(all, medianSize);
    promoteSections(all);

    return all;
}

/* ----------- Per-block rules ----------- */
const CAPTION_RE = /^(Figure|Fig\.?|Table|Tabel|Gambar|Bagan|Diagram)\s*\d+/i;

function classifyBlock(b, medianSize) {
    if (b.kind === "figure") {
        b.type = "figure";
        return;
    }

    const text = (b.text || (b.lines || []).join(" ")).trim();
    b.text = text;

    // header / footer / pagenum (margin regions)
    if (b.pageH) {
        const topRatio = b.y / b.pageH;
        const bottomRatio = (b.y + b.h) / b.pageH;
        if (topRatio < 0.06) {
            b.type = /^\s*\d+\s*$/.test(text) ? "pagenum" : "header";
            return;
        }
        if (bottomRatio > 0.94) {
            b.type = /^\s*\d+\s*$/.test(text) || /\bpage\s+\d+/i.test(text)
                ? "pagenum"
                : "footer";
            return;
        }
    }

    // caption
    if (CAPTION_RE.test(text)) {
        b.type = "caption";
        return;
    }

    // table heuristic: >= 3 lines, majority of which contain wide gaps
    if (b.rawLines && b.rawLines.length >= 3) {
        const tabbed = b.rawLines.filter((l) => / {3,}|\t/.test(l.text)).length;
        if (tabbed / b.rawLines.length >= 0.5) {
            b.type = "table";
            b.rows = b.rawLines.map((l) =>
                l.text
                    .split(/ {2,}|\t+/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
            );
            // reject degenerate single-column "tables"
            const maxCols = Math.max(...b.rows.map((r) => r.length));
            if (maxCols < 2) {
                b.type = "paragraph";
                delete b.rows;
            } else {
                return;
            }
        }
    }

    // heading: notably larger font OR short bold line
    const isLargeFont = b.fontSize >= medianSize * 1.15;
    const isShortBold = b.bold && text.length > 0 && text.length < 120;
    if ((isLargeFont || isShortBold) && (b.lines || []).length <= 3 && text.length < 220) {
        b.type = "heading";
        b.level =
            b.fontSize >= medianSize * 1.5
                ? 1
                : b.fontSize >= medianSize * 1.25
                ? 2
                : 3;
        return;
    }

    b.type = "paragraph";
}

/* ----------- Title & authors on page 1 ----------- */
function promoteTitleAndAuthors(all, medianSize) {
    const firstPage = all.filter((b) => b.page === 1 && b.kind === "text");
    if (!firstPage.length) return;

    const maxFs = firstPage.reduce((m, b) => Math.max(m, b.fontSize || 0), 0);
    const titleCandidate = firstPage.find(
        (b) => (b.fontSize || 0) === maxFs && (b.fontSize || 0) >= medianSize * 1.4
    );
    if (!titleCandidate) return;
    titleCandidate.type = "title";

    // Authors: a paragraph or heading right after the title (within next 4 blocks
    // on page 1) that contains commas / "and" / "&" and isn't terminated by ".".
    const idx = firstPage.indexOf(titleCandidate);
    for (let i = idx + 1; i < Math.min(idx + 5, firstPage.length); i++) {
        const b = firstPage[i];
        const t = (b.text || "").trim();
        if (!t || t.length > 280) continue;
        if (/[,;]|\band\b|\&/.test(t) && !/\.\s*$/.test(t)) {
            b.type = "authors";
            break;
        }
    }
}

/* ----------- Abstract & References sweep ----------- */
function promoteSections(all) {
    let inAbstract = false;
    let inRefs = false;
    for (const b of all) {
        if (b.type === "heading") {
            const t = (b.text || "").trim();
            if (/^(abstract|abstrak)\b/i.test(t)) {
                inAbstract = true;
                inRefs = false;
                b.subtype = "abstract-heading";
                continue;
            }
            if (/^(references|bibliography|daftar pustaka|daftar referensi)\b/i.test(t)) {
                inAbstract = false;
                inRefs = true;
                b.subtype = "references-heading";
                continue;
            }
            // Any other heading exits the abstract section
            inAbstract = false;
        }
        if (inAbstract && b.type === "paragraph") b.type = "abstract";
        if (inRefs && (b.type === "paragraph" || b.type === "caption")) b.type = "reference";
    }
}

function median(arr) {
    const s = arr.slice().filter((n) => n > 0).sort((a, b) => a - b);
    if (!s.length) return 0;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
