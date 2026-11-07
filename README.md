# Manga Reader — PWA offline

Pembaca manga/manhwa yang jalan **sepenuhnya di HP**. Tidak ada server, tidak ada
login, tidak ada tracking. Semua file dan progres tersimpan lokal di perangkat
(IndexedDB). Aplikasi hanya membuka file yang kamu impor sendiri.

## Isi folder

```
index.html          struktur UI (library + reader + drawer + modal)
style.css           tema gelap, mobile-first, target tap 48px
app.js              IndexedDB, impor CBZ/gambar, library, pengaturan
reader.js           mesin baca: webtoon & paged, zoom, lazy-load, progres
sw.js               service worker — cache app shell untuk offline
manifest.json       metadata PWA (install ke home screen)
vendor/jszip.min.js JSZip 3.10.1 (lokal, bukan CDN — wajib untuk offline)
icons/              ikon 192 & 512
```

## Fitur

- **Impor** `.cbz` / `.zip` atau banyak gambar (jpg/png/webp/gif/avif).
  Urutan halaman natural: 1, 2, 10 — bukan 1, 10, 2. File `__MACOSX/` diabaikan.
- **Library** grid cover, judul, jumlah chapter, progres %. Rename / hapus per seri.
  Chapter dengan judul seri sama otomatis digabung.
- **Webtoon mode** — scroll vertikal tanpa jeda, lebar gambar bisa diatur 60–100%.
- **Paged mode** — satu halaman per layar, tap kiri/kanan, mendukung arah
  kanan→kiri untuk manga.
- **Zoom** pinch-to-zoom (sampai 5×) dan double-tap zoom (2.2×).
- **Fit** width / height / original.
- **Progres otomatis** — seri, chapter, dan halaman terakhir. Lanjut dari terakhir dibaca.
- **Next/previous chapter** + daftar chapter di drawer.
- **Toolbar** muncul/hilang dengan tap tengah layar.
- **Performa** lazy-load via IntersectionObserver; blob URL di-revoke saat keluar
  viewport supaya memori tetap datar di chapter 100+ halaman.

## Cara menjalankan di HP

PWA butuh HTTPS atau `localhost`. Pilih salah satu.

### Opsi 1 — GitHub Pages (sekali upload, lalu offline selamanya)

Paling praktis: buka sekali lewat internet, setelah itu jalan offline.

```bash
cd mangaread
git init
git add .
git commit -m "Manga Reader PWA"
git branch -M main
git remote add origin https://github.com/<USERNAME>/mangaread.git
git push -u origin main
```

Lalu di GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.

Tunggu 1–2 menit, buka di HP:
```
https://<USERNAME>.github.io/mangaread/
```

Di Chrome Android: menu **⋮ → Add to Home screen**. Setelah itu buka dari ikon —
sudah offline, tidak perlu internet lagi.

**Catatan privasi:** repo publik berarti kode-nya publik, tapi **file komikmu tidak
pernah diunggah** — semua impor tetap lokal di HP.

### Opsi 2 — Termux (server lokal di HP, tanpa internet)

```bash
pkg update && pkg install python -y
cd ~/storage/downloads/mangaread
python -m http.server 8080
```

Buka di browser HP: `http://localhost:8080`

`localhost` dianggap aman oleh browser, jadi service worker tetap aktif dan PWA
bisa di-install. Tambahkan ke home screen seperti biasa.

### Opsi 3 — dari PC lewat Wi-Fi yang sama

Di PC:
```bash
cd mangaread
python -m http.server 8000
```

Cari IP PC:
```bash
# Windows
ipconfig
# Linux/macOS
ip addr | grep "inet "
```

Di HP buka: `http://<IP-PC>:8000`

**Penting:** lewat `http://` + IP, service worker **tidak aktif** (bukan secure
context), jadi app tetap jalan tapi tanpa cache offline. Untuk PWA penuh, pakai
Opsi 1 atau 2.

## Cara pakai

1. Tekan **＋** → **Pilih file .cbz/.zip** atau **Pilih gambar**.
2. Isi **Judul seri** (kalau sama, chapter otomatis digabung) dan **Nama chapter**.
3. Tunggu toast "Berhasil diimpor" → muncul di library.
4. Tap kartu untuk membaca.
5. Di reader: tap **tengah** layar untuk sembunyikan/munculkan toolbar.
   - Webtoon: scroll biasa.
   - Paged: tap **kiri/kanan** untuk pindah halaman.
6. **☰** untuk daftar chapter, **←** untuk kembali ke library.
7. **⚙** untuk ganti mode baca, arah baca, fit, dan lebar webtoon.

## Batasan

- Tidak ada scraping / pengambilan konten dari situs lain.
- Tanpa login, tanpa backend, tanpa tracking.
- Impor file besar (CBZ > 500 MB) bisa lambat di HP kelas bawah — prosesnya
  bertahap per halaman, jadi tidak langsung kehabisan memori.
- Data hilang kalau site data dibersihkan dari browser. Tidak ada cloud backup.
