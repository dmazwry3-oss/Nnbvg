/* ===================================================================
   PDF Translate – layout-preserving client-side PDF translator

   Strategy:
   1. For each PDF page:
      - Render the original page to a canvas (preserves images, vectors,
        layout — everything except text we'll replace).
      - Extract text items with their canvas-space coordinates.
      - Group items into LINES then PARAGRAPHS (so translation has
        sentence/paragraph context).
   2. Translate paragraphs in batched calls (joined with double newline).
   3. For each page canvas:
      - White-out each paragraph's bounding box.
      - Re-draw the translated text in the same bbox with auto-fit
        font sizing and word-wrap.
   4. Compose into a new PDF using jsPDF (each page = canvas image,
      same physical dimensions as original).

   Translation: Google Translate public gtx endpoint, fallback MyMemory.
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
        uploader: $("uploader"),
        pickfiles: $("pickfiles"),
        fileInput: $("fileInput"),
        fileGroups: $("fileGroups"),
        actionBar: $("actionBar"),
        btnTranslate: $("btnTranslate"),
        btnClear: $("btnClear"),
        progress: $("progress"),
        progressText: $("progressText"),
        progressFill: $("progressFill"),
        progressSub: $("progressSub"),
        result: $("result"),
        btnDownload: $("btnDownload"),
        btnPreview: $("btnPreview"),
        btnRestart: $("btnRestart"),
        preview: $("preview"),
        previewSrc: $("previewSrc"),
        previewDst: $("previewDst"),
        srcLang: $("srcLang"),
        tgtLang: $("tgtLang"),
        swapLang: $("swapLang"),
        errorBox: $("errorBox"),
        year: $("year"),
    };
    if (els.year) els.year.textContent = new Date().getFullYear();

    /* ------------------------------------------------------------------
       State
    ------------------------------------------------------------------ */
    var state = { files: [], lastResult: null };

    /* ------------------------------------------------------------------
       Helpers
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
            state.files.push(f);
            added++;
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
    els.fileInput.addEventListener("change", function (e) {
        addFiles(e.target.files);
        e.target.value = "";
    });
    ["dragenter", "dragover"].forEach(function (ev) {
        els.uploader.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            els.uploader.classList.add("is-dragging");
        });
    });
    ["dragleave", "drop"].forEach(function (ev) {
        els.uploader.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            els.uploader.classList.remove("is-dragging");
        });
    });
    els.uploader.addEventListener("drop", function (e) {
        if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    ["dragover", "drop"].forEach(function (ev) {
        window.addEventListener(ev, function (e) { e.preventDefault(); }, false);
    });
    els.btnClear.addEventListener("click", function () { state.files = []; renderFileList(); });
    els.swapLang.addEventListener("click", function () {
        var s = els.srcLang.value, t = els.tgtLang.value;
        if (s === "auto") return;
        els.srcLang.value = t; els.tgtLang.value = s;
    });

    /* ------------------------------------------------------------------
       Paragraph extraction (canvas-space coordinates)
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

        // Group into lines
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

        // Group lines into paragraphs
        var paragraphs = [];
        var p = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (!p) { p = { lines: [ln] }; paragraphs.push(p); continue; }
            var prev = p.lines[p.lines.length - 1];
            var sameSize = Math.abs(ln.fontSize - prev.fontSize) / Math.max(prev.fontSize, 1) < 0.25;
            // Same column: x overlap >= 30% of narrower line
            var overlap = Math.min(prev.x2, ln.x2) - Math.max(prev.x, ln.x);
            var minW = Math.min(prev.x2 - prev.x, ln.x2 - ln.x);
            var sameCol = overlap >= minW * 0.3;
            // Close vertically
            var gap = ln.y - prev.bottom;
            var closeY = gap < prev.fontSize * 1.1 && gap >= -2;
            if (sameSize && sameCol && closeY) {
                p.lines.push(ln);
            } else {
                p = { lines: [ln] }; paragraphs.push(p);
            }
        }

        return paragraphs.map(function (p) {
            var x = Math.min.apply(null, p.lines.map(function (l) { return l.x; }));
            var x2 = Math.max.apply(null, p.lines.map(function (l) { return l.x2; }));
            var y = Math.min.apply(null, p.lines.map(function (l) { return l.y; }));
            var y2 = Math.max.apply(null, p.lines.map(function (l) { return l.bottom; }));
            var text = p.lines.map(function (l) { return l.text; }).join(" ").replace(/\s+/g, " ").trim();
            // Fix mid-word hyphenation (English only)
            text = text.replace(/(\w+)-\s+(\w+)/g, "$1$2");
            var fontSize = p.lines.reduce(function (s, l) { return s + l.fontSize; }, 0) / p.lines.length;
            return { bbox: { x: x, y: y, w: x2 - x, h: y2 - y }, text: text, fontSize: fontSize };
        }).filter(function (p) { return p.text.length > 0; });
    }

    /* ------------------------------------------------------------------
       Render a PDF page → { canvas, paragraphs, ptW, ptH }
    ------------------------------------------------------------------ */
    var RENDER_SCALE = 1.5; // canvas pixels per PDF point. Higher = better quality but more memory.

    async function renderPageWithMeta(pdfDoc, pageNum) {
        var page = await pdfDoc.getPage(pageNum);
        var viewport = page.getViewport({ scale: RENDER_SCALE });
        var canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        var ctx = canvas.getContext("2d");

        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        var content = await page.getTextContent();
        var items = content.items
            .filter(function (it) { return it && it.str && it.str.trim().length; })
            .map(function (it) {
                var tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
                var fontHeight = Math.hypot(tx[2], tx[3]);
                var ascent = fontHeight * 0.85;
                return {
                    str: it.str,
                    x: tx[4],
                    y: tx[5] - ascent, // top
                    width: it.width * RENDER_SCALE,
                    height: fontHeight * 1.1,
                    fontSize: fontHeight,
                };
            });

        var paragraphs = extractParagraphs(items);

        return {
            canvas: canvas,
            paragraphs: paragraphs,
            ptW: viewport.width / RENDER_SCALE,
            ptH: viewport.height / RENDER_SCALE,
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

    // Translate an array of paragraphs by batching them with `\n\n` separators
    // (Google Translate preserves paragraph breaks reliably).
    async function translateParagraphsBatched(paragraphs, sl, tl, onProgress) {
        if (paragraphs.length === 0) return;

        var SEP = "\n\n";
        var GOOGLE_LIMIT = 4500;
        var MYMEM_LIMIT = 480;

        // Build batches per provider
        function makeBatches(limit) {
            var batches = [];
            var curr = [];
            var len = 0;
            paragraphs.forEach(function (p) {
                var pLen = p.text.length + SEP.length;
                if (len + pLen > limit && curr.length > 0) {
                    batches.push(curr);
                    curr = [];
                    len = 0;
                }
                curr.push(p);
                len += pLen;
            });
            if (curr.length) batches.push(curr);
            return batches;
        }

        // Try Google in larger batches
        try {
            var batches = makeBatches(GOOGLE_LIMIT);
            var done = 0;
            for (var i = 0; i < batches.length; i++) {
                var batch = batches[i];
                // Replace internal newlines so Google doesn't re-split
                var combined = batch.map(function (p) { return p.text.replace(/\n+/g, " "); }).join(SEP);
                var translated = await translateGoogle(combined, sl, tl);
                var parts = translated.split(/\n\n+/);
                // Best-effort alignment: if mismatch, also try \n
                if (parts.length !== batch.length) {
                    parts = translated.split(/\n+/);
                }
                for (var j = 0; j < batch.length; j++) {
                    batch[j].translatedText = (parts[j] || batch[j].text).trim();
                }
                done += batch.length;
                if (onProgress) onProgress(done, paragraphs.length);
            }
            return;
        } catch (gErr) {
            console.warn("Google batch failed, falling back to MyMemory per-paragraph:", gErr);
        }

        // Fallback: MyMemory per-paragraph (smaller limit, no batching)
        for (var k = 0; k < paragraphs.length; k++) {
            var p = paragraphs[k];
            try {
                if (p.text.length <= MYMEM_LIMIT) {
                    p.translatedText = await translateMyMemory(p.text, sl, tl);
                } else {
                    // Split by sentence
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
            } catch (e) {
                p.translatedText = p.text;
            }
            if (onProgress) onProgress(k + 1, paragraphs.length);
        }
    }

    /* ------------------------------------------------------------------
       Draw translated text onto canvas (white-out + auto-fit)
    ------------------------------------------------------------------ */
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
                        // Hard-break long word
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

    function drawAutoFitText(ctx, text, bbox, originalSize) {
        ctx.fillStyle = "#111";
        ctx.textBaseline = "top";

        var fontFamily = "Georgia, 'Times New Roman', 'Noto Serif', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans Arabic', serif";
        var size = originalSize;
        var minSize = Math.max(originalSize * 0.55, 7);

        function tryFit(s) {
            ctx.font = s + "px " + fontFamily;
            var lh = s * 1.18;
            var lines = wrapText(ctx, text, bbox.w);
            return { lines: lines, totalH: lines.length * lh, lh: lh };
        }

        var fit = tryFit(size);
        while (fit.totalH > bbox.h * 1.08 && size > minSize) {
            size = Math.max(minSize, size - 0.5);
            fit = tryFit(size);
        }

        var y = bbox.y;
        for (var i = 0; i < fit.lines.length; i++) {
            // Stop if we'd overflow significantly
            if (y - bbox.y > bbox.h + size * 1.5) break;
            ctx.fillText(fit.lines[i], bbox.x, y);
            y += fit.lh;
        }
    }

    function applyTranslationsToCanvas(pageData) {
        var ctx = pageData.canvas.getContext("2d");
        // White-out all paragraph bboxes first (so neighboring overlap doesn't reveal old text)
        ctx.save();
        ctx.fillStyle = "#ffffff";
        pageData.paragraphs.forEach(function (p) {
            var pad = 2;
            ctx.fillRect(p.bbox.x - pad, p.bbox.y - pad, p.bbox.w + pad * 2, p.bbox.h + pad * 2);
        });
        ctx.restore();
        // Draw translated text
        pageData.paragraphs.forEach(function (p) {
            if (!p.translatedText) return;
            drawAutoFitText(ctx, p.translatedText, p.bbox, p.fontSize);
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

        // UI state
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

            // Compute total page count for progress
            var docs = [];
            var totalPages = 0;
            for (var fi = 0; fi < state.files.length; fi++) {
                var ab = await state.files[fi].arrayBuffer();
                var d = await pdfjsLib.getDocument({ data: ab }).promise;
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

                    // 1. Render + extract
                    var pageData = await renderPageWithMeta(entry.doc, pn);

                    // 2. Translate paragraphs
                    setProgress(5 + (pagePtr - 1) / totalPages * 30 + 10 / totalPages, "Menerjemahkan halaman " + pagePtr);
                    if (pageData.paragraphs.length > 0) {
                        await translateParagraphsBatched(pageData.paragraphs, sl, tl, function (done, total) {
                            var pct = (pagePtr - 1 + done / Math.max(total, 1)) / totalPages;
                            setProgress(35 + pct * 50, "Halaman " + pagePtr + " — paragraf " + done + "/" + total);
                        });
                    }

                    // 3. Save snapshots for preview
                    allSrcPages.push(pageData.paragraphs.map(function (p) { return p.text; }).join("\n\n"));
                    allDstPages.push(pageData.paragraphs.map(function (p) { return p.translatedText || ""; }).join("\n\n"));

                    // 4. Apply translations to canvas
                    applyTranslationsToCanvas(pageData);

                    // 5. Add to PDF
                    var orientation = pageData.ptW > pageData.ptH ? "landscape" : "portrait";
                    if (!pdf) {
                        pdf = new jsPDFCtor({
                            unit: "pt",
                            format: [pageData.ptW, pageData.ptH],
                            orientation: orientation,
                        });
                    } else {
                        pdf.addPage([pageData.ptW, pageData.ptH], orientation);
                    }
                    var imgData = pageData.canvas.toDataURL("image/jpeg", 0.85);
                    pdf.addImage(imgData, "JPEG", 0, 0, pageData.ptW, pageData.ptH);

                    // 6. Free memory
                    pageData.canvas.width = 0;
                    pageData.canvas.height = 0;
                    pageData.canvas = null;
                }
            }

            setProgress(95, "Membuat file PDF...");
            var blob = pdf.output("blob");
            var primary = state.files[0].name.replace(/\.pdf$/i, "");
            var outName = primary + "_translated_" + tl + ".pdf";

            state.lastResult = {
                pagesSrc: allSrcPages,
                pagesDst: allDstPages,
                filename: outName,
                blob: blob,
            };

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
