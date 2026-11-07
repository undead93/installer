# Bot WhatsApp → TikTok

Hantar video ke nombor WhatsApp bot sebagai **Document** dan tulis caption. Bot akan terus post video tu ke TikTok guna API rasmi TikTok (Content Posting API).

```
Anda (WhatsApp) ──📎 Document + caption──▶ Bot (VPS) ──API rasmi──▶ TikTok
```

**Kenapa Document?** WhatsApp tak compress fail yang dihantar sebagai Document, jadi video sampai ke TikTok dalam kualiti asal. Kalau hantar melalui Gallery, WhatsApp akan compress dulu.

**Kenapa 60fps?** TikTok maksimum 60fps. Kalau video anda 120fps, bot tukar automatik ke 60fps kualiti tinggi (guna ffmpeg) sebelum upload.

> ⚠️ **Baileys bukan API rasmi WhatsApp.** Ada risiko nombor kena ban. **Guna nombor kedua** untuk bot, jangan nombor utama.

---

## Apa yang anda perlukan

1. **VPS** dengan Ubuntu 22.04/24.04, RAM 1GB ke atas (2GB lebih selesa kalau selalu tukar 120fps).
2. **Nombor WhatsApp kedua** untuk bot (dalam telefon lain, atau WhatsApp Business dalam telefon yang sama).
3. **Akaun TikTok for Developers** (percuma).
4. **URL https** untuk redirect login TikTok. Cara paling senang ialah GitHub Pages percuma (`https://username.github.io/`).

---

## Langkah 1: Buat app TikTok

1. Pergi ke **developers.tiktok.com**, login dan buka **Manage apps**, kemudian **Connect an app**.
2. Isi maklumat app (nama, ikon, kategori, Terms of Service URL dan Privacy Policy URL; boleh guna page GitHub Pages anda).
3. Platform: pilih **Web**.
4. Tambah product:
   - **Login Kit**: masukkan **Redirect URI** anda, contoh `https://username.github.io/`
   - **Content Posting API**: hidupkan **Direct Post**
5. Scope yang perlu ada: `user.info.basic`, `video.publish` (dan `video.upload` kalau nak guna mod draft).
6. Salin **Client key** dan **Client secret**.
7. Sebelum app diluluskan, guna **Sandbox** dan tambah akaun TikTok anda sebagai *target user*.

### Tentang audit TikTok

- App yang **belum lulus audit** hanya boleh post sebagai **private (Only me)**, dan TikTok mungkin minta akaun anda ditetapkan private semasa ujian.
- Untuk post **public**, hantar app untuk audit di portal TikTok.
- Sementara menunggu audit, guna **mod draft** (`!mod draft`). Video masuk ke inbox TikTok, lepas tu anda buka app TikTok dan tekan Post sendiri dengan pilihan public.

---

## Langkah 2: Pasang di VPS

SSH ke VPS (dari telefon boleh guna app **Termius** atau **JuiceSSH**), kemudian:

```bash
# Node.js 20 + ffmpeg + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg git

# Ambil kod
git clone https://github.com/undead93/installer.git
cd installer/tiktok-wa-bot
npm install

# Setting
cp .env.example .env
nano .env
```

Isi dalam `.env`:

| Setting | Isi dengan |
|---|---|
| `ALLOWED_NUMBERS` | Nombor **utama** anda (yang akan hantar video), contoh `60123456789` |
| `WA_PAIRING_NUMBER` | Nombor **bot**, kalau tak nak scan QR (sesuai kalau guna telefon sahaja) |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | Dari app TikTok |
| `TIKTOK_REDIRECT_URI` | **Sama persis** dengan dalam app TikTok |
| `TIKTOK_PRIVACY` | `SELF_ONLY` dulu (sebelum audit) |

Simpan dalam nano: `Ctrl+O`, `Enter`, kemudian `Ctrl+X`.

---

## Langkah 3: Link WhatsApp bot

```bash
npm start
```

