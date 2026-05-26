/* ===================================================================
   app.js — orchestrator
   Wires together the pipeline:
     extractDocument → classifyDocument → cleanBlocks
                     → translateBlocks → buildHtmlDocument → exportToPdf
   =================================================================== */

import { extractDocument } from "./extractor.js";
import { classifyDocument } from "./classifier.js";
import { cleanBlocks } from "./cleaner.js";
import { translateBlocks } from "./translator.js";
import { buildHtmlDocument, exportToPdf, openHtmlPreview } from "./renderer.js";

(function () {
    "use strict";

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";
    }

    const $ = (id) => document.getElementById(id);
    const els = {
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
        langPicker: $("langPicker"),
    };
    if (els.year) els.year.textContent = new Date().getFullYear();

    const state = {
        files: [],
        lastResult: null, // { htmlString, filename, srcText, dstText }
    };

    /* ----- helpers ----- */
    const fmtSize = (b) =>
        b < 1024
            ? b + " B"
            : b < 1024 * 1024
            ? (b / 1024).toFixed(1) + " KB"
            : (b / (1024 * 1024)).toFixed(2) + " MB";
    const escapeHtml = (s) =>
        String(s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );

    function showError(msg) {
        els.errorBox.textContent = msg;
        els.errorBox.classList.remove("hidden");
        setTimeout(() => els.errorBox.classList.add("hidden"), 8000);
    }
    function setProgress(pct, sub) {
        els.progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        if (sub != null) els.progressSub.textContent = sub;
    }

    /* ----- file handling ----- */
    function addFiles(list) {
        let added = 0;
        Array.prototype.forEach.call(list, (f) => {
            if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) return;
            if (state.files.some((x) => x.name === f.name && x.size === f.size)) return;
            state.files.push(f);
            added++;
        });
        if (!added && list.length) showError("Hanya file PDF yang didukung.");
        renderFileList();
    }
    function renderFileList() {
        els.fileGroups.innerHTML = "";
        state.files.forEach((f, i) => {
            const card = document.createElement("div");
            card.className = "filecard";
            card.innerHTML =
                `<div class="filecard__ico">PDF</div>` +
                `<div class="filecard__meta">` +
                `<div class="filecard__name">${escapeHtml(f.name)}</div>` +
                `<div class="filecard__size">${fmtSize(f.size)}</div>` +
                `</div>` +
                `<button class="filecard__remove" type="button" aria-label="Hapus">&times;</button>`;
            card.querySelector(".filecard__remove").addEventListener("click", () => {
                state.files.splice(i, 1);
                renderFileList();
            });
            els.fileGroups.appendChild(card);
        });
        els.actionBar.classList.toggle("hidden", state.files.length === 0);
    }

    els.pickfiles.addEventListener("click", () => els.fileInput.click());
    els.uploader.addEventListener("click", (e) => {
        if (e.target === els.uploader || e.target.classList.contains("uploader__droptxt")) {
            els.fileInput.click();
        }
    });
    els.fileInput.addEventListener("change", (e) => {
        addFiles(e.target.files);
        e.target.value = "";
    });

    ["dragenter", "dragover"].forEach((ev) =>
        els.uploader.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            els.uploader.classList.add("is-dragging");
        })
    );
    ["dragleave", "drop"].forEach((ev) =>
        els.uploader.addEventListener(ev, (e) => {
            e.preventDefault();
            e.stopPropagation();
            els.uploader.classList.remove("is-dragging");
        })
    );
    els.uploader.addEventListener("drop", (e) => {
        if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    ["dragover", "drop"].forEach((ev) =>
        window.addEventListener(ev, (e) => e.preventDefault(), false)
    );

    els.btnClear.addEventListener("click", () => {
        state.files = [];
        renderFileList();
    });
    els.swapLang.addEventListener("click", () => {
        const s = els.srcLang.value;
        const t = els.tgtLang.value;
        if (s === "auto") return;
        els.srcLang.value = t;
        els.tgtLang.value = s;
    });

    /* ----- main flow ----- */
    async function run() {
        if (!state.files.length) return showError("Pilih file PDF terlebih dulu.");
        const sl = els.srcLang.value || "auto";
        const tl = els.tgtLang.value || "id";
        if (sl === tl && sl !== "auto") {
            return showError("Bahasa sumber dan tujuan tidak boleh sama.");
        }

        // UI -> progress mode
        els.actionBar.classList.add("hidden");
        els.fileGroups.classList.add("hidden");
        els.uploader.classList.add("hidden");
        els.langPicker.classList.add("hidden");
        els.result.classList.add("hidden");
        els.progress.classList.remove("hidden");
        setProgress(0, "");

        try {
            const allBlocks = [];
            const srcSnapshots = [];

            for (let fi = 0; fi < state.files.length; fi++) {
                const file = state.files[fi];
                const fileFrac = fi / state.files.length;

                els.progressText.textContent = "Mengekstrak teks dari PDF...";
                setProgress(5 + fileFrac * 5, "Membuka " + file.name);

                const { pages } = await extractDocument(file);

                els.progressText.textContent = "Menganalisis struktur dokumen...";
                setProgress(15 + fileFrac * 10, "Klasifikasi blok...");

                const classified = classifyDocument(pages);
                const cleaned = cleanBlocks(classified);

                // Snapshot source text BEFORE translation overwrites it
                srcSnapshots.push(snapshotText(cleaned, file.name));

                els.progressText.textContent = "Menerjemahkan blok...";
                await translateBlocks(cleaned, sl, tl, (p) => {
                    setProgress(
                        25 + fileFrac * 60 + (p * 60) / state.files.length,
                        "Menerjemahkan... " + Math.round(p * 100) + "%"
                    );
                });

                allBlocks.push(...cleaned);
            }

            els.progressText.textContent = "Menyusun HTML & PDF...";
            setProgress(92, "Membangun dokumen...");

            const primaryName = state.files[0].name.replace(/\.pdf$/i, "");
            const outName = primaryName + "_translated_" + tl + ".pdf";
            const titleBlock = allBlocks.find((b) => b.type === "title");
            const titleText = (titleBlock && titleBlock.text) || primaryName;

            const htmlString = buildHtmlDocument(allBlocks, {
                title: titleText,
                lang: tl,
            });

            state.lastResult = {
                htmlString,
                filename: outName,
                srcText: srcSnapshots.join("\n\n— File berikutnya —\n\n"),
                dstText: snapshotText(allBlocks, "translated"),
            };

            setProgress(100, "Selesai!");
            els.progress.classList.add("hidden");
            els.result.classList.remove("hidden");
        } catch (err) {
            console.error(err);
            els.progress.classList.add("hidden");
            els.fileGroups.classList.remove("hidden");
            els.uploader.classList.remove("hidden");
            els.langPicker.classList.remove("hidden");
            els.actionBar.classList.remove("hidden");
            showError("Gagal menerjemahkan PDF: " + (err && err.message ? err.message : err));
        }
    }

    function snapshotText(blocks, label) {
        const lines = [];
        for (const b of blocks) {
            if (b.kind === "figure") {
                lines.push("[FIGURE]");
                continue;
            }
            if (b.type === "table" && b.rows) {
                lines.push("[TABLE]");
                for (const r of b.rows) lines.push("  | " + r.join(" | "));
                continue;
            }
            const tag = b.type ? `[${b.type}] ` : "";
            const t = (b.text || "").trim();
            if (t) lines.push(tag + t);
        }
        return `=== ${label} ===\n` + lines.join("\n");
    }

    els.btnTranslate.addEventListener("click", run);

    /* ----- result actions ----- */
    els.btnDownload.addEventListener("click", async () => {
        if (!state.lastResult) return;
        try {
            await exportToPdf(state.lastResult.htmlString, state.lastResult.filename);
        } catch (e) {
            showError("Gagal membuka dialog cetak: " + (e && e.message ? e.message : e));
        }
    });
    els.btnPreview.addEventListener("click", () => {
        if (!state.lastResult) return;
        // Open the rendered HTML in a new tab so the user can verify visually
        openHtmlPreview(state.lastResult.htmlString);
    });
    els.btnRestart.addEventListener("click", () => {
        state.files = [];
        state.lastResult = null;
        renderFileList();
        els.preview.classList.add("hidden");
        els.result.classList.add("hidden");
        els.fileGroups.classList.remove("hidden");
        els.uploader.classList.remove("hidden");
        els.langPicker.classList.remove("hidden");
        setProgress(0, "");
    });
})();
