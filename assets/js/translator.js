/* ===================================================================
   translator.js
   Per-block translation that PRESERVES document structure.

   Strategy:
     - Collect every translatable string (paragraph text, heading, caption,
       reference, AND each table cell).
     - Pack many short strings into a single Google call separated by a
       distinctive sentinel ("Z9Z9SEP"), surrounded by blank lines so the
       translator treats them as separate segments.
     - On split-count mismatch, fall back to per-task translation.
     - On Google failure, fall back to MyMemory (smaller chunks).

   This avoids the original bug of translating "the whole page as one
   blob" which destroyed paragraph and table boundaries.
   =================================================================== */

const SEP_TOKEN = "Z9Z9SEP";
const SEP = "\n\n" + SEP_TOKEN + "\n\n";
const SPLIT_RE = /\s*\n+\s*Z9Z9SEP\s*\n+\s*/;
const GOOGLE_LIMIT = 4500;
const MYMEM_LIMIT = 480;

export async function translateBlocks(blocks, sl, tl, onProgress) {
    if (sl === tl && sl !== "auto") {
        if (onProgress) onProgress(1);
        return blocks;
    }

    // Build the task list. Each task knows where to write the translation back.
    const tasks = [];
    for (const b of blocks) {
        if (b.kind === "figure") continue;
        if (b.type === "table" && b.rows) {
            for (let r = 0; r < b.rows.length; r++) {
                for (let c = 0; c < b.rows[r].length; c++) {
                    const txt = b.rows[r][c];
                    if (txt && txt.trim()) {
                        tasks.push({ block: b, row: r, col: c, text: txt });
                    }
                }
            }
        } else if (b.text && b.text.trim()) {
            tasks.push({ block: b, text: b.text });
        }
    }
    if (tasks.length === 0) {
        if (onProgress) onProgress(1);
        return blocks;
    }

    // Pack into batches under GOOGLE_LIMIT
    const batches = [];
    let cur = [];
    let curLen = 0;
    for (const t of tasks) {
        const len = t.text.length;
        if (len > GOOGLE_LIMIT) {
            // Will be split internally
            if (cur.length) {
                batches.push(cur);
                cur = [];
                curLen = 0;
            }
            batches.push([t]);
            continue;
        }
        if (curLen + len + SEP.length > GOOGLE_LIMIT && cur.length) {
            batches.push(cur);
            cur = [];
            curLen = 0;
        }
        cur.push(t);
        curLen += len + SEP.length;
    }
    if (cur.length) batches.push(cur);

    let done = 0;
    for (const batch of batches) {
        if (batch.length === 1 && batch[0].text.length > GOOGLE_LIMIT) {
            const t = batch[0];
            const translated = await translateLong(t.text, sl, tl);
            writeBack(t, translated);
        } else {
            await translateBatch(batch, sl, tl);
        }
        done += batch.length;
        if (onProgress) onProgress(done / tasks.length);
    }

    return blocks;
}

async function translateBatch(batch, sl, tl) {
    const joined = batch.map((t) => t.text).join(SEP);
    let translated;
    try {
        translated = await translateGoogle(joined, sl, tl);
    } catch (e) {
        // Google failed for the whole batch – translate each task individually
        // via MyMemory fallback below.
        translated = null;
    }

    if (translated != null) {
        const parts = translated.split(SPLIT_RE);
        if (parts.length === batch.length) {
            for (let i = 0; i < batch.length; i++) writeBack(batch[i], parts[i].trim());
            return;
        }
        // Sentinel got mangled – fall through to per-task translation
    }

    for (const t of batch) {
        let out;
        try {
            out = await translateGoogle(t.text, sl, tl);
        } catch (e) {
            out = await translateMyMemoryChunked(t.text, sl, tl);
        }
        writeBack(t, out);
    }
}

