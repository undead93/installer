# TikTok HD Bot (WhatsApp)

Bot WhatsApp yang menukar video kepada format "TikTok HD": hasilnya sama seperti fail yang keluar dari servis berbayar
*Haze Quality Method (Haze Max)*. Kaedahnya dicungkil daripada perbandingan bait demi bait antara
fail asal iPhone (`IMG_1880.MOV`) dan fail selepas Haze (`IMG_1880_haze.mp4`).

---

## 1. Apa beza fail asal dengan fail Haze

| | Asal (`IMG_1880.MOV`) | Selepas Haze Max |
|---|---|---|
| Peranti | iPhone 18 Pro Max, iOS 27.0.1 | (maklumat peranti dibuang) |
| Codec video | HEVC (H.265) Main10, **10-bit** | **H.264 High, 8-bit**, Level 5.1 |
| Warna | **HDR HLG + Dolby Vision 8.4** (BT.2020) | **SDR BT.709** (sudah di-tonemap) |
| Resolusi | 3840x2160 | 3840x2160 (kekal 4K) |
| FPS | **120** | **30** (ambil 1 daripada setiap 4 frame) |
| Bitrate video | **123 Mbps** | **~11 Mbps** |
| Saiz (5.2 s) | 77.3 MB | 7.4 MB |
| GOP | – | 1 saat (30 frame), tertutup, `IBBBP…PP`, 3 B-frame piramid |
| Encoder | kamera iPhone | Apple VideoToolbox (SEI UUID Apple + susun atur AVFoundation) — Haze berjalan atas peranti Apple |
| Audio AAC | 248 paket | **sama bait demi bait** + **17 frame senyap** (0.36 s) dalam `mdat` kedua |
| Trek AAC kedua | – | **salinan** trek AAC (kongsi data yang sama) |
| Spatial Audio (APAC 4ch) | ada | dikekalkan, dipotong ikut hujung video |
| 6 trek metadata kamera (`mebx`) | ada | **dikekalkan bait demi bait** (orientasi, muka, live-photo, cahaya, dll.) |
| GPS, model, tarikh | ada | **dibuang** (masa `mvhd` = 0) |
| Bekas | QuickTime `qt  `, `moov` di hujung | sama — susun atur AVFoundation/iPhone, handler "Core Media" |
| Tag | – | `©too` = "Haze Quality Method … Haze Max" |

**Ringkasnya:** Haze tidak "menambah HD". Ia mengambil rakaman iPhone yang terlalu "berat" untuk TikTok
(HDR + 120fps + 10-bit + 123 Mbps), menukarnya kepada fail SDR 4K 30fps H.264 ~11 Mbps, tetapi
**mengekalkan rupa fail itu sebagai rakaman kamera iPhone asli** (bekas QuickTime, trek metadata kamera,
spatial audio, susun atur AVFoundation), dan membuang data peribadi.

### Kenapa itu jadi HD di TikTok

Aplikasi TikTok memampat semula (di telefon) video yang "luar biasa" — HDR, fps tinggi, 10-bit, bitrate
sangat tinggi — sebelum upload, kemudian pelayan TikTok mampat sekali lagi. Dua kali mampat = kabur.
Fail yang sudah dalam bentuk yang TikTok suka (SDR, 30fps, H.264, bitrate sederhana, rupa rakaman iPhone)
boleh dihantar terus dengan pilihan *Upload HD*, jadi pelayan TikTok encode daripada sumber 4K yang bersih.

> Peraturan dalaman TikTok tidak didedahkan. Penjelasan di atas disimpulkan daripada perbezaan fail.
> Sebab itu bot ini meniru **setiap** ciri yang boleh diperhatikan, dan setiap ciri boleh dimatikan
> (`--no-pad`, `--no-dup-audio`, `--no-apple-tracks`) kalau anda mahu uji A/B sendiri.

---

## 2. Apa bot ini buat

1. **Analisis** — ffprobe + parser MOV sendiri (baca trek `mebx`, APAC, kunci `com.apple.quicktime.*`).
2. **Tonemap HDR → SDR** — `zscale` (linear, putih rujukan 203 nit) → BT.709 → lengkung Hable → BT.709.
   Ditala dengan grid search terhadap frame Haze: **~36 dB PSNR** berbanding penukaran Apple sendiri.
3. **30fps** — sama seperti Haze (1 daripada 4 frame untuk sumber 120fps). Tidak pernah gandakan frame.
4. **Encode x264** — High@5.1, GOP 1 s tertutup, 3 B-frame piramid, 4 ref, CRF 17 dihadkan ~11 Mbps (4K).
   Banner SEI x264 dibuang — tiada jejak "x264"/"Lavf" dalam fail.
