# PDF Translate

Web app penerjemah PDF gratis, **100% client-side** (file tidak diupload ke server kami). UI terinspirasi dari iLovePDF.

## Fitur

- Drag & drop atau pilih file PDF
- Deteksi bahasa otomatis + 18+ bahasa target (Indonesia, Inggris, Mandarin, Jepang, Arab, dll.)
- Ekstraksi teks pakai [PDF.js](https://mozilla.github.io/pdf.js/)
- Terjemahan via Google Translate public endpoint, dengan fallback ke [MyMemory](https://mymemory.translated.net/)
- Generate PDF hasil pakai [jsPDF](https://github.com/parallax/jsPDF) + [html2canvas](https://html2canvas.hertzen.com/) (Unicode aman, termasuk skrip non-Latin)
- Pratinjau side-by-side teks asli vs terjemahan

## Cara pakai (lokal)

Karena PDF.js worker dimuat dari CDN dan butuh konteks `http://`/`https://` (bukan `file://`), jalankan static server:

```bash
# pakai Python
python3 -m http.server 8080

# atau pakai Node
npx serve .
```

Buka `http://localhost:8080`.

## Deploy

Cukup upload semua file ke static hosting apapun:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages

Tidak perlu backend.

## Struktur

```
.
├── index.html
├── assets/
│   ├── css/styles.css
│   └── js/app.js
└── README.md
```

## Catatan / batasan

- Layout grafis kompleks (kolom, gambar dengan teks tertanam) tidak dipertahankan persis. Output adalah PDF baru dengan layout standar per halaman.
- Endpoint Google Translate publik (`translate.googleapis.com/translate_a/single`) tidak dijamin SLA dan bisa di-rate-limit. Jika gagal, otomatis fallback ke MyMemory.
- Untuk PDF berupa hasil scan (tidak punya text layer), perlu OCR terlebih dulu.
