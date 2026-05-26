/* ===================================================================
   renderer.js
   Build a clean, semantic HTML document from classified blocks and
   export it to a true VECTOR PDF using the browser's print pipeline.

   Why not html2canvas + jsPDF?
     - html2canvas rasterizes everything, producing a PDF that is just
       sliced JPEGs. Text is not selectable, file size explodes, CJK/
       Arabic/Indic fonts blur, and slicing splits glyphs across pages.
     - The browser's Print → "Save as PDF" path produces a real
       paginated vector PDF with selectable text and proper @page rules.

   Production-grade alternative: send `htmlString` to a Puppeteer/Playwright
   server (see /server/render.mjs) which calls page.pdf({format: "A4", ...})
   to generate the PDF without showing a print dialog.
   =================================================================== */

const PRINT_CSS_HREF = "assets/css/print.css";

export function buildHtmlDocument(blocks, opts = {}) {
    const title = opts.title || "Document";
    const lang = opts.lang || "en";

    const out = [];
    out.push(`<!DOCTYPE html><html lang="${escapeAttr(lang)}"><head>`);
    out.push(`<meta charset="UTF-8" />`);
    out.push(`<meta name="viewport" content="width=device-width, initial-scale=1" />`);
    out.push(`<title>${escapeHtml(title)}</title>`);
    // Inline the print CSS so the exported HTML is fully self-contained
    out.push(`<style>${PRINT_CSS_INLINE}</style>`);
    out.push(`</head><body><article class="doc">`);

    let i = 0;
    while (i < blocks.length) {
        const b = blocks[i];

        // Group consecutive references into one <ol class="references">
        if (b.type === "reference") {
            out.push(`<ol class="references">`);
            while (i < blocks.length && blocks[i].type === "reference") {
                const t = (blocks[i].text || "").trim();
                if (t) out.push(`<li>${escapeHtml(t)}</li>`);
                i++;
            }
            out.push(`</ol>`);
            continue;
        }

        // Pair a figure with its caption: skip the standalone caption block,
        // since we render it inside <figcaption>.
        if (b.type === "figure") {
            out.push(renderFigure(b));
            // If the next block is the very caption attached to this figure, skip it.
            const cap = b.attachedCaption;
            if (cap && blocks[i + 1] === cap) i++;
            i++;
            continue;
        }

        out.push(renderBlock(b));
        i++;
    }

    out.push(`</article></body></html>`);
    return out.join("\n");
}

function renderBlock(b) {
    const text = (b.text || "").trim();
    switch (b.type) {
        case "title":
            return `<h1 class="doc-title">${escapeHtml(text)}</h1>`;
        case "authors":
            return `<p class="doc-authors">${escapeHtml(text)}</p>`;
        case "abstract":
            return `<p class="abstract">${escapeHtml(text)}</p>`;
        case "heading": {
            const lvl = Math.min(3, Math.max(1, b.level || 2));
            return `<h${lvl}>${escapeHtml(text)}</h${lvl}>`;
        }
        case "paragraph":
            return text ? `<p>${escapeHtml(text)}</p>` : "";
        case "caption":
            return text ? `<p class="caption">${escapeHtml(text)}</p>` : "";
        case "table":
            return renderTable(b);
        default:
            return text ? `<p>${escapeHtml(text)}</p>` : "";
    }
}

function renderTable(b) {
    if (!b.rows || !b.rows.length) return "";
    const colCount = Math.max(...b.rows.map((r) => r.length));
    const rows = b.rows
        .map((r, i) => {
            const padded = r.slice();
            while (padded.length < colCount) padded.push("");
            const tag = i === 0 ? "th" : "td";
            return `<tr>${padded.map((c) => `<${tag}>${escapeHtml(c || "")}</${tag}>`).join("")}</tr>`;
        })
        .join("");
    return `<table>${rows}</table>`;
}

