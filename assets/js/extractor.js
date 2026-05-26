/* ===================================================================
   extractor.js
   Block-aware PDF extraction using PDF.js.

   Pipeline per page:
     1. Get text items with positions, sizes, font names.
     2. Detect 1 vs 2-column layout via X histogram valleys.
     3. Group items into LINES by Y proximity within a column.
     4. Group lines into BLOCKS by vertical gap analysis.
     5. Detect figure regions by caption ("Figure N", "Tabel N", ...) and
        render the page region above the caption to a cropped image.

   Output (per page): { pageNumber, width, height, blocks: Block[] }

   Block = {
     kind: "text" | "figure",
     column,
     x, y, w, h,                         // top-left, in PDF user units (pts)
     // text:
     lines?: string[],
     rawLines?: Line[],                  // raw lines with metrics, for table detection
     fontSize?: number,
     bold?: boolean,
     italic?: boolean,
     // figure:
     imageDataUrl?: string,
     attachedCaption?: Block,            // back-reference to the caption block
   }
   =================================================================== */

const pdfjsLib = window.pdfjsLib;

export async function extractDocument(file) {
    const arrayBuf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf, useSystemFonts: true }).promise;

    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const pageW = viewport.width;
        const pageH = viewport.height;

        const tc = await page.getTextContent({ disableCombineTextItems: false });
        const styles = tc.styles || {};

        const items = tc.items
            .filter((it) => it && it.str && it.str.trim().length > 0)
            .map((it) => itemize(it, styles, pageH));

        const cols = detectColumns(items, pageW);
        items.forEach((it) => {
            it.column = whichColumn(it, cols);
        });

        const lines = groupLines(items);
        const textBlocks = groupBlocks(lines);

        // Mark text blocks before figure detection so we can scan captions
        textBlocks.forEach((b) => {
            b.kind = "text";
            b.text = b.lines.join(" ").replace(/\s+/g, " ").trim();
        });

        const figureBlocks = await extractFigures(page, textBlocks, pageW, pageH);

        const allBlocks = [...textBlocks, ...figureBlocks].sort(readingOrder);
        pages.push({
            pageNumber,
            width: pageW,
            height: pageH,
            columns: cols.length,
            blocks: allBlocks,
        });
    }

    return { pages, meta: { numPages: pdf.numPages } };
}

/* ----------- Item normalization ----------- */
function itemize(it, styles, pageH) {
    const tx = it.transform;
    // tx = [a, b, c, d, e, f]
    //   e = x in PDF coords (bottom-left origin)
    //   f = y baseline in PDF coords
    //   font size ≈ sqrt(a^2 + b^2)
    const x = tx[4];
    const fontSize = Math.hypot(tx[0], tx[1]) || it.height || 10;
    // Convert to top-left coordinates (used internally for sane sorting)
    const yTop = pageH - tx[5] - (it.height || fontSize);

    const style = styles[it.fontName] || {};
    const fontFamily = style.fontFamily || it.fontName || "";
    const bold = /Bold|Heavy|Black|Semibold/i.test(fontFamily) || /Bold/i.test(it.fontName || "");
    const italic = /Italic|Oblique/i.test(fontFamily) || /Italic|Oblique/i.test(it.fontName || "");

    return {
        str: it.str,
        x,
        y: yTop,
        width: it.width || (fontSize * it.str.length * 0.45),
        height: it.height || fontSize,
        fontSize,
        fontName: it.fontName || "",
        bold,
        italic,
        hasEOL: !!it.hasEOL,
        column: 0,
    };
}

/* ----------- Column detection -----------
   Build an occupation histogram of item X-extents across page width.
   If the middle 40%–60% band has a sustained valley of near-zero
   occupation, treat the page as 2-column and split at the lowest bin.
*/
function detectColumns(items, pageW) {
    if (items.length < 30) return [{ x0: 0, x1: pageW }];
    const bins = 100;
    const hist = new Array(bins).fill(0);
    for (const it of items) {
        const left = Math.floor((it.x / pageW) * bins);
        const right = Math.ceil(((it.x + it.width) / pageW) * bins);
        for (let b = left; b < right; b++) {
            const bb = Math.max(0, Math.min(bins - 1, b));
            hist[bb] += 1;
        }
    }
    const lo = Math.floor(bins * 0.40);
    const hi = Math.ceil(bins * 0.60);
    const middleSlice = hist.slice(lo, hi);
    const middleMin = Math.min(...middleSlice);
    const overallMax = Math.max(...hist);
    if (overallMax > 0 && middleMin <= overallMax * 0.10) {
        // Pick the lowest bin in middle as column splitter
        let mi = lo;
        for (let i = lo; i < hi; i++) if (hist[i] < hist[mi]) mi = i;
        const splitX = ((mi + 0.5) / bins) * pageW;
        return [
            { x0: 0, x1: splitX },
            { x0: splitX, x1: pageW },
        ];
    }
    return [{ x0: 0, x1: pageW }];
}