5. **Remux gaya iPhone** (muxer JavaScript sendiri, `src/engine/mux.js`):
   AAC asal disalin bit-exact + 17 frame senyap dalam `mdat` kedua, APAC & 6 trek `mebx` disalin,
   rujukan trek (`fall`, `cdsc`, `cdep`, `rndr`) dipeta semula, trek AAC pendua, `tapt`, `cslg`, `sdtp`,
   `colr nclc`, `amve`, timescale 600, handler "Core Media", `moov` di hujung, GPS/model/tarikh dibuang.
6. **Semak** — output dibaca semula dengan ffprobe sebelum dihantar.

### Keputusan sebenar pada `IMG_1880.MOV`

```
$ node src/cli.js compare IMG_1880_haze.mp4 IMG_1880_hd.mp4
Haze : #1 mp4a n=265 md5=50aa5e6139e2 | #2 apac n=246 md5=39c36b9f8dd1 | #3 avc1 | #4–#9 mebx | #10 mp4a md5=50aa5e6139e2
Bot  : #1 mp4a n=265 md5=50aa5e6139e2 | #2 apac n=246 md5=39c36b9f8dd1 | #3 avc1 | #4–#9 mebx | #10 mp4a md5=50aa5e6139e2
```

Semua trek selain video **identik bait demi bait** dengan fail Haze (termasuk 17 frame senyap), susunan
`ftyp wide mdat mdat moov` sama, tempoh sama (5.609 s), corak GOP sama. Beza yang disengajakan:
trek video (x264, bukan encoder Apple), tag encoder sendiri, dan entri sampel AAC kedua tidak menyalin
konfigurasi "cap jari" Haze.

---

## 3. Pemasangan

Perlu: **Node.js 20+** dan **ffmpeg** yang ada `libx264` dan `zscale` (zimg). Semak:

```bash
ffmpeg -hide_banner -encoders | grep libx264
ffmpeg -hide_banner -filters  | grep zscale     # wajib untuk video HDR iPhone
```

### VPS Ubuntu / Debian

```bash
sudo apt update && sudo apt install -y ffmpeg git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone -b claude/sharp-ritchie-kfqutr https://github.com/undead93/installer.git
cd installer/tiktok-hd-bot
npm install
cp .env.example .env        # isi BOT_NUMBER untuk kod pairing (atau biar kosong untuk QR)
npm start
```

Jalan 24/7 dengan pm2: `sudo npm i -g pm2 && pm2 start src/bot/index.js --name tiktok-hd && pm2 save`

### Termux (Android)

```bash
pkg update && pkg install -y nodejs-lts ffmpeg git
git clone -b claude/sharp-ritchie-kfqutr https://github.com/undead93/installer.git
cd installer/tiktok-hd-bot && npm install && cp .env.example .env && npm start
```

Encode 4K pada telefon perlahan — guna `DEFAULT_MODE=hd` dan `X264_PRESET=faster`.

### Panel bot (Pterodactyl dsb.)

Muat naik folder ini, arahan mula `npm start`. Pastikan imej panel ada ffmpeg (atau letak ffmpeg
statik dan isi `FFMPEG_PATH` / `FFPROBE_PATH` dalam `.env`).

### Log masuk WhatsApp

- **QR**: biar `BOT_NUMBER` kosong → imbas QR di terminal (WhatsApp → Peranti dipaut → Paut peranti).
- **Kod pairing**: `BOT_NUMBER=60123456789` → kod 8 aksara dipaparkan → WhatsApp → Peranti dipaut →
  Paut peranti → *Paut dengan nombor telefon*.

Gunakan nombor berasingan untuk bot. Baileys ialah klien WhatsApp tidak rasmi; spam boleh menyebabkan
nombor disekat.

---

## 4. Cara guna

Secara lalai bot **layan dalam group sahaja** (`REPLY_IN=group`). Masukkan nombor bot ke dalam group,
kemudian ahli group hantar video **sebagai DOKUMEN** (📎 → Dokumen → pilih video):

```
Ahli  ── 📎 Dokumen: IMG_1880.MOV ─────────────────────────────▶  Group
Bot   ── "⬇️ Memuat turun..." → "⚙️ Encode video ████░░ 40%"     (satu mesej, dikemas kini)
Bot   ── 📄 Dokumen: IMG_1880_hd.mp4, quote + @tag pengirim ─────▶  Group
```

Tak perlu taip apa-apa — hantar dokumen sahaja sudah cukup (mod `max`). Dalam group, bot senyap
untuk sembang biasa, video biasa dan fail bukan video; ia hanya bertindak pada dokumen video dan arahan.

