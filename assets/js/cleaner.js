/* ===================================================================
   cleaner.js
   Post-extraction text cleanup:
     - Cross-page header/footer dedup. Any block in the top 7% / bottom
       7% region whose text (with digits masked) repeats on >= 2 pages
       is dropped, plus all explicit "pagenum" blocks.
     - Dehyphenation: re-join words split across line breaks.
     - Collapse runs of whitespace.
     - Fix punctuation spacing left over from PDF text positioning.
   =================================================================== */

export function cleanBlocks(blocks) {
    // 1. Dedup repeated header/footer text across pages
    const groups = new Map();
    for (const b of blocks) {
        if (b.type === "header" || b.type === "footer" || b.type === "pagenum") {
            const key = (b.text || "").replace(/\d+/g, "#").toLowerCase().trim();
            if (!key) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(b);
        }
    }
    const drop = new Set();
    // Strip ALL pagenums always; strip headers/footers if they repeat
    for (const b of blocks) {
        if (b.type === "pagenum") drop.add(b);
    }
    for (const [, list] of groups) {
        if (list.length >= 2) list.forEach((b) => drop.add(b));
    }
    // Even unique headers/footers in margin regions are noise – drop them too
    for (const b of blocks) {
        if (b.type === "header" || b.type === "footer") drop.add(b);
    }

    const cleaned = blocks.filter((b) => !drop.has(b));

    // 2. Per-block text cleanup (skip tables and figures – they have structure)
    for (const b of cleaned) {
        if (b.kind === "figure") continue;
        if (b.type === "table") continue;
        if (!b.lines || !b.lines.length) {
            b.text = (b.text || "").trim();
            continue;
        }
        const merged = mergeLinesWithDehyphenation(b.lines);
        b.text = merged;
        // Keep one synthetic line for downstream renderers that look at b.lines
        b.lines = [merged];
    }

    return cleaned;
}

/* ----------- Dehyphenation + soft-wrap merging -----------
   Rules:
     - If previous line ends with a hyphen attached to a word and the next
       line starts with a lowercase letter → merge without hyphen.
     - Otherwise join with a single space.
     - Drop soft-hyphen (\u00AD) characters entirely.
*/
function mergeLinesWithDehyphenation(lines) {
    let out = "";
    for (let i = 0; i < lines.length; i++) {
        const cur = (lines[i] || "").trim();
        if (!cur) continue;
        if (out.match(/[A-Za-zÀ-ÖØ-öø-ÿ]-$/)) {
            // hyphen split: drop the trailing hyphen, glue tokens together
            // unless the next line starts with an uppercase letter (likely
            // a real hyphenated proper noun, e.g. "Anti-Inflammatory")
            if (/^[a-zà-öø-ÿ]/.test(cur)) {
                out = out.slice(0, -1) + cur;
            } else {
                out = out + cur;
            }
        } else if (out) {
            out += " " + cur;
        } else {
            out = cur;
        }
    }
    return out
        .replace(/\u00AD/g, "")
        .replace(/[\u200B-\u200F\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trim();
}