function whichColumn(item, cols) {
    const mid = item.x + item.width / 2;
    for (let i = 0; i < cols.length; i++) {
        if (mid >= cols[i].x0 && mid <= cols[i].x1) return i;
    }
    return 0;
}

/* ----------- Line grouping -----------
   Sort by (column, y, x). Group items whose vertical centers are within
   half a line-height into a single line. Insert spaces between items
   when the X-gap exceeds a fraction of average char width.
*/
function groupLines(items) {
    const sorted = items.slice().sort((a, b) => {
        if (a.column !== b.column) return a.column - b.column;
        const yA = a.y + a.height / 2;
        const yB = b.y + b.height / 2;
        if (Math.abs(yA - yB) > Math.min(a.height, b.height) * 0.5) return yA - yB;
        return a.x - b.x;
    });

    const lines = [];
    let cur = null;
    for (const it of sorted) {
        const lineCenter = it.y + it.height / 2;
        if (
            !cur ||
            cur.column !== it.column ||
            Math.abs(cur.center - lineCenter) > Math.min(cur.h, it.height) * 0.55
        ) {
            if (cur) lines.push(finishLine(cur));
            cur = {
                column: it.column,
                x: it.x,
                y: it.y,
                w: it.width,
                h: it.height,
                center: lineCenter,
                items: [it],
                fontSizes: [it.fontSize],
                bolds: [it.bold],
                italics: [it.italic],
            };
        } else {
            cur.items.push(it);
            cur.fontSizes.push(it.fontSize);
            cur.bolds.push(it.bold);
            cur.italics.push(it.italic);
            const newX = Math.min(cur.x, it.x);
            const newRight = Math.max(cur.x + cur.w, it.x + it.width);
            cur.x = newX;
            cur.w = newRight - newX;
            cur.y = Math.min(cur.y, it.y);
            cur.h = Math.max(cur.h, it.height);
        }
    }
    if (cur) lines.push(finishLine(cur));
    return lines;
}

function finishLine(cur) {
    cur.items.sort((a, b) => a.x - b.x);
    let str = "";
    let prev = null;
    for (const it of cur.items) {
        if (prev) {
            const gap = it.x - (prev.x + prev.width);
            const avgChW = prev.width / Math.max(1, prev.str.length);
            // Mark wide gaps with multiple spaces so table detector can pick them up
            if (gap > avgChW * 2.0) str += "   ";
            else if (gap > avgChW * 0.4 && !/[ \-]$/.test(str) && !/^[ \-]/.test(it.str)) str += " ";
        }
        str += it.str;
        prev = it;
    }
    return {
        column: cur.column,
        x: cur.x,
        y: cur.y,
        w: cur.w,
        h: cur.h,
        text: str.replace(/\u00A0/g, " ").replace(/[ \t]+(?=\S)/g, " ").trim(),
        fontSize: median(cur.fontSizes),
        bold: cur.bolds.filter(Boolean).length / cur.bolds.length > 0.5,
        italic: cur.italics.filter(Boolean).length / cur.italics.length > 0.5,
    };
}