function renderFigure(b) {
    const cap = b.attachedCaption ? (b.attachedCaption.text || "").trim() : "";
    const capHtml = cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : "";
    return `<figure><img src="${b.imageDataUrl}" alt="" />${capHtml}</figure>`;
}

/* ----------- Export ----------- */

// Save-as-PDF via hidden iframe + window.print(). Returns when the print
// dialog has been opened (the user picks the destination "Save as PDF").
export async function exportToPdf(htmlString, filename = "document.pdf") {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.cssText =
            "position:fixed;left:-99999px;top:0;width:210mm;height:297mm;border:0;";
        document.body.appendChild(iframe);

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            try { iframe.remove(); } catch {}
        };

        iframe.onload = () => {
            try {
                iframe.contentDocument.title = filename.replace(/\.pdf$/i, "");
                // Wait for images / fonts to settle before printing
                setTimeout(() => {
                    try {
                        iframe.contentWindow.focus();
                        iframe.contentWindow.print();
                    } catch (e) {
                        cleanup();
                        return reject(e);
                    }
                    // Print dialog is modal in most browsers; resolve and clean up
                    setTimeout(() => {
                        cleanup();
                        resolve();
                    }, 1500);
                }, 400);
            } catch (e) {
                cleanup();
                reject(e);
            }
        };
        iframe.onerror = (e) => {
            cleanup();
            reject(e);
        };

        const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
        iframe.src = URL.createObjectURL(blob);
    });
}

// Open the rendered HTML in a new tab so the user can verify the layout
// before printing/exporting.
export function openHtmlPreview(htmlString) {
    const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
}

/* ----------- Helpers ----------- */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
}
function escapeAttr(s) {
    return escapeHtml(s);
}

/* ----------- Inlined print stylesheet -----------
   Kept in sync with assets/css/print.css. We inline it so the exported
   HTML works offline and across origins (browsers refuse external CSS in
   blob: URLs from some engines).
*/
const PRINT_CSS_INLINE = `
@page { size: A4; margin: 22mm 18mm; }
* { box-sizing: border-box; }
body {
  font-family: "Helvetica Neue", Arial, "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans Thai", sans-serif;
  font-size: 11pt;
  line-height: 1.55;
  color: #111;
  margin: 0;
  background: #fff;
}
.doc { max-width: none; }
.doc-title {
  font-size: 20pt; font-weight: 700; margin: 0 0 6pt;
  text-align: center; page-break-after: avoid;
}
.doc-authors {
  font-size: 11pt; text-align: center; font-style: italic;
  margin: 0 0 18pt; color: #444; page-break-after: avoid;
}
.abstract {
  font-size: 10pt; border-left: 3pt solid #999;
  padding: 4pt 10pt; margin: 0 0 14pt;
  background: #f9f9f9; text-align: justify;
}
h1, h2, h3 {
  page-break-after: avoid;
  margin-top: 18px; margin-bottom: 8px;
  font-weight: 700;
}
h1 { font-size: 16pt; }
h2 { font-size: 13pt; }
h3 { font-size: 11.5pt; }
p {
  margin: 0 0 10px;
  text-align: justify;
  orphans: 3; widows: 3;
}
.caption {
  font-size: 9pt; color: #555;
  text-align: center;
  margin: 4pt 0 12pt;
  page-break-before: avoid;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  page-break-inside: avoid;
  font-size: 9.5pt;
}
th, td {
  border: 1px solid #ccc;
  padding: 6px;
  vertical-align: top;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
th {
  background: #f1f3f5; font-weight: 600; text-align: left;
}
figure {
  margin: 16px 0;
  page-break-inside: avoid;
  text-align: center;
}
img { max-width: 100%; height: auto; }
figcaption {
  font-size: 9pt; color: #555; margin-top: 6px;
}
.references {
  font-size: 9pt; line-height: 1.35;
  padding-left: 1.2em;
}
.references li {
  margin-bottom: 5pt;
  text-align: left;
  page-break-inside: avoid;
}
.page-break { page-break-before: always; }
@media print {
  html, body { background: #fff !important; }
}
`;