async function translateLong(text, sl, tl) {
    // Split a very long string by paragraph/sentence under GOOGLE_LIMIT
    const out = [];
    const paragraphs = text.split(/\n+/);
    let buf = "";
    for (const p of paragraphs) {
        if ((buf + "\n" + p).length > GOOGLE_LIMIT) {
            if (buf) {
                out.push(await safeTranslate(buf, sl, tl));
                buf = "";
            }
            if (p.length > GOOGLE_LIMIT) {
                const sentences = p.split(/(?<=[.!?。！？])\s+/);
                let sb = "";
                for (const s of sentences) {
                    if ((sb + " " + s).length > GOOGLE_LIMIT) {
                        if (sb) {
                            out.push(await safeTranslate(sb, sl, tl));
                            sb = "";
                        }
                        if (s.length > GOOGLE_LIMIT) {
                            for (let i = 0; i < s.length; i += GOOGLE_LIMIT)
                                out.push(await safeTranslate(s.slice(i, i + GOOGLE_LIMIT), sl, tl));
                        } else {
                            sb = s;
                        }
                    } else {
                        sb = sb ? sb + " " + s : s;
                    }
                }
                if (sb) out.push(await safeTranslate(sb, sl, tl));
            } else {
                buf = p;
            }
        } else {
            buf = buf ? buf + "\n" + p : p;
        }
    }
    if (buf) out.push(await safeTranslate(buf, sl, tl));
    return out.join("\n");
}

async function safeTranslate(text, sl, tl) {
    try {
        return await translateGoogle(text, sl, tl);
    } catch {
        return await translateMyMemoryChunked(text, sl, tl);
    }
}

function writeBack(task, translated) {
    if (task.row !== undefined) {
        task.block.rows[task.row][task.col] = translated;
    } else {
        task.block.text = translated;
        // Also resync lines so renderers reading b.lines stay consistent
        if (Array.isArray(task.block.lines)) task.block.lines = [translated];
    }
}

/* ----------- Providers ----------- */
async function translateGoogle(text, sl, tl) {
    const url =
        "https://translate.googleapis.com/translate_a/single" +
        "?client=gtx" +
        "&sl=" + encodeURIComponent(sl) +
        "&tl=" + encodeURIComponent(tl) +
        "&dt=t&q=" + encodeURIComponent(text);
    const r = await fetch(url);
    if (!r.ok) throw new Error("Google HTTP " + r.status);
    const data = await r.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Bad Google response");
    return data[0].map((seg) => seg[0]).join("");
}

async function translateMyMemoryChunked(text, sl, tl) {
    if (text.length <= MYMEM_LIMIT) return translateMyMemory(text, sl, tl);
    const parts = [];
    const sentences = text.split(/(?<=[.!?。！？])\s+/);
    let buf = "";
    for (const s of sentences) {
        if ((buf + " " + s).length > MYMEM_LIMIT) {
            if (buf) {
                parts.push(await translateMyMemory(buf, sl, tl));
                buf = "";
            }
            if (s.length > MYMEM_LIMIT) {
                for (let i = 0; i < s.length; i += MYMEM_LIMIT)
                    parts.push(await translateMyMemory(s.slice(i, i + MYMEM_LIMIT), sl, tl));
            } else {
                buf = s;
            }
        } else {
            buf = buf ? buf + " " + s : s;
        }
    }
    if (buf) parts.push(await translateMyMemory(buf, sl, tl));
    return parts.join(" ");
}

async function translateMyMemory(text, sl, tl) {
    const srcParam = sl === "auto" ? "Autodetect" : sl;
    const url =
        "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(text) +
        "&langpair=" + encodeURIComponent(srcParam) + "|" + encodeURIComponent(tl);
    const r = await fetch(url);
    if (!r.ok) throw new Error("MyMemory HTTP " + r.status);
    const data = await r.json();
    if (!data.responseData || !data.responseData.translatedText)
        throw new Error("Bad MyMemory response");
    return data.responseData.translatedText;
}
