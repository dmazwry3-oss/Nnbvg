/* ===================================================================
   PDF Translate – layout-preserving translator with column-flow reflow

   Pipeline per page:
   1. Render original page to canvas (preserves images, vectors).
   2. Extract text items in canvas-space coords with font metrics.
   3. Group into LINES → PARAGRAPHS (semantic blocks).
   4. Translate paragraphs (batched via Google gtx, fallback MyMemory).
   5. Detect COLUMN STRUCTURE (full-width / left / right), then split
      each column into vertical "bands" by large y-gaps so headers,
      body, and footers reflow independently.
   6. White-out original paragraph bboxes (preserves images that sit
      between paragraphs).
   7. For each band: REFLOW translated paragraphs as a flowing
      column — uniform font scale chosen to fit available height,
      paragraphs stack top-to-bottom with proper line + paragraph
      spacing. This is what fixes overlap when translated text is
      longer than original.
   8. Compose pages back into a PDF with original physical dimensions.
   =================================================================== */

(function () {
    "use strict";

    /* ------------------------------------------------------------------
       CDN loaders
    ------------------------------------------------------------------ */
    function loadScript(urls) {
        return new Promise(function (resolve, reject) {
            var i = 0;
            (function tryNext() {
                if (i >= urls.length) return reject(new Error("All CDNs failed"));
                var s = document.createElement("script");
                s.src = urls[i++];
                s.onload = function () { resolve(s.src); };
                s.onerror = tryNext;
                document.head.appendChild(s);
            })();
        });
    }
    async function ensurePdfJs() {
        if (window.pdfjsLib) return;
        await loadScript([
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
            "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js",
        ]);
        if (!window.pdfjsLib) throw new Error("pdfjsLib gagal dimuat");
    }
    function setPdfJsWorker() {
        if (!window.pdfjsLib) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    setPdfJsWorker();
    async function ensureJsPdf() {
        if ((window.jspdf && window.jspdf.jsPDF) || window.jsPDF) return;
        await loadScript([
            "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
            "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js",
        ]);
    }

    /* ------------------------------------------------------------------
       DOM
    ------------------------------------------------------------------ */
    var $ = function (id) { return document.getElementById(id); };
    var els = {
        uploader: $("uploader"), pickfiles: $("pickfiles"), fileInput: $("fileInput"),
        fileGroups: $("fileGroups"), actionBar: $("actionBar"), btnTranslate: $("btnTranslate"),
        btnClear: $("btnClear"), progress: $("progress"), progressText: $("progressText"),
        progressFill: $("progressFill"), progressSub: $("progressSub"), result: $("result"),
        btnDownload: $("btnDownload"), btnPreview: $("btnPreview"), btnRestart: $("btnRestart"),
        preview: $("preview"), previewSrc: $("previewSrc"), previewDst: $("previewDst"),
        srcLang: $("srcLang"), tgtLang: $("tgtLang"), swapLang: $("swapLang"),
        errorBox: $("errorBox"), year: $("year"),
    };
    if (els.year) els.year.textContent = new Date().getFullYear();

    var state = { files: [], lastResult: null };

    /* ------------------------------------------------------------------
       UI helpers
    ------------------------------------------------------------------ */
    function showError(msg) {
        els.errorBox.textContent = msg;
        els.errorBox.classList.remove("hidden");
        setTimeout(function () { els.errorBox.classList.add("hidden"); }, 9000);
    }
    function setProgress(pct, sub) {
        els.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        if (sub != null) els.progressSub.textContent = sub;
    }
    function fmtSize(b) {
        if (b < 1024) return b + " B";
        if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
        return (b / 1048576).toFixed(2) + " MB";
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    /* ------------------------------------------------------------------
       File handling
    ------------------------------------------------------------------ */
    function addFiles(list) {
        var added = 0;
        Array.prototype.forEach.call(list, function (f) {
            if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) return;
            if (state.files.some(function (x) { return x.name === f.name && x.size === f.size; })) return;
            state.files.push(f); added++;
        });
        if (added === 0 && list.length > 0) showError("Hanya file PDF yang didukung.");
        renderFileList();
    }
    function removeFile(i) { state.files.splice(i, 1); renderFileList(); }
    function renderFileList() {
        els.fileGroups.innerHTML = "";
        state.files.forEach(function (f, i) {
            var card = document.createElement("div");
            card.className = "filecard";
            card.innerHTML =
                '<div class="filecard__ico">PDF</div>' +
                '<div class="filecard__meta">' +
                    '<div class="filecard__name">' + escapeHtml(f.name) + "</div>" +
                    '<div class="filecard__size">' + fmtSize(f.size) + "</div>" +
                "</div>" +
                '<button class="filecard__remove" type="button" aria-label="Hapus">&times;</button>';
            card.querySelector(".filecard__remove").addEventListener("click", function () { removeFile(i); });
            els.fileGroups.appendChild(card);
        });
        els.actionBar.classList.toggle("hidden", state.files.length === 0);
    }
    els.pickfiles.addEventListener("click", function () { els.fileInput.click(); });
    els.uploader.addEventListener("click", function (e) {
        if (e.target === els.uploader || e.target.classList.contains("uploader__droptxt")) els.fileInput.click();
    });
    els.fileInput.addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });
    ["dragenter", "dragover"].forEach(function (ev) {
        els.uploader.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); els.uploader.classList.add("is-dragging"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
        els.uploader.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); els.uploader.classList.remove("is-dragging"); });
    });
    els.uploader.addEventListener("drop", function (e) {
        if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    ["dragover", "drop"].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); }, false); });
    els.btnClear.addEventListener("click", function () { state.files = []; renderFileList(); });
    els.swapLang.addEventListener("click", function () {
        var s = els.srcLang.value, t = els.tgtLang.value;
        if (s === "auto") return;
        els.srcLang.value = t; els.tgtLang.value = s;
    });

    /* ------------------------------------------------------------------
       Paragraph extraction
    ------------------------------------------------------------------ */
    function joinLineItems(items) {
        items.sort(function (a, b) { return a.x - b.x; });
        var out = "";
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (i === 0) { out += it.str; continue; }
            var prev = items[i - 1];
            var prevEnd = prev.x + prev.width;
            var gap = it.x - prevEnd;
            var charW = Math.max(prev.fontSize * 0.25, 1);
            if (/\s$/.test(out) || /^\s/.test(it.str)) out += it.str;
            else if (gap > charW * 1.3) out += " " + it.str;
            else out += it.str;
        }
        return out.replace(/[ \t]+/g, " ").trim();
    }

    function extractParagraphs(items) {
        if (items.length === 0) return [];
        items.sort(function (a, b) { return a.y - b.y || a.x - b.x; });

        var lines = [];
        var curr = null;
        items.forEach(function (it) {
            if (!curr || Math.abs(it.y - curr.y) > Math.max(curr.h * 0.4, 2)) {
                curr = { y: it.y, h: it.height, items: [it] };
                lines.push(curr);
            } else {
                curr.items.push(it);
                curr.h = Math.max(curr.h, it.height);
                curr.y = Math.min(curr.y, it.y);
            }
        });
        lines.forEach(function (ln) {
            ln.items.sort(function (a, b) { return a.x - b.x; });
            ln.text = joinLineItems(ln.items);
            ln.x = Math.min.apply(null, ln.items.map(function (it) { return it.x; }));
            ln.x2 = Math.max.apply(null, ln.items.map(function (it) { return it.x + it.width; }));
            ln.fontSize = ln.items.reduce(function (s, it) { return s + it.fontSize; }, 0) / ln.items.length;
            ln.bottom = ln.y + ln.h;
        });

        var paragraphs = [];
        var p = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (!p) { p = { lines: [ln] }; paragraphs.push(p); continue; }
            var prev = p.lines[p.lines.length - 1];
            var sameSize = Math.abs(ln.fontSize - prev.fontSize) / Math.max(prev.fontSize, 1) < 0.30;
            var overlap = Math.min(prev.x2, ln.x2) - Math.max(prev.x, ln.x);
            var minW = Math.max(Math.min(prev.x2 - prev.x, ln.x2 - ln.x), 1);
            var sameCol = overlap >= minW * 0.25 || Math.abs(ln.x - prev.x) < prev.fontSize * 2;
            var gap = ln.y - prev.bottom;
            var closeY = gap < prev.fontSize * 1.6 && gap >= -3;
            if (sameSize && sameCol && closeY) p.lines.push(ln);
            else { p = { lines: [ln] }; paragraphs.push(p); }
        }

        return paragraphs.map(function (p) {
            var x = Math.min.apply(null, p.lines.map(function (l) { return l.x; }));
            var x2 = Math.max.apply(null, p.lines.map(function (l) { return l.x2; }));
            var y = Math.min.apply(null, p.lines.map(function (l) { return l.y; }));
            var y2 = Math.max.apply(null, p.lines.map(function (l) { return l.bottom; }));
            var text = p.lines.map(function (l) { return l.text; }).join(" ").replace(/\s+/g, " ").trim();
            text = text.replace(/(\w+)-\s+(\w+)/g, "$1$2");
            var fontSize = p.lines.reduce(function (s, l) { return s + l.fontSize; }, 0) / p.lines.length;
            return { bbox: { x: x, y: y, w: x2 - x, h: y2 - y }, text: text, fontSize: fontSize };
        }).filter(function (p) { return p.text.length > 0; });
    }

    /* ------------------------------------------------------------------
       Render PDF page → canvas + paragraphs
    ------------------------------------------------------------------ */
    var RENDER_SCALE = 1.5;
    var CMAP_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/";

    function loadPdfDocument(arrayBuffer) {
        return pdfjsLib.getDocument({
            data: arrayBuffer,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            useSystemFonts: true,
        }).promise;
    }

    async function renderPageWithMeta(pdfDoc, pageNum) {
        var page = await pdfDoc.getPage(pageNum);
        var viewport = page.getViewport({ scale: RENDER_SCALE });
        var canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        var ctx = canvas.getContext("2d");

        await page.render({ canvasContext: ctx, viewport: viewport, background: "#ffffff" }).promise;

        var content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        var items = content.items
            .filter(function (it) { return it && typeof it.str === "string" && it.str.length; })
            .map(function (it) {
                var tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
                var fontHeight = Math.abs(Math.hypot(tx[2], tx[3])) || 10;
                var hScale = Math.abs(Math.hypot(tx[0], tx[1])) || fontHeight;
                var widthCanvas = (typeof it.width === "number" ? it.width : 0) * hScale / Math.max(it.height || 1, 0.0001);
                if (!isFinite(widthCanvas) || widthCanvas <= 0) widthCanvas = (it.str.length || 1) * fontHeight * 0.5;
                var ascent = fontHeight * 0.82;
                return {
                    str: it.str, x: tx[4], y: tx[5] - ascent,
                    width: widthCanvas, height: fontHeight * 1.15, fontSize: fontHeight,
                };
            })
            .filter(function (it) {
                return it.fontSize >= 4 && it.fontSize < 200 &&
                       isFinite(it.x) && isFinite(it.y) &&
                       it.x >= -50 && it.y >= -50 &&
                       it.x < canvas.width + 50 && it.y < canvas.height + 50;
            });

        return {
            canvas: canvas,
            paragraphs: extractParagraphs(items),
            ptW: viewport.width / RENDER_SCALE,
            ptH: viewport.height / RENDER_SCALE,
            canvasW: canvas.width,
            canvasH: canvas.height,
        };
    }

    /* ------------------------------------------------------------------
       Translation
    ------------------------------------------------------------------ */
    async function translateGoogle(text, sl, tl) {
        var url = "https://translate.googleapis.com/translate_a/single" +
            "?client=gtx&sl=" + encodeURIComponent(sl) + "&tl=" + encodeURIComponent(tl) +
            "&dt=t&q=" + encodeURIComponent(text);
        var r = await fetch(url);
        if (!r.ok) throw new Error("Google HTTP " + r.status);
        var d = await r.json();
        if (!Array.isArray(d) || !Array.isArray(d[0])) throw new Error("Bad Google response");
        return d[0].map(function (s) { return s[0]; }).join("");
    }
    async function translateMyMemory(text, sl, tl) {
        var srcParam = sl === "auto" ? "Autodetect" : sl;
        var url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) +
            "&langpair=" + encodeURIComponent(srcParam) + "|" + encodeURIComponent(tl);
        var r = await fetch(url);
        if (!r.ok) throw new Error("MyMemory HTTP " + r.status);
        var d = await r.json();
        if (!d.responseData || !d.responseData.translatedText) throw new Error("Bad MyMemory");
        return d.responseData.translatedText;
    }

    async function translateParagraphsBatched(paragraphs, sl, tl, onProgress) {
        if (paragraphs.length === 0) return;
        var SEP = "\n\n";
        var GOOGLE_LIMIT = 4500;
        var MYMEM_LIMIT = 480;

        function makeBatches(limit) {
            var batches = [], curr = [], len = 0;
            paragraphs.forEach(function (p) {
                var pLen = p.text.length + SEP.length;
                if (len + pLen > limit && curr.length > 0) { batches.push(curr); curr = []; len = 0; }
                curr.push(p); len += pLen;
            });
            if (curr.length) batches.push(curr);
            return batches;
        }

        try {
            var batches = makeBatches(GOOGLE_LIMIT);
            var done = 0;
            for (var i = 0; i < batches.length; i++) {
                var batch = batches[i];
                var combined = batch.map(function (p) { return p.text.replace(/\n+/g, " "); }).join(SEP);
                var translated = await translateGoogle(combined, sl, tl);
                var parts = translated.split(/\n\n+/);
                if (parts.length !== batch.length) parts = translated.split(/\n+/);
                for (var j = 0; j < batch.length; j++) batch[j].translatedText = (parts[j] || batch[j].text).trim();
                done += batch.length;
                if (onProgress) onProgress(done, paragraphs.length);
            }
            return;
        } catch (gErr) {
            console.warn("Google batch failed, falling back to MyMemory:", gErr);
        }

        for (var k = 0; k < paragraphs.length; k++) {
            var p = paragraphs[k];
            try {
                if (p.text.length <= MYMEM_LIMIT) {
                    p.translatedText = await translateMyMemory(p.text, sl, tl);
                } else {
                    var sentences = p.text.match(/[^.!?]+[.!?]+|\S[\s\S]{0,400}/g) || [p.text];
                    var out = [];
                    for (var s = 0; s < sentences.length; s++) {
                        var ss = sentences[s].trim();
                        if (!ss) continue;
                        if (ss.length > MYMEM_LIMIT) ss = ss.slice(0, MYMEM_LIMIT);
                        out.push(await translateMyMemory(ss, sl, tl));
                    }
                    p.translatedText = out.join(" ");
                }
            } catch (e) { p.translatedText = p.text; }
            if (onProgress) onProgress(k + 1, paragraphs.length);
        }
    }

    /* ------------------------------------------------------------------
       Column-flow reflow engine
       This is the core of layout-preserving translation.
    ------------------------------------------------------------------ */
    var FONT_FAMILY = "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans Arabic', serif";

    // Per-role spacing configuration. Each role has its own line-height,
    // paragraph-gap, and minimum shrink scale tuned for that semantic context.
    //   lh        : line-height multiplier (× fontSize)
    //   gapFactor : fallback paragraph gap when original gap is unavailable
    //   scaleMin  : minimum uniform shrink before clipping kicks in
    var SPACING_BY_ROLE = {
        title:           { lh: 1.20, gapFactor: 0.80, scaleMin: 0.70 },
        author:          { lh: 1.22, gapFactor: 0.50, scaleMin: 0.65 },
        affiliation:     { lh: 1.18, gapFactor: 0.30, scaleMin: 0.60 },
        sidebar:         { lh: 1.30, gapFactor: 0.55, scaleMin: 0.65 },
        abstract:        { lh: 1.45, gapFactor: 0.65, scaleMin: 0.65 },
        keywords:        { lh: 1.30, gapFactor: 0.40, scaleMin: 0.70 },
        "keywords-label":{ lh: 1.20, gapFactor: 0.35, scaleMin: 0.80 },
        header:          { lh: 1.15, gapFactor: 0.25, scaleMin: 0.60 },
        footer:          { lh: 1.15, gapFactor: 0.25, scaleMin: 0.60 },
        body:            { lh: 1.18, gapFactor: 0.42, scaleMin: 0.55 },
    };

    function wrapText(ctx, text, maxWidth) {
        var lines = [];
        var paragraphs = String(text).split(/\n+/);
        paragraphs.forEach(function (para) {
            var words = para.split(/\s+/);
            var line = "";
            for (var i = 0; i < words.length; i++) {
                var w = words[i];
                if (!w) continue;
                var test = line ? line + " " + w : w;
                if (ctx.measureText(test).width <= maxWidth) {
                    line = test;
                } else {
                    if (line) lines.push(line);
                    if (ctx.measureText(w).width > maxWidth) {
                        var buf = "";
                        for (var c = 0; c < w.length; c++) {
                            if (ctx.measureText(buf + w[c]).width > maxWidth) {
                                if (buf) lines.push(buf);
                                buf = w[c];
                            } else buf += w[c];
                        }
                        line = buf;
                    } else line = w;
                }
            }
            if (line) lines.push(line);
        });
        return lines;
    }

    // ------- Semantic role classification (cover-page aware) -------
    //
    // Detects journal-cover-style structural roles using font size, position,
    // width, and content patterns. Roles drive both the white-out grouping
    // and the per-zone spacing config.
    function classifySemanticRole(paragraphs, canvasW, canvasH) {
        if (paragraphs.length === 0) return;

        var significantFs = paragraphs
            .filter(function (p) { return p.text.length > 20; })
            .map(function (p) { return p.fontSize; })
            .sort(function (a, b) { return a - b; });
        var medianFs = significantFs.length ? significantFs[Math.floor(significantFs.length / 2)] : 12;

        // Sidebar marker keywords (Frontiers + general academic cover pages, EN/ID/ES/etc)
        var SIDEBAR_KEYS = /\b(OPEN\s*ACCESS|EDITED\s*BY|REVIEWED\s*BY|RECEIVED|ACCEPTED|PUBLISHED|CITATION|COPYRIGHT|CORRESPONDENCE|TYPE|DOI|BUKA\s*AKSES|DIEDIT\s*OLEH|DITINJAU\s*OLEH|DITERIMA|HAK\s*CIPTA|TIPE|KORESPONDENSI)\b/i;

        paragraphs.forEach(function (p) {
            var x = p.bbox.x;
            var x2 = p.bbox.x + p.bbox.w;
            var w = p.bbox.w;
            var yc = p.bbox.y + p.bbox.h / 2;
            var fs = p.fontSize;
            var text = p.text.trim();

            // FOOTER: bottom 5%
            if (yc > canvasH * 0.94) { p.role = "footer"; return; }
            // HEADER: top 5%
            if (yc < canvasH * 0.06) { p.role = "header"; return; }

            // SIDEBAR (editorial metadata): narrow paragraph in left ~30% of page,
            // OR in right ~30% near top with editorial markers (DOI block on right side)
            var isLeftSidebar = x2 < canvasW * 0.30 && w < canvasW * 0.30;
            var isRightDoiBlock = x > canvasW * 0.65 && yc < canvasH * 0.18 && w < canvasW * 0.35;
            if ((isLeftSidebar || isRightDoiBlock) && fs < medianFs * 1.4) {
                p.role = "sidebar";
                return;
            }
            // Sidebar by content keyword (catches multi-line CITATION/COPYRIGHT blocks
            // that may wrap wider than the narrow column)
            if (x2 < canvasW * 0.40 && fs < medianFs * 1.1 && SIDEBAR_KEYS.test(text)) {
                p.role = "sidebar";
                return;
            }

            // TITLE: large font in top half, reasonably wide
            if (fs > medianFs * 1.35 && yc < canvasH * 0.50 && w > canvasW * 0.20) {
                p.role = "title";
                return;
            }

            // AUTHOR LIST: medium font in top 40%, comma-separated names
            // Heuristic: contains commas + capitalized name-like words + not too long
            var commaCount = (text.match(/,/g) || []).length;
            var capWords = (text.match(/[A-ZÁ-Úİ][a-zá-úı]{2,}/g) || []).length;
            var hasNamePattern = commaCount >= 1 && capWords >= 3;
            if (yc < canvasH * 0.40 && fs >= medianFs * 0.85 && fs <= medianFs * 1.25
                && hasNamePattern && text.length < 500) {
                p.role = "author";
                return;
            }

            // AFFILIATION: smaller font in top half, numbered or institutional words
            var affilLooks = /^\s*\d+\s*[A-ZÁ-Ú]/.test(text)
                || /\b(University|Universitas|Institut|Department|Departemen|Research|Hospital|School|Faculty|Fakultas|College|Colegio|Universidad|Université|Università)\b/i.test(text);
            if (yc < canvasH * 0.55 && fs < medianFs * 0.95 && affilLooks) {
                p.role = "affiliation";
                return;
            }

            // KEYWORDS label
            if (text.length < 40 && /^(KEYWORDS|KATA\s*KUNCI|PALABRAS\s*CLAVE|MOTS-CLÉS)\s*:?\s*$/i.test(text)) {
                p.role = "keywords-label";
                return;
            }

            // Default: body (will be column-classified later)
            p.role = "body";
        });

        // Post-pass 1: paragraph immediately after KEYWORDS label → keyword list
        var sorted = paragraphs.slice().sort(function (a, b) { return a.bbox.y - b.bbox.y; });
        for (var i = 0; i < sorted.length - 1; i++) {
            if (sorted[i].role === "keywords-label") {
                for (var j = i + 1; j < sorted.length; j++) {
                    if (sorted[j].role === "body" &&
                        Math.abs(sorted[j].bbox.x - sorted[i].bbox.x) < 80) {
                        sorted[j].role = "keywords";
                        break;
                    }
                }
            }
        }

        // Post-pass 2: detect ABSTRACT — first big body paragraph in top 60% of page
        // (only relevant on cover pages; other pages will simply have no early big body block)
        var topBodyCandidates = sorted.filter(function (p) {
            return p.role === "body"
                && (p.bbox.y + p.bbox.h / 2) < canvasH * 0.60
                && p.text.length > 250;
        });
        if (topBodyCandidates.length > 0) {
            topBodyCandidates[0].role = "abstract";
        }
    }

    // Step 1: classify each paragraph into a column (full / left / right)
    function classifyColumns(paragraphs, canvasW) {
        var midX = canvasW / 2;
        // Filter "significant" paragraphs (real body text) for layout decisions
        var significant = paragraphs.filter(function (p) {
            return p.text.length > 25 && p.fontSize >= 7;
        });
        if (significant.length === 0) significant = paragraphs;

        // First-pass classification per paragraph
        paragraphs.forEach(function (p) {
            var x2 = p.bbox.x + p.bbox.w;
            var cx = p.bbox.x + p.bbox.w / 2;
            // Spans most of page width? → full
            if (p.bbox.w > canvasW * 0.6 || (p.bbox.x < midX - 30 && x2 > midX + 30)) {
                p.column = "full";
            } else if (cx < midX) {
                p.column = "left";
            } else {
                p.column = "right";
            }
        });

        // Decide: is page actually 2-column, or single column?
        var leftN = paragraphs.filter(function (p) { return p.column === "left" && p.text.length > 30; }).length;
        var rightN = paragraphs.filter(function (p) { return p.column === "right" && p.text.length > 30; }).length;
        var isTwoCol = leftN >= 2 && rightN >= 2;

        if (!isTwoCol) {
            paragraphs.forEach(function (p) { p.column = "full"; });
        }
    }

    // Step 2: split each column into VERTICAL BANDS
    // (paragraphs separated by big y-gaps form independent reflow regions —
    //  this keeps headers, body, and footers layout-independent)
    function splitColumnIntoBands(paragraphs) {
        if (paragraphs.length === 0) return [];
        paragraphs.sort(function (a, b) { return a.bbox.y - b.bbox.y; });

        // Compute median font size for gap threshold
        var fontSizes = paragraphs.map(function (p) { return p.fontSize; }).sort(function (a, b) { return a - b; });
        var medianFs = fontSizes[Math.floor(fontSizes.length / 2)] || 12;

        var bands = [];
        var curr = [paragraphs[0]];
        for (var i = 1; i < paragraphs.length; i++) {
            var prev = curr[curr.length - 1];
            var gap = paragraphs[i].bbox.y - (prev.bbox.y + prev.bbox.h);
            // Band split if gap > 4× median font size (i.e., a clear blank section divider)
            var threshold = Math.max(medianFs * 4, 30);
            if (gap > threshold) {
                bands.push(curr);
                curr = [paragraphs[i]];
            } else {
                curr.push(paragraphs[i]);
            }
        }
        bands.push(curr);
        return bands;
    }

    // Step 3: build "regions" — each region is an INDEPENDENT flow container
    //         with its own role + spacing config.
    //
    // - Body paragraphs → split by column (full/left/right) then by vertical
    //   bands (so headers/body/footers within a column are independent).
    // - Other roles (title, author, affiliation, sidebar, abstract, keywords,
    //   header, footer) become their own regions, clustered as one zone per
    //   role (with band-splitting for sidebar/header/footer where multiple
    //   distinct items typically exist).
    function buildRegions(paragraphs, canvasW, canvasH) {
        // 1. Semantic role classification (cover-page aware)
        classifySemanticRole(paragraphs, canvasW, canvasH);

        // 2. Group by role
        var byRole = {};
        paragraphs.forEach(function (p) {
            var r = p.role || "body";
            (byRole[r] = byRole[r] || []).push(p);
        });

        // 3. For 'body' paragraphs: column-classify and band-split
        if (byRole.body && byRole.body.length > 0) {
            classifyColumns(byRole.body, canvasW);
        }

        function makeRegion(role, ps) {
            if (!ps || ps.length === 0) return null;
            ps.sort(function (a, b) { return a.bbox.y - b.bbox.y; });
            var x  = Math.min.apply(null, ps.map(function (p) { return p.bbox.x; }));
            var x2 = Math.max.apply(null, ps.map(function (p) { return p.bbox.x + p.bbox.w; }));
            var y  = Math.min.apply(null, ps.map(function (p) { return p.bbox.y; }));
            var y2 = Math.max.apply(null, ps.map(function (p) { return p.bbox.y + p.bbox.h; }));
            return {
                role: role, paragraphs: ps,
                x: x, y: y, x2: x2, y2: y2, w: x2 - x, h: y2 - y,
                spacing: SPACING_BY_ROLE[role] || SPACING_BY_ROLE.body,
            };
        }

        var regions = [];

        // Body: per-column band split
        if (byRole.body && byRole.body.length > 0) {
            var byCol = { full: [], left: [], right: [] };
            byRole.body.forEach(function (p) { byCol[p.column].push(p); });
            ["full", "left", "right"].forEach(function (col) {
                var bands = splitColumnIntoBands(byCol[col]);
                bands.forEach(function (band) {
                    var r = makeRegion("body", band);
                    if (r) regions.push(r);
                });
            });
        }

        // Sidebar/header/footer: also band-split since they often have multiple
        // distinct items separated by vertical gaps (OPEN ACCESS / EDITED BY / ...)
        ["sidebar", "header", "footer"].forEach(function (role) {
            if (!byRole[role]) return;
            var bands = splitColumnIntoBands(byRole[role]);
            bands.forEach(function (band) {
                var r = makeRegion(role, band);
                if (r) regions.push(r);
            });
        });

        // Single-zone roles: title / author / affiliation / abstract / keywords
        ["title", "author", "affiliation", "abstract", "keywords-label", "keywords"].forEach(function (role) {
            if (!byRole[role]) return;
            var r = makeRegion(role, byRole[role]);
            if (r) regions.push(r);
        });

        return regions;
    }

    // Step 4: reflow + draw a single region using its role-specific spacing
    function reflowAndDraw(ctx, region, canvasH) {
        var colW = region.w;
        var availH = region.h;
        var sp = region.spacing || SPACING_BY_ROLE.body;

        // Layout text at a uniform scale; uses ORIGINAL inter-paragraph gaps
        // (scaled) when available so spacing pattern of the source is preserved.
        function layout(scale) {
            var items = [];
            var totalH = 0;
            for (var i = 0; i < region.paragraphs.length; i++) {
                var p = region.paragraphs[i];
                var fs = Math.max(6, p.fontSize * scale);
                ctx.font = fs + "px " + FONT_FAMILY;
                var lh = fs * sp.lh;
                var text = (p.translatedText && p.translatedText.trim()) ? p.translatedText : p.text;
                var lines = wrapText(ctx, text, colW);

                // Inter-paragraph gap: prefer original (scaled), fall back to gapFactor
                var paraGap = 0;
                if (i < region.paragraphs.length - 1) {
                    var next = region.paragraphs[i + 1];
                    var origGap = next.bbox.y - (p.bbox.y + p.bbox.h);
                    if (isFinite(origGap) && origGap > 0) {
                        paraGap = Math.max(origGap * scale, fs * 0.2);
                    } else {
                        paraGap = fs * sp.gapFactor;
                    }
                }
                items.push({ fs: fs, lh: lh, paraGap: paraGap, lines: lines });
                totalH += lines.length * lh + paraGap;
            }
            return { items: items, totalH: totalH };
        }

        var scale = 1;
        var fit = layout(scale);
        var iters = 0;
        // Allow up to 8% overflow before shrinking
        while (fit.totalH > availH * 1.08 && scale > sp.scaleMin && iters < 10) {
            scale = Math.max(sp.scaleMin, (availH * 0.97) / fit.totalH);
            fit = layout(scale);
            iters++;
        }

        // Draw with clipping (so worst-case overflow doesn't bleed onto neighbors)
        ctx.save();
        ctx.fillStyle = "#111";
        ctx.textBaseline = "top";
        var slack = (region.paragraphs[0] ? region.paragraphs[0].fontSize : 12) * 1.5;
        var clipBottom = Math.min((region.y + region.h + slack), canvasH - 2);
        ctx.beginPath();
        ctx.rect(region.x - 1, region.y - 1, region.w + 2, clipBottom - region.y + 2);
        ctx.clip();

        var y = region.y;
        for (var i = 0; i < fit.items.length; i++) {
            var item = fit.items[i];
            ctx.font = item.fs + "px " + FONT_FAMILY;
            for (var j = 0; j < item.lines.length; j++) {
                ctx.fillText(item.lines[j], region.x, y);
                y += item.lh;
            }
            y += item.paraGap;
        }
        ctx.restore();
    }

    // Step 5: white-out original paragraphs (preserves images outside text)
    function whiteOutOriginalText(ctx, paragraphs) {
        ctx.save();
        ctx.fillStyle = "#ffffff";
        paragraphs.forEach(function (p) {
            // Generous padding to fully cover any anti-aliased glyph pixels
            var pad = Math.max(3, p.fontSize * 0.2);
            ctx.fillRect(
                p.bbox.x - pad,
                p.bbox.y - pad,
                p.bbox.w + pad * 2,
                p.bbox.h + pad * 2
            );
        });
        ctx.restore();
    }

    function applyTranslationsToCanvas(pageData) {
        if (!pageData.paragraphs || pageData.paragraphs.length === 0) return;
        var ctx = pageData.canvas.getContext("2d");

        // 1. Erase all original text
        whiteOutOriginalText(ctx, pageData.paragraphs);

        // 2. Build column-aware reflow regions
        var regions = buildRegions(pageData.paragraphs, pageData.canvasW, pageData.canvasH);

        // 3. Reflow + draw each region
        regions.forEach(function (region) {
            reflowAndDraw(ctx, region, pageData.canvasH);
        });
    }

    /* ------------------------------------------------------------------
       Main flow
    ------------------------------------------------------------------ */
    async function runTranslate() {
        if (state.files.length === 0) { showError("Pilih file PDF terlebih dulu."); return; }
        var sl = els.srcLang.value || "auto";
        var tl = els.tgtLang.value || "id";
        if (sl === tl) { showError("Bahasa sumber dan tujuan tidak boleh sama."); return; }

        els.actionBar.classList.add("hidden");
        els.fileGroups.classList.add("hidden");
        document.getElementById("uploader").classList.add("hidden");
        document.getElementById("langPicker").classList.add("hidden");
        els.result.classList.add("hidden");
        els.progress.classList.remove("hidden");

        try {
            await ensurePdfJs();
            setPdfJsWorker();
            await ensureJsPdf();
            var jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;

            var docs = [];
            var totalPages = 0;
            for (var fi = 0; fi < state.files.length; fi++) {
                var ab = await state.files[fi].arrayBuffer();
                var d = await loadPdfDocument(ab);
                docs.push({ doc: d, name: state.files[fi].name });
                totalPages += d.numPages;
            }

            var pdf = null;
            var pagePtr = 0;
            var allSrcPages = [];
            var allDstPages = [];

            for (var di = 0; di < docs.length; di++) {
                var entry = docs[di];
                for (var pn = 1; pn <= entry.doc.numPages; pn++) {
                    pagePtr++;
                    els.progressText.textContent = "Memproses halaman " + pagePtr + " / " + totalPages;
                    setProgress(5 + (pagePtr - 1) / totalPages * 30, "Render: " + entry.name + " hal. " + pn);

                    var pageData = await renderPageWithMeta(entry.doc, pn);

                    setProgress(5 + (pagePtr - 1) / totalPages * 30 + 10 / totalPages, "Menerjemahkan halaman " + pagePtr);
                    if (pageData.paragraphs.length > 0) {
                        await translateParagraphsBatched(pageData.paragraphs, sl, tl, function (done, total) {
                            var pct = (pagePtr - 1 + done / Math.max(total, 1)) / totalPages;
                            setProgress(35 + pct * 50, "Halaman " + pagePtr + " — paragraf " + done + "/" + total);
                        });
                    }

                    allSrcPages.push(pageData.paragraphs.map(function (p) { return p.text; }).join("\n\n"));
                    allDstPages.push(pageData.paragraphs.map(function (p) { return p.translatedText || ""; }).join("\n\n"));

                    applyTranslationsToCanvas(pageData);

                    var orientation = pageData.ptW > pageData.ptH ? "landscape" : "portrait";
                    if (!pdf) {
                        pdf = new jsPDFCtor({ unit: "pt", format: [pageData.ptW, pageData.ptH], orientation: orientation });
                    } else {
                        pdf.addPage([pageData.ptW, pageData.ptH], orientation);
                    }
                    var imgData = pageData.canvas.toDataURL("image/jpeg", 0.85);
                    pdf.addImage(imgData, "JPEG", 0, 0, pageData.ptW, pageData.ptH);

                    pageData.canvas.width = 0;
                    pageData.canvas.height = 0;
                    pageData.canvas = null;
                }
            }

            setProgress(95, "Membuat file PDF...");
            var blob = pdf.output("blob");
            var primary = state.files[0].name.replace(/\.pdf$/i, "");
            var outName = primary + "_translated_" + tl + ".pdf";

            state.lastResult = { pagesSrc: allSrcPages, pagesDst: allDstPages, filename: outName, blob: blob };

            setProgress(100, "Selesai!");
            els.progress.classList.add("hidden");
            els.result.classList.remove("hidden");
        } catch (err) {
            console.error(err);
            els.progress.classList.add("hidden");
            els.fileGroups.classList.remove("hidden");
            document.getElementById("uploader").classList.remove("hidden");
            document.getElementById("langPicker").classList.remove("hidden");
            els.actionBar.classList.remove("hidden");
            showError("Gagal menerjemahkan PDF: " + (err && err.message ? err.message : err));
        }
    }

    els.btnTranslate.addEventListener("click", runTranslate);

    /* ------------------------------------------------------------------
       Result actions
    ------------------------------------------------------------------ */
    els.btnDownload.addEventListener("click", function () {
        if (!state.lastResult) return;
        var url = URL.createObjectURL(state.lastResult.blob);
        var a = document.createElement("a");
        a.href = url; a.download = state.lastResult.filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    els.btnPreview.addEventListener("click", function () {
        if (!state.lastResult) return;
        els.previewSrc.textContent = state.lastResult.pagesSrc.join("\n\n— Halaman —\n\n");
        els.previewDst.textContent = state.lastResult.pagesDst.join("\n\n— Halaman —\n\n");
        els.preview.classList.toggle("hidden");
    });
    els.btnRestart.addEventListener("click", function () {
        state.files = []; state.lastResult = null;
        renderFileList();
        els.preview.classList.add("hidden");
        els.result.classList.add("hidden");
        els.fileGroups.classList.remove("hidden");
        document.getElementById("uploader").classList.remove("hidden");
        document.getElementById("langPicker").classList.remove("hidden");
        setProgress(0, "");
    });
})();