- **Kalau `WA_PAIRING_NUMBER` diisi:** terminal akan tunjuk `PAIRING CODE: XXXX-XXXX`. Dalam telefon **bot**, buka WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead**, kemudian masukkan kod tu.
- **Kalau guna QR:** scan QR dalam terminal guna WhatsApp telefon **bot**.

Bila keluar `✅ WhatsApp bersambung`, tekan `Ctrl+C` dan jalankan bot di background supaya hidup 24 jam:

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # ikut arahan yang dipaparkan, supaya bot hidup semula lepas VPS restart
```

Untuk tengok log: `pm2 logs tiktok-wa-bot`

---

## Langkah 4: Login TikTok (melalui WhatsApp)

Dari nombor utama anda, hantar mesej ke nombor bot:

1. Hantar `!login`. Bot balas dengan satu link.
2. Buka link tu, login TikTok dan tekan **Authorize**.
3. Browser akan pergi ke Redirect URI anda. Page tu kosong atau error pun tak apa. **Copy link penuh** dari address bar.
4. Hantar `!kod <link tadi>`.
5. Bot balas `✅ TikTok bersambung`.

Login ni tahan lebih kurang setahun. Bot refresh token sendiri secara automatik.

---

## Cara guna

📎 Dalam chat bot, tekan **Attach → Document**, pilih video, tulis caption (boleh letak #hashtag), dan hantar.

Bot akan balas setiap peringkat: muat turun, tukar fps (kalau perlu), upload, kemudian **✅ Dah post**.

| Arahan | Fungsi |
|---|---|
| `!bantuan` | Senarai arahan |
| `!login` / `!kod <link>` | Sambung akaun TikTok |
| `!status` | Status bot, akaun, privasi yang dibenarkan, durasi maksimum |
| `!mod direct` | Terus post dengan caption |
| `!mod draft` | Hantar ke inbox TikTok; anda tekan Post sendiri dalam app (bot hantar semula caption supaya senang copy) |
| `!privasi public \| friends \| followers \| private` | Tukar privasi post |
| `!logout` | Putuskan akaun TikTok |

---

## Tips kualiti

- Rakam pada **1080p 60fps**. Kalau rakam 120fps, bot tukar ke 60fps automatik.
- Kalau edit dalam CapCut, export **1080p, 60fps, bitrate tinggi**.
- **Selalu hantar sebagai Document**, bukan Gallery.
- Fail sampai ke TikTok dalam kualiti asal, tapi TikTok tetap akan proses semula video tu. Itu di luar kawalan bot.

---

## Masalah biasa

| Masalah | Penyelesaian |
|---|---|
| Bot tak balas langsung | Tengok `pm2 logs`. Kalau ada `🚫 Mesej daripada ... diabaikan`, masukkan nombor atau ID yang ditunjuk ke dalam `ALLOWED_NUMBERS`, kemudian `pm2 restart tiktok-wa-bot` |
| `unaudited_client...` | App belum lulus audit. Guna `!privasi private` atau `!mod draft` |
| `redirect_uri` error | `TIKTOK_REDIRECT_URI` mesti sama persis dengan dalam app TikTok (termasuk `/` di hujung) |
| `scope` error | Pastikan scope ada dalam app TikTok, kemudian `!login` semula |
| WhatsApp logged out | `rm -rf data/wa-auth`, kemudian `npm start` dan link semula |
| Tukar fps lambat | Tukar `FFMPEG_PRESET=medium` atau `fast` dalam `.env` |

---

## Struktur fail

```
src/index.js    – bot WhatsApp (Baileys), arahan & aliran upload
src/tiktok.js   – OAuth TikTok + Content Posting API (upload berchunk)
src/video.js    – ffprobe/ffmpeg: semak fps & tukar ke 60fps
src/config.js   – baca .env
src/store.js    – simpan token & setting dalam data/
```

> Nota: Endpoint dan had API ditulis berdasarkan dokumentasi TikTok Content Posting API (v2). Kalau TikTok ubah API, semak semula di developers.tiktok.com.
