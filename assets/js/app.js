/* ===================================================================
   PDF Translate – client-side PDF translator
   - Extracts text with PDF.js
   - Translates via Google Translate (gtx public endpoint),
     fallback to MyMemory
   - Re-renders translated text as a new PDF using jsPDF + html2canvas
   =================================================================== */

(function () {
    "use strict";

    // ---------- CDN fallback loader ----------
    function loadScript(urls) {
        return new Promise(function (resolve, reject) {
            var i = 0;
            function tryNext() {
                if (i >= urls.length) return reject(new Error("All CDNs failed: " + urls.join(", ")));
                var url = urls[i++];
                var s = document.createElement("script");
                s.src = url;
                s.onload = function () { resolve(url); };
                s.onerror = function () { tryNext(); };
                document.head.appendChild(s);
            }
            tryNext();
        });
    }

    // ---------- Ensure PDF.js is loaded (with fallback CDN) ----------
    async function ensurePdfJs() {
        if (window.pdfjsLib) return;
        await loadScript([
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
            "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js",
        ]);
        if (!window.pdfjsLib) throw new Error("pdfjsLib gagal dimuat dari semua CDN");
    }

    function setPdfJsWorker() {
        if (!window.pdfjsLib) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    setPdfJsWorker();

    // ---------- Ensure html2canvas (preloaded in HTML, but fallback just in case) ----------
    async function ensureHtml2Canvas() {
        if (window.html2canvas) return;
        await loadScript([
            "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
            "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
        ]);
        if (!window.html2canvas) throw new Error("html2canvas gagal dimuat");
    }

    // ---------- Ensure jsPDF (fallback) ----------
    async function ensureJsPdf() {
        if ((window.jspdf && window.jspdf.jsPDF) || window.jsPDF) return;
        await loadScript([
            "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
            "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js",
        ]);
    }

    // ---------- DOM ----------
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

    // ---------- State ----------
    var state = {
        files: [],          // array of File
        lastResult: null,   // { pages: [{src,dst}], filename, blob }
    };

    // ---------- Helpers ----------
    function showError(msg) {
        els.errorBox.textContent = msg;
        els.errorBox.classList.remove("hidden");
        setTimeout(function () { els.errorBox.classList.add("hidden"); }, 8000);
    }
    function setProgress(pct, sub) {
        els.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        if (sub != null) els.progressSub.textContent = sub;
    }
    function fmtSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
        });
    }

    // ---------- File handling ----------
    function addFiles(fileList) {
        var added = 0;
        Array.prototype.forEach.call(fileList, function (f) {
            if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) return;
            // de-duplicate by name+size
            if (state.files.some(function (x) { return x.name === f.name && x.size === f.size; })) return;
            state.files.push(f);
            added++;
        });
        if (added === 0 && fileList.length > 0) {
            showError("Hanya file PDF yang didukung.");
        }
        renderFileList();
    }
    function removeFile(idx) {
        state.files.splice(idx, 1);
        renderFileList();
    }
    function renderFileList() {
        els.fileGroups.innerHTML = "";
        state.files.forEach(function (f, i) {
            var card = document.createElement("div");
            card.className = "filecard";
            card.innerHTML =
                '<div class="filecard__ico">PDF</div>' +
                '<div class="filecard__meta">' +
                    '<div class="filecard__name">' + escapeHtml(f.name) + '</div>' +
                    '<div class="filecard__size">' + fmtSize(f.size) + '</div>' +
                '</div>' +
                '<button class="filecard__remove" type="button" aria-label="Hapus">&times;</button>';
            card.querySelector(".filecard__remove").addEventListener("click", function () {
                removeFile(i);
            });
            els.fileGroups.appendChild(card);
        });
        els.actionBar.classList.toggle("hidden", state.files.length === 0);
    }

    // Click to upload
    els.pickfiles.addEventListener("click", function () { els.fileInput.click(); });
    els.uploader.addEventListener("click", function (e) {
        if (e.target === els.uploader || e.target.classList.contains("uploader__droptxt")) {
            els.fileInput.click();
        }
    });
    els.fileInput.addEventListener("change", function (e) {
        addFiles(e.target.files);
        e.target.value = "";
    });

    // Drag & drop
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
    // Window-level drop guard
    ["dragover", "drop"].forEach(function (ev) {
        window.addEventListener(ev, function (e) { e.preventDefault(); }, false);
    });

    // Clear / restart
    els.btnClear.addEventListener("click", function () {
        state.files = [];
        renderFileList();
    });

    // Swap languages
    els.swapLang.addEventListener("click", function () {
        var s = els.srcLang.value;
        var t = els.tgtLang.value;
        if (s === "auto") return; // can't swap "auto" into target
        els.srcLang.value = t;
        els.tgtLang.value = s;
    });

    // ---------- PDF text extraction (column-aware for academic papers) ----------

    // Smart line joiner: if x-gap between items is small, no extra space (word continuation)
    function joinLineItems(lineItems) {
        lineItems.sort(function (a, b) { return a.x - b.x; });
        var out = "";
        for (var i = 0; i < lineItems.length; i++) {
            var it = lineItems[i];
            if (i === 0) { out += it.str; continue; }
            var prev = lineItems[i - 1];
            var prevEnd = prev.x + (prev.width || 0);
            var gap = it.x - prevEnd;
            var charW = (prev.height || 10) * 0.3;
            // If previous already ends with whitespace OR new starts with whitespace, just concat
            if (/\s$/.test(out) || /^\s/.test(it.str)) {
                out += it.str;
            } else if (gap > charW * 1.3) {
                out += " " + it.str;
            } else {
                out += it.str; // word continuation, no extra space
            }
        }
        return out.replace(/[ \t]+/g, " ").trim();
    }

    // Group items into raw lines by y-proximity
    function groupIntoLines(items, yTol) {
        items.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
        var lines = [];
        var curr = [];
        var currY = null;
        items.forEach(function (it) {
            if (currY === null || Math.abs(it.y - currY) <= yTol) {
                curr.push(it);
                if (currY === null) currY = it.y;
            } else {
                lines.push({ y: currY, items: curr });
                curr = [it];
                currY = it.y;
            }
        });
        if (curr.length) lines.push({ y: currY, items: curr });
        return lines;
    }

    // Build text from a list of "raw lines" with paragraph-gap detection
    function linesToText(lines) {
        var parts = [];
        var prevY = null;
        var prevH = null;
        lines.forEach(function (ln) {
            var text = joinLineItems(ln.items);
            if (!text) return;
            var lineH = ln.items[0].height || 10;
            if (prevY !== null) {
                var gap = prevY - ln.y;
                if (gap > Math.max(lineH, prevH) * 1.6) parts.push(""); // blank line = paragraph break
            }
            parts.push(text);
            prevY = ln.y;
            prevH = lineH;
        });
        return parts.join("\n");
    }

    async function extractPdfText(file) {
        await ensurePdfJs();
        setPdfJsWorker();
        var arrayBuf = await file.arrayBuffer();
        var pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
        var pages = [];

        for (var i = 1; i <= pdf.numPages; i++) {
            var page = await pdf.getPage(i);
            var viewport = page.getViewport({ scale: 1 });
            var pageWidth = viewport.width;
            var midX = pageWidth / 2;
            var content = await page.getTextContent();

            var items = content.items
                .filter(function (it) { return it && it.str; })
                .map(function (it) {
                    return {
                        str: it.str,
                        x: it.transform[4],
                        y: it.transform[5],
                        width: it.width || 0,
                        height: it.height || (it.transform[3] || 10),
                    };
                });

            if (items.length === 0) { pages.push(""); continue; }

            // Step 1: build raw lines
            var rawLines = groupIntoLines(items.slice(), 3);

            // Step 2: classify each line as full-width, left-col, right-col, or split (2 col-lines on same y)
            var classified = rawLines.map(function (ln) {
                ln.items.sort(function (a, b) { return a.x - b.x; });
                var minX = ln.items[0].x;
                var maxXEnd = ln.items.reduce(function (m, it) {
                    return Math.max(m, it.x + (it.width || 0));
                }, 0);

                // Entirely in left half?
                if (maxXEnd <= midX + 10) return { type: "left", line: ln };
                // Entirely in right half?
                if (minX >= midX - 10) return { type: "right", line: ln };

                // Mixed: detect gap around middle to decide split vs full-width
                var leftItems = ln.items.filter(function (it) { return (it.x + (it.width || 0)) <= midX + 5; });
                var rightItems = ln.items.filter(function (it) { return it.x >= midX - 5; });
                var hasGap = leftItems.length > 0 && rightItems.length > 0;

                if (hasGap) {
                    // Compute the gap size
                    var leftMaxEnd = Math.max.apply(null, leftItems.map(function (it) { return it.x + (it.width || 0); }));
                    var rightMinX = Math.min.apply(null, rightItems.map(function (it) { return it.x; }));
                    var gutter = rightMinX - leftMaxEnd;
                    if (gutter > 20) {
                        // Two separate column-lines on same y → split
                        return {
                            type: "split",
                            leftLine: { y: ln.y, items: leftItems },
                            rightLine: { y: ln.y, items: rightItems },
                        };
                    }
                }
                // Otherwise full-width line
                return { type: "full", line: ln };
            });

            // Step 3: detect if page is 2-column
            var twoColLines = classified.filter(function (c) { return c.type === "split" || c.type === "left" || c.type === "right"; }).length;
            var fullLines = classified.filter(function (c) { return c.type === "full"; }).length;
            var isTwoCol = twoColLines >= 5 && twoColLines > fullLines * 0.6;

            var pageText;

            if (!isTwoCol) {
                // Single column: just stitch lines top-to-bottom
                var allLines = classified.map(function (c) {
                    if (c.type === "split") {
                        // shouldn't happen if not 2col, but handle
                        return { y: c.leftLine.y, items: c.leftLine.items.concat(c.rightLine.items) };
                    }
                    return c.line;
                });
                pageText = linesToText(allLines);
            } else {
                // Two-column: separate "top full-width region" from columnar body
                // Find first non-full line index
                var splitIdx = 0;
                while (splitIdx < classified.length && classified[splitIdx].type === "full") splitIdx++;

                var topLines = classified.slice(0, splitIdx).map(function (c) { return c.line; });
                var bodyClassified = classified.slice(splitIdx);

                var leftBody = [];
                var rightBody = [];
                bodyClassified.forEach(function (c) {
                    if (c.type === "split") {
                        leftBody.push(c.leftLine);
                        rightBody.push(c.rightLine);
                    } else if (c.type === "left") {
                        leftBody.push(c.line);
                    } else if (c.type === "right") {
                        rightBody.push(c.line);
                    } else {
                        // full-width inside body (section heading or footer): put in left col
                        leftBody.push(c.line);
                    }
                });

                var topText = linesToText(topLines);
                var leftText = linesToText(leftBody);
                var rightText = linesToText(rightBody);

                pageText = [topText, leftText, rightText].filter(Boolean).join("\n\n");
            }

            // Cleanup: fix common hyphenation across lines (e.g. "trans-\nlation" → "translation")
            pageText = pageText.replace(/(\w+)-\n(\w+)/g, "$1$2");

            pages.push(pageText);
        }

        return pages;
    }

    // ---------- Translation ----------
    // Chunk text under provider limits
    function chunkText(text, max) {
        var chunks = [];
        var paragraphs = text.split(/\n+/);
        var buf = "";
        paragraphs.forEach(function (p) {
            if ((buf + "\n" + p).length > max) {
                if (buf) chunks.push(buf);
                if (p.length > max) {
                    // hard split very long paragraph by sentence/word
                    var sentences = p.split(/(?<=[\.\!\?。！？])\s+/);
                    var sb = "";
                    sentences.forEach(function (s) {
                        if ((sb + " " + s).length > max) {
                            if (sb) chunks.push(sb);
                            if (s.length > max) {
                                for (var i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
                                sb = "";
                            } else {
                                sb = s;
                            }
                        } else {
                            sb = sb ? sb + " " + s : s;
                        }
                    });
                    if (sb) chunks.push(sb);
                    buf = "";
                } else {
                    buf = p;
                }
            } else {
                buf = buf ? buf + "\n" + p : p;
            }
        });
        if (buf) chunks.push(buf);
        return chunks;
    }

    // Provider 1: Google Translate public gtx endpoint (CORS-friendly, free)
    async function translateGoogle(text, sl, tl) {
        var url = "https://translate.googleapis.com/translate_a/single" +
            "?client=gtx&sl=" + encodeURIComponent(sl) +
            "&tl=" + encodeURIComponent(tl) +
            "&dt=t&q=" + encodeURIComponent(text);
        var r = await fetch(url);
        if (!r.ok) throw new Error("Google HTTP " + r.status);
        var data = await r.json();
        // data[0] is array of [translatedSegment, originalSegment, ...]
        if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Bad Google response");
        return data[0].map(function (seg) { return seg[0]; }).join("");
    }

    // Provider 2: MyMemory fallback (smaller limit, ~500 chars)
    async function translateMyMemory(text, sl, tl) {
        var srcParam = sl === "auto" ? "Autodetect" : sl;
        var url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) +
            "&langpair=" + encodeURIComponent(srcParam) + "|" + encodeURIComponent(tl);
        var r = await fetch(url);
        if (!r.ok) throw new Error("MyMemory HTTP " + r.status);
        var data = await r.json();
        if (!data.responseData || !data.responseData.translatedText) throw new Error("Bad MyMemory response");
        return data.responseData.translatedText;
    }

    async function translateText(text, sl, tl) {
        if (!text || !text.trim()) return "";
        var GOOGLE_LIMIT = 4500;
        var MYMEM_LIMIT = 480;

        // Try Google in big chunks first
        try {
            var chunks = chunkText(text, GOOGLE_LIMIT);
            var out = [];
            for (var i = 0; i < chunks.length; i++) {
                out.push(await translateGoogle(chunks[i], sl, tl));
            }
            return out.join("\n");
        } catch (gErr) {
            console.warn("Google failed, falling back to MyMemory:", gErr);
            // Fallback to MyMemory in smaller chunks
            var chunks2 = chunkText(text, MYMEM_LIMIT);
            var out2 = [];
            for (var j = 0; j < chunks2.length; j++) {
                out2.push(await translateMyMemory(chunks2[j], sl, tl));
            }
            return out2.join("\n");
        }
    }

    // ---------- PDF generation (Unicode-safe via html2canvas + jsPDF) ----------
    async function buildPdfFromPages(translatedPages, meta) {
        await ensureJsPdf();
        await ensureHtml2Canvas();
        var jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!jsPDFCtor) throw new Error("jsPDF tidak tersedia");

        var pdf = new jsPDFCtor({ unit: "pt", format: "a4", orientation: "portrait" });
        var pageW = pdf.internal.pageSize.getWidth();
        var pageH = pdf.internal.pageSize.getHeight();
        var marginPt = 36; // ~0.5"
        var contentW = pageW - marginPt * 2;

        // Off-screen container with journal-style typography
        var stage = document.createElement("div");
        stage.style.cssText = [
            "position:fixed",
            "left:-99999px",
            "top:0",
            "width:" + Math.round(contentW * 1.5) + "px",
            "background:#fff",
            "color:#1a1a1a",
            "padding:0",
            "font-family:Georgia,'Times New Roman','Noto Serif','Noto Sans','Noto Sans CJK SC','Noto Sans Arabic',serif",
            "font-size:14px",
            "line-height:1.65",
        ].join(";");
        document.body.appendChild(stage);

        // Helper: turn translated text into paragraphed HTML
        function textToParagraphs(text) {
            var paras = String(text || "").split(/\n{2,}/);
            return paras.map(function (p) {
                // Within a paragraph, keep single line breaks but as soft wrap
                var html = escapeHtml(p).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
                if (!html) return "";
                return '<p style="margin:0 0 10px;text-align:justify;text-justify:inter-word;">' + html + '</p>';
            }).filter(Boolean).join("");
        }

        try {
            for (var p = 0; p < translatedPages.length; p++) {
                var bodyHtml = textToParagraphs(translatedPages[p]) ||
                    '<p style="color:#999;font-style:italic;">(halaman kosong / tidak ada teks)</p>';
                stage.innerHTML = '' +
                    '<div style="padding:32px 36px;">' +
                        '<div style="font-size:10px;color:#999;margin-bottom:18px;border-bottom:1px solid #ddd;padding-bottom:8px;text-align:right;font-family:Arial,sans-serif;">' +
                            escapeHtml(meta.filename) + ' &middot; Halaman ' + (p + 1) + ' / ' + translatedPages.length +
                        '</div>' +
                        '<div>' + bodyHtml + '</div>' +
                    '</div>';

                var canvas = await window.html2canvas(stage, {
                    backgroundColor: "#ffffff",
                    scale: 2,
                    useCORS: true,
                    logging: false,
                });
                var imgData = canvas.toDataURL("image/jpeg", 0.92);

                var imgW = contentW;
                var imgH = (canvas.height * imgW) / canvas.width;

                if (p > 0) pdf.addPage();

                // If image taller than one page, slice it across pages
                if (imgH <= pageH - marginPt * 2) {
                    pdf.addImage(imgData, "JPEG", marginPt, marginPt, imgW, imgH);
                } else {
                    var availH = pageH - marginPt * 2;
                    var pxPerPt = canvas.width / imgW;
                    var sliceHpx = availH * pxPerPt;
                    var totalH = canvas.height;
                    var offset = 0;
                    var firstSlice = true;
                    while (offset < totalH) {
                        var thisH = Math.min(sliceHpx, totalH - offset);
                        var slice = document.createElement("canvas");
                        slice.width = canvas.width;
                        slice.height = thisH;
                        var ctx = slice.getContext("2d");
                        ctx.drawImage(canvas, 0, offset, canvas.width, thisH, 0, 0, canvas.width, thisH);
                        var sliceData = slice.toDataURL("image/jpeg", 0.92);
                        var sliceHpt = thisH / pxPerPt;
                        if (!firstSlice) pdf.addPage();
                        pdf.addImage(sliceData, "JPEG", marginPt, marginPt, imgW, sliceHpt);
                        offset += thisH;
                        firstSlice = false;
                    }
                }
            }
        } finally {
            stage.remove();
        }

        return pdf.output("blob");
    }

    // ---------- Main flow ----------
    async function runTranslate() {
        if (state.files.length === 0) {
            showError("Pilih file PDF terlebih dulu.");
            return;
        }
        var sl = els.srcLang.value || "auto";
        var tl = els.tgtLang.value || "id";
        if (sl === tl) {
            showError("Bahasa sumber dan tujuan tidak boleh sama.");
            return;
        }

        // UI -> progress mode
        els.actionBar.classList.add("hidden");
        els.fileGroups.classList.add("hidden");
        document.getElementById("uploader").classList.add("hidden");
        document.getElementById("langPicker").classList.add("hidden");
        els.result.classList.add("hidden");
        els.progress.classList.remove("hidden");

        try {
            var allPagesSrc = [];
            var allPagesDst = [];

            // Process each file (we'll concatenate results into one combined pdf)
            for (var fi = 0; fi < state.files.length; fi++) {
                var file = state.files[fi];

                // Step 1: extract
                els.progressText.textContent = "Mengekstrak teks dari PDF...";
                setProgress(5 + (fi / state.files.length) * 30, file.name);
                var pages = await extractPdfText(file);

                // Step 2: translate page by page (so progress is granular)
                els.progressText.textContent = "Menerjemahkan halaman...";
                for (var pi = 0; pi < pages.length; pi++) {
                    var srcText = pages[pi];
                    var dst = await translateText(srcText, sl, tl);
                    allPagesSrc.push(srcText);
                    allPagesDst.push(dst);
                    var done = (fi + (pi + 1) / pages.length) / state.files.length;
                    setProgress(35 + done * 50, "Halaman " + (pi + 1) + " / " + pages.length + " - " + file.name);
                }
            }

            // Step 3: build PDF
            els.progressText.textContent = "Membuat PDF terjemahan...";
            setProgress(90, "Merender halaman ke PDF...");
            var primaryName = state.files[0].name.replace(/\.pdf$/i, "");
            var outName = primaryName + "_translated_" + tl + ".pdf";
            var blob = await buildPdfFromPages(allPagesDst, { filename: outName });

            state.lastResult = {
                pagesSrc: allPagesSrc,
                pagesDst: allPagesDst,
                filename: outName,
                blob: blob,
            };

            setProgress(100, "Selesai!");
            els.progress.classList.add("hidden");
            els.result.classList.remove("hidden");
        } catch (err) {
            console.error(err);
            els.progress.classList.add("hidden");
            // Restore upload UI
            els.fileGroups.classList.remove("hidden");
            document.getElementById("uploader").classList.remove("hidden");
            document.getElementById("langPicker").classList.remove("hidden");
            els.actionBar.classList.remove("hidden");
            showError("Gagal menerjemahkan PDF: " + (err && err.message ? err.message : err));
        }
    }

    els.btnTranslate.addEventListener("click", runTranslate);

    // ---------- Result actions ----------
    els.btnDownload.addEventListener("click", function () {
        if (!state.lastResult) return;
        var url = URL.createObjectURL(state.lastResult.blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = state.lastResult.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    els.btnPreview.addEventListener("click", function () {
        if (!state.lastResult) return;
        els.previewSrc.textContent = state.lastResult.pagesSrc.join("\n\n— Halaman —\n\n");
        els.previewDst.textContent = state.lastResult.pagesDst.join("\n\n— Halaman —\n\n");
        els.preview.classList.toggle("hidden");
    });

    els.btnRestart.addEventListener("click", function () {
        state.files = [];
        state.lastResult = null;
        renderFileList();
        els.preview.classList.add("hidden");
        els.result.classList.add("hidden");
        els.fileGroups.classList.remove("hidden");
        document.getElementById("uploader").classList.remove("hidden");
        document.getElementById("langPicker").classList.remove("hidden");
        setProgress(0, "");
    });
})();
