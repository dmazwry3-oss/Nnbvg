# PDF Translate

Web app penerjemah PDF dengan pipeline **block-aware**: bukan sekadar mengambil teks mentah lalu menempelnya ke PDF baru. Sistem mendeteksi struktur dokumen (judul, penulis, abstrak, heading, paragraf, tabel, figure, caption, referensi), membersihkan header/footer berulang, lalu menyusun ulang menjadi HTML A4 yang dicetak ke PDF vektor.

## Pipeline

```
Upload PDF
  → extractDocument()       (PDF.js, posisi+font+kolom → blok terstruktur)
  → classifyDocument()      (judul, penulis, abstrak, heading, tabel, refs, …)
  → cleanBlocks()           (dehyphenate, dedup header/footer, strip page #)
  → translateBlocks()       (per blok, batched, fallback MyMemory)
  → buildHtmlDocument()     (HTML semantik + print.css A4)
  → exportToPdf()           (browser print → PDF vektor, teks bisa diseleksi)
```

Renderer `html2canvas + jsPDF` lama **dihapus** karena merasterisasi seluruh halaman menjadi gambar (mengakibatkan teks dempet, baris terpotong, file besar, font CJK/Arab buram).

## Modul

| File | Tanggung jawab |
|------|---|
| `assets/js/extractor.js` | Block extraction dari PDF.js: deteksi kolom (1 vs 2), grouping line→block via gap analysis, ekstraksi figure dengan render-and-crop |
| `assets/js/cleaner.js`   | Dehyphenation lintas baris, normalisasi whitespace, dedup header/footer cross-page, hapus page number |
| `assets/js/classifier.js`| Beri label semantik per blok: title / authors / abstract / heading / paragraph / table / caption / figure / reference |
| `assets/js/translator.js`| Translate per blok (paragraf utuh, tiap sel tabel) dengan batching sentinel `Z9Z9SEP`. Google gtx → MyMemory fallback |
| `assets/js/renderer.js`  | Bangun HTML semantik + cetak ke PDF via iframe `window.print()` |
| `assets/css/print.css`   | Stylesheet A4 (`@page`), aturan `page-break-inside: avoid` untuk tabel/figure |
| `server/render.mjs`      | **Opsional**: renderer Puppeteer untuk produksi (PDF vektor tanpa dialog cetak) |

## Cara pakai (lokal, client-only)

PDF.js worker dimuat dari CDN dan butuh konteks `http://`/`https://`. Jalankan static server:

```bash
python3 -m http.server 8080
# atau
npx serve .
```

Buka `http://localhost:8080`, upload PDF, klik **Terjemahkan**. Setelah selesai, klik **Unduh PDF terjemahan** dan pilih **"Save as PDF"** di dialog cetak browser.

## Cara pakai (mode produksi, Puppeteer)

Untuk menghindari dialog cetak (cocok untuk batch / server-side):

```bash
cd server
npm install
npm start
# Server jalan di http://localhost:3000 (sekaligus melayani static client)
```

Lalu di `assets/js/app.js`, ganti panggilan `exportToPdf(...)` dengan:

```js
const r = await fetch("/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: state.lastResult.htmlString, filename: state.lastResult.filename }),
});
const blob = await r.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url; a.download = state.lastResult.filename;
document.body.appendChild(a); a.click(); a.remove();
```

## Deploy

- **Client-only** (print-to-PDF): static hosting cukup — GitHub Pages, Netlify, Vercel, Cloudflare Pages.
- **Dengan Puppeteer**: butuh runtime Node yang bisa menjalankan Chromium (Render, Fly.io, Railway, atau VM sendiri). Bukan static-host.

## Catatan / batasan

- Ekstraksi figure adalah heuristik: hanya bekerja jika ada caption "Figure N", "Tabel N", "Gambar N", dst. Tanpa caption, gambar tidak diambil.
- Deteksi tabel adalah heuristik berbasis lebar gap antar-kolom; tabel kompleks (merged cells, multi-row header) bisa lolos sebagai paragraf — fallback ke layout "clean readable".
- Untuk PDF hasil scan tanpa text layer, perlu OCR (mis. `tesseract.js`) sebelum extractor — di luar scope versi ini.
- Endpoint Google `translate_a/single` tidak punya SLA dan bisa di-rate-limit; fallback ke MyMemory aktif otomatis. Untuk produksi, gunakan API berbayar (Google Cloud Translate, DeepL, Azure Translator).

## Rekomendasi library produksi

| Tugas | Pilihan |
|-------|---------|
| Ekstraksi PDF dengan layout | **PDF.js** (browser) atau **pdfplumber / pdfminer.six** (Python server) |
| Deteksi struktur dokumen lanjutan | **GROBID**, **LayoutParser**, **Adobe PDF Extract API** |
| Tabel kompleks | **Camelot**, **Tabula**, **pdfplumber.extract_tables()** |
| OCR (PDF scan) | **Tesseract.js** (browser), **PaddleOCR** atau **Google Document AI** (server) |
| Terjemahan | **DeepL API**, **Google Cloud Translation v3**, **Azure Translator** |
| Renderer PDF | **Puppeteer** atau **Playwright** (`page.pdf({format: "A4"})`); WeasyPrint untuk Python-only |
