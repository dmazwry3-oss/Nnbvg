/* ===================================================================
   server/render.mjs
   Optional production-grade PDF renderer.

   The browser-side print-to-PDF path works for most documents, but for
   automated, server-driven, or batch workflows you want a headless
   browser that produces the PDF without showing any dialog.

   This server:
     - Serves the static client (index.html, assets/...) on /
     - Exposes POST /render { html, filename } → application/pdf

   The client can replace the call to exportToPdf() with a fetch:
     const r = await fetch("/render", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ html: htmlString, filename: outName }),
     });
     const blob = await r.blob();
     // trigger download

   Run:
     npm install
     npm start
     open http://localhost:3000
   =================================================================== */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(ROOT));

let browserPromise;
async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
    }
    return browserPromise;
}

app.post("/render", async (req, res) => {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== "string") {
        return res.status(400).json({ error: "html (string) required" });
    }
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: ["load", "domcontentloaded", "networkidle0"] });
        await page.emulateMediaType("print");
        const pdf = await page.pdf({
            format: "A4",
            margin: { top: "22mm", bottom: "22mm", left: "18mm", right: "18mm" },
            printBackground: true,
            preferCSSPageSize: true,
        });
        const safeName = (filename || "document.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${safeName}"`,
            "Content-Length": pdf.length,
        });
        res.send(pdf);
    } catch (err) {
        console.error("[render] failed:", err);
        res.status(500).json({ error: err.message || String(err) });
    } finally {
        if (page) await page.close().catch(() => {});
    }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`PDF Translate server: http://localhost:${PORT}`);
    console.log(`POST /render  to convert HTML → A4 PDF (vector, headless Chromium)`);
});

// Tidy shutdown
process.on("SIGINT", async () => {
    if (browserPromise) {
        const b = await browserPromise;
        await b.close();
    }
    process.exit(0);
});