| Tetapan `.env` | Kesan |
|---|---|
| `REPLY_IN=group` | group sahaja (lalai) — chat peribadi diabaikan |
| `REPLY_IN=private` | chat peribadi sahaja |
| `REPLY_IN=all` | kedua-duanya |
| `GROUP_IDS=...@g.us` | hadkan kepada group tertentu (hantar `.id` dalam group untuk dapat ID) |
| `ALLOW_SELF=true` | kalau bot guna nombor anda sendiri: hantar dokumen dengan kapsyen `.max` dari telefon itu |

| Arahan | Fungsi |
|---|---|
| (hantar dokumen sahaja) | proses dengan mod lalai (`max`) |
| `.max` | 4K 2160p 30fps |
| `.hd` | 1080p 30fps (lebih laju) |
| `.keep` | kekal resolusi asal |
| `.max 60` | benarkan 60fps |
| `.info` | semak video sedia TikTok HD atau tidak (macam "checker" Haze) |
| `.status` | barisan giliran |
| `.id` | tunjuk ID group (untuk `GROUP_IDS`) |
| `.menu` | bantuan |

Arahan boleh ditulis pada kapsyen dokumen, atau *reply* video/dokumen dengan arahan
(contoh: reply video biasa dalam group dengan `.max` untuk tetap proses).
Bot pulangkan fail sebagai dokumen (supaya WhatsApp tidak mampat semula), dengan langkah upload:

1. Buka dokumen → Kongsi → **Simpan Video** (masuk galeri).
2. TikTok → **+** → pilih dari galeri.
3. Sebelum post: **Lagi pilihan** → hidupkan **Upload HD / kualiti tinggi**.
4. Jangan tambah filter/teks dalam editor TikTok — itu memaksa TikTok encode semula.

### CLI (tanpa WhatsApp)

```bash
node src/cli.js info IMG_1880.MOV                 # analisis + status TikTok HD
node src/cli.js IMG_1880.MOV -o out.mp4           # proses (mod max)
node src/cli.js IMG_1880.MOV --mode hd --fps 60   # 1080p 60fps
node src/cli.js compare IMG_1880_haze.mp4 out.mp4 # banding trek demi trek
```

### Tetapan `.env`

Lihat `.env.example`. Yang penting: `BOT_NUMBER`, `REPLY_IN`, `GROUP_IDS`, `ALLOWED_NUMBERS`
(hadkan pengguna), `DEFAULT_MODE`, `X264_PRESET`, `MAX_FILE_MB`, `MAX_DURATION_SEC`, `ENCODER_TAG`.

---

## 5. Kelajuan

Pada VPS 4 teras: klip iPhone 4K120 HDR 5 saat ≈ 40 s (separuh masa untuk *decode* HEVC 120fps).
Video 60 saat ≈ 7–8 minit dalam mod `max`. Mod `hd` dan `X264_PRESET=faster` jauh lebih laju.
Bot memproses satu video pada satu masa (`CONCURRENCY`), seorang pengguna satu giliran.

## 6. Struktur kod

```
src/engine/mp4.js       parser MP4/MOV (baca moov sahaja, data kekal di cakera)
src/engine/writer.js    penulis QuickTime gaya AVFoundation
src/engine/mux.js       susun trek seperti fail Haze/iPhone
src/engine/aac.js       esds / AudioSpecificConfig / frame AAC senyap
src/engine/pipeline.js  analisis → ffmpeg/x264 → mux → semak
src/engine/analyze.js   laporan & semakan "TikTok HD"
src/bot/index.js        sambungan WhatsApp (Baileys v7), log masuk QR / kod pairing
src/bot/router.js       logik mesej: dokumen masuk → giliran → proses → dokumen keluar
src/bot/deps.js         muat turun/nyahsulit media, enjin (proses anak), analisis
test/                   ujian (npm test)
```

### Ujian

```bash
npm test
```

Termasuk ujian hujung-ke-hujung `test/whatsapp-e2e.test.js`: video dienkrip sebagai dokumen WhatsApp
sebenar (kod enkripsi Baileys), bot memuat turun & menyahsulit dengan `downloadMediaMessage`, convert,
membina dokumen balasan dengan `generateWAMessageContent`, kemudian balasan dinyahsulit dan disemak.
Hanya soket WhatsApp yang palsu. Uji dengan video anda sendiri:

```bash
E2E_INPUT=/path/IMG_1880.MOV E2E_KEEP=/path/hasil.mp4 node --test test/whatsapp-e2e.test.js
```

Projek ini tiada kaitan dengan Haze. Ia tidak menyalin kod Haze — hanya meniru format fail output
yang boleh diperhatikan oleh sesiapa yang ada fail tersebut.