/* ----------- Block grouping -----------
   Group consecutive lines (same column) into a block when:
     - vertical gap is roughly one line-gap (paragraph continuation)
     - font size is similar
   Break a block when:
     - vertical gap is much larger than expected (paragraph break)
     - font size jumps significantly (heading transition)
*/
function groupBlocks(lines) {
    lines.sort((a, b) => a.column - b.column || a.y - b.y);
    const blocks = [];
    let cur = null;
    for (const ln of lines) {
        if (!cur || cur.column !== ln.column) {
            if (cur) blocks.push(finishBlock(cur));
            cur = newBlock(ln);
            continue;
        }
        const last = cur.lines[cur.lines.length - 1];
        const gap = ln.y - (last.y + last.h);
        const expected = Math.max(last.h, ln.h) * 0.4;
        const fontDelta = Math.abs(ln.fontSize - last.fontSize) / Math.max(1, last.fontSize);
        if (gap > expected * 2.2 || fontDelta > 0.25) {
            blocks.push(finishBlock(cur));
            cur = newBlock(ln);
        } else {
            cur.lines.push(ln);
            const newX = Math.min(cur.x, ln.x);
            const newRight = Math.max(cur.x + cur.w, ln.x + ln.w);
            cur.x = newX;
            cur.w = newRight - newX;
            cur.h = ln.y + ln.h - cur.y;
        }
    }
    if (cur) blocks.push(finishBlock(cur));
    return blocks;
}

function newBlock(ln) {
    return { column: ln.column, x: ln.x, y: ln.y, w: ln.w, h: ln.h, lines: [ln] };
}

function finishBlock(cur) {
    const fontSizes = cur.lines.map((l) => l.fontSize);
    const bolds = cur.lines.map((l) => l.bold);
    const italics = cur.lines.map((l) => l.italic);
    return {
        kind: "text",
        column: cur.column,
        x: cur.x,
        y: cur.y,
        w: cur.w,
        h: cur.h,
        rawLines: cur.lines,
        lines: cur.lines.map((l) => l.text),
        fontSize: median(fontSizes),
        bold: bolds.filter(Boolean).length > bolds.length / 2,
        italic: italics.filter(Boolean).length > italics.length / 2,
    };
}

/* ----------- Figure extraction -----------
   Heuristic: any block whose first line matches a caption pattern
   ("Figure N", "Fig. N", "Table N", "Tabel N", "Gambar N", ...) is a
   caption. Assume the figure occupies the rectangle directly above the
   caption in the same column, bounded above by the previous text block.
   Render the page once and crop that rectangle.
*/
const CAPTION_RE = /^(Figure|Fig\.?|Table|Tabel|Gambar|Bagan|Diagram)\s*\d+/i;

async function extractFigures(page, textBlocks, pageW, pageH) {
    const captions = textBlocks.filter(
        (b) => b.lines && b.lines[0] && CAPTION_RE.test(b.lines[0].trim())
    );
    if (captions.length === 0) return [];

    // Render full page once at 2x for crisp figure crops
    const scale = 2;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const figures = [];
    for (const cap of captions) {
        // Find the previous text block in the same column above the caption
        const sameCol = textBlocks.filter(
            (b) => b !== cap && b.column === cap.column && b.y + b.h <= cap.y
        );
        const above = sameCol.length
            ? sameCol.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a))
            : null;
        const top = above ? above.y + above.h + 2 : 0;
        const bottom = cap.y - 2;
        if (bottom - top < 30) continue;

        // X bounds: span the column extent (use min/max of all blocks in column)
        const colItems = textBlocks.filter((b) => b.column === cap.column);
        let x0 = Infinity;
        let x1 = -Infinity;
        for (const b of colItems) {
            x0 = Math.min(x0, b.x);
            x1 = Math.max(x1, b.x + b.w);
        }
        if (!isFinite(x0) || !isFinite(x1)) continue;

        const sx = x0 * scale;
        const sy = top * scale;
        const sw = (x1 - x0) * scale;
        const sh = (bottom - top) * scale;
        if (sw < 30 || sh < 30) continue;

        const crop = document.createElement("canvas");
        crop.width = Math.round(sw);
        crop.height = Math.round(sh);
        crop.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        let dataUrl;
        try {
            dataUrl = crop.toDataURL("image/jpeg", 0.85);
        } catch (e) {
            continue;
        }

        figures.push({
            kind: "figure",
            column: cap.column,
            x: x0,
            y: top,
            w: x1 - x0,
            h: bottom - top,
            imageDataUrl: dataUrl,
            attachedCaption: cap,
        });
    }

    // Free the big canvas
    canvas.width = canvas.height = 0;
    return figures;
}

/* ----------- Utilities ----------- */
function readingOrder(a, b) {
    if (a.column !== b.column) return a.column - b.column;
    return a.y - b.y;
}

function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    if (!s.length) return 0;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
