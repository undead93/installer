# Bot WhatsApp → TikTok

Hantar video ke nombor WhatsApp bot sebagai **Document** dan tulis caption. Bot akan terus post video tu ke TikTok.

```
Anda (WhatsApp) ──📎 Document + caption──▶ Bot (VPS) ──▶ TikTok
```

Bot ada dua kaedah upload (tetapkan dengan `TIKTOK_METHOD` dalam `.env`):

| | **web** (default) | **api** |
|---|---|---|
| Cara | Bot buka tiktok.com guna browser automatik, sama macam upload guna Edge di PC | API rasmi TikTok |
| Perlu akaun developer? | ❌ Tak perlu | ✅ Perlu |
| Boleh terus public? | ✅ Ya | Hanya selepas app lulus audit TikTok |
| Risiko | Bukan cara rasmi: akaun boleh kena flag atau captcha, dan bot boleh rosak bila TikTok tukar design website | Selamat |

**Kenapa Document?** WhatsApp tak compress fail Document, jadi video sampai dalam kualiti asal.
**Kenapa 60fps?** TikTok maksimum 60fps. Video 120fps akan ditukar automatik ke 60fps kualiti tinggi.

> ⚠️ **Baileys bukan API rasmi WhatsApp**, jadi guna **nombor kedua** untuk bot.
> ⚠️ **Kaedah web bukan cara rasmi TikTok.** Kalau boleh, uji dulu dengan akaun TikTok yang anda tak kisah sangat.

---

## 1. Pasang di VPS (Ubuntu 22.04/24.04)

RAM disyorkan **2GB** ke atas, sebab browser + ffmpeg agak berat. Kalau VPS cuma 1GB, buat swap (langkah 1b).

SSH ke VPS (dari telefon boleh guna app **Termius**), kemudian:

```bash
# Node.js 20 + ffmpeg + git
sudo apt-get update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg git

# Ambil kod
cd ~
git clone -b claude/sweet-bohr-89rl7v https://github.com/undead93/installer.git
cd installer/tiktok-wa-bot
npm install

# Pasang browser Chromium + library yang diperlukan
npx playwright install --with-deps chromium
```

Kalau folder `installer` dah wujud dari cubaan sebelum ni:
```bash
cd ~/installer && git fetch origin claude/sweet-bohr-89rl7v && git checkout claude/sweet-bohr-89rl7v && git pull
cd tiktok-wa-bot && npm install && npx playwright install --with-deps chromium
```

### 1b. (Untuk VPS 1GB) Buat swap 2GB
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Setting

```bash
cp .env.example .env
nano .env
```

Yang wajib diisi:
```
ALLOWED_NUMBERS=60123456789      ← nombor UTAMA anda (yang hantar video)
WA_PAIRING_NUMBER=60198765432    ← nombor BOT (supaya tak perlu scan QR)
TIKTOK_METHOD=web
```
Simpan dalam nano: **Ctrl+O → Enter → Ctrl+X**.

## 3. Link WhatsApp bot

```bash
npm start
```
Tunggu sampai keluar `🔑 PAIRING CODE: XXXX-XXXX`. Dalam **telefon bot**, buka WhatsApp → **Linked devices** → **Link a device** → **Link with phone number instead**, kemudian masukkan kod tu.

Bila keluar `✅ WhatsApp bersambung`, tekan **Ctrl+C**, kemudian jalankan bot 24 jam:

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup      # copy & jalankan arahan yang dipaparkan
```

## 4. Login TikTok (ambil `sessionid`)

Bot login TikTok guna cookie **`sessionid`** dari browser yang dah login TikTok.

### Cara utama: Export SEMUA cookies (disyorkan)
TikTok kadang-kadang tak terima `sessionid` seorang diri, jadi lebih baik hantar semua cookies.
1. Di PC, install extension **Cookie-Editor** dalam Chrome atau Edge.
2. Buka **tiktok.com** (pastikan dah login), tekan ikon Cookie-Editor, kemudian **Export → JSON** (atau **Header String**). Ia akan disalin secara automatik.
3. Buka **WhatsApp Web/Desktop** di PC, dan dalam chat bot (atau "Message yourself") hantar:
   ```
   !cookies <paste di sini>
   ```
   Atau paste dalam Notepad, simpan sebagai `cookies.json`, dan hantar fail tu sebagai **Document** dengan caption `!cookies`.

### Cara A: sessionid sahaja dari PC/laptop
1. Buka **Chrome** atau **Edge** dan login di **tiktok.com**.
2. Tekan **F12**, pergi ke tab **Application** (dalam Edge: **Application** juga), kemudian **Cookies** → `https://www.tiktok.com`.
3. Cari baris **`sessionid`** dan copy **Value**.
4. Dari WhatsApp, hantar kepada bot:
   ```
   !sessionid nilai_yang_dicopy
   ```

### Cara B: Dari telefon Android
1. Install **Firefox** dari Play Store.
2. Dalam Firefox, buka **Menu → Add-ons**, cari **Cookie-Editor** dan install.
3. Buka **tiktok.com** dalam Firefox dan login.
4. Buka **Menu → Add-ons → Cookie-Editor**, cari **`sessionid`** dan copy nilainya.
5. Hantar `!sessionid nilai_tadi` kepada bot.
   - Atau dalam Cookie-Editor tekan **Export → JSON**, kemudian hantar `!cookies <paste JSON>`. Boleh juga simpan sebagai fail `.json` dan hantar sebagai Document dengan caption `!cookies`.

### Lepas tu
- Hantar **`!semak`**. Bot akan buka page upload TikTok dan hantar screenshot. Kalau nampak page upload, maknanya login berjaya ✅
- 🔒 **Padam mesej sessionid** dari chat (Delete for everyone). Ia macam password.
- ⚠️ **Jangan tekan Log out** dalam browser tempat anda ambil sessionid tu. Kalau log out, sessionid tu tak boleh guna lagi. Tutup browser sahaja.
- Sessionid akan tamat selepas beberapa minggu atau bulan. Bila bot cakap login tamat, ambil sessionid baru.

## Nombor WhatsApp dah ada bot lain?

Satu nombor WhatsApp boleh ada sampai **4 linked device**, jadi bot ni boleh berkongsi nombor dengan bot lain. Masalahnya, kedua-dua bot akan baca semua mesej. Ada tiga cara untuk selesaikan:

**Cara 1: Guna nombor lain untuk bot ni (paling bersih).**

**Cara 2: Mod "Message yourself" (`SELF_CHAT=true`). Tak perlu nombor kedua.**
- Link bot ni ke **nombor utama anda** (`WA_PAIRING_NUMBER` = nombor anda sendiri).
- Hantar video dan arahan dalam chat **"Message yourself"** (chat dengan diri sendiri).
- Bot hanya baca mesej dalam chat tu, jadi bot lain di nombor kedua tak terlibat langsung.
- ⚠️ Baileys ada risiko ban, dan kali ni risiko tu pada nombor utama anda.

**Cara 3: Kongsi nombor yang sama dengan bot lain.**
- `COMMAND_PREFIX=tt`: arahan bot ni jadi `tt semak`, `tt sessionid ...` dan tak bertembung dengan `!` bot lain.
- `VIDEO_TRIGGER=tt`: bot ni hanya proses video yang caption bermula dengan `tt`. Contohnya caption `tt Video best #fyp` akan dipost sebagai `Video best #fyp`.
- Bot lain mungkin masih balas mesej yang sama, sebab bot ni tak boleh kawal bot lain.

Lepas ubah `.env`, jalankan `pm2 restart tiktok-wa-bot`.

## 5. Cara guna

📎 Dalam chat bot, tekan **Attach → Document**, pilih video, tulis caption (boleh letak #hashtag dan baris baru), dan hantar.

Bot akan muat turun video, tukar fps kalau perlu, buka TikTok, upload, isi caption dan tekan Post, kemudian balas **✅ Dah post**. Kalau ada masalah, bot akan **hantar screenshot** page TikTok supaya anda nampak apa yang berlaku.

| Arahan | Fungsi |
|---|---|
| `!sessionid <nilai>` | Login TikTok |
| `!cookies <JSON>` | Login guna JSON dari Cookie-Editor |
| `!semak` | Uji login (bot hantar screenshot) |
| `!status` | Status bot |
| `!logout` | Padam login TikTok dari bot |
| `!bantuan` | Senarai arahan |

Privasi video ikut setting default akaun TikTok anda (biasanya **Everyone**).

---

## Arahan berguna di VPS

| Nak buat apa | Arahan |
|---|---|
| Tengok log | `pm2 logs tiktok-wa-bot` |
| Restart (lepas ubah `.env`) | `pm2 restart tiktok-wa-bot` |
| Update kod bot | `cd ~/installer && git pull && cd tiktok-wa-bot && npm install && npx playwright install chromium && pm2 restart tiktok-wa-bot` |
| Link semula WhatsApp | `pm2 stop tiktok-wa-bot && rm -rf data/wa-auth && npm start` |

## Masalah biasa

| Masalah | Penyelesaian |
|---|---|
| Bot tak balas | `pm2 logs tiktok-wa-bot`. Kalau ada `🚫 Mesej daripada ... diabaikan`, masukkan nombor/ID tu dalam `ALLOWED_NUMBERS`, kemudian restart |
| "Login TikTok dah tamat" | Ambil sessionid baru dan hantar `!sessionid` |
| "TikTok minta captcha" | Login TikTok dalam browser biasa, selesaikan captcha di sana, dan tunggu sekejap sebelum cuba lagi. Jangan post terlalu kerap. |
| "Tak jumpa butang upload" / "butang Post tak aktif" | Tengok screenshot yang bot hantar. Mungkin TikTok dah tukar design website, jadi kod bot perlu dikemas kini |
| `browserType.launch: Executable doesn't exist` | Jalankan `npx playwright install --with-deps chromium` |
| Bot crash / VPS jadi lambat | RAM tak cukup. Buat swap (langkah 1b) |
| TikTok kesan headless browser | Cuba browser dengan skrin maya: `sudo apt-get install -y xvfb`, set `BROWSER_HEADLESS=false`, kemudian `pm2 delete tiktok-wa-bot && pm2 start "xvfb-run -a node src/index.js" --name tiktok-wa-bot && pm2 save` |

---

## Kaedah API rasmi (pilihan)

Kalau nanti nak guna API rasmi TikTok, set `TIKTOK_METHOD=api` dan isi `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` dan `TIKTOK_REDIRECT_URI` dalam `.env`.

1. Buat app di **developers.tiktok.com**: platform **Web**, product **Login Kit** (dengan Redirect URI https) dan **Content Posting API** (Direct Post), scope `user.info.basic`, `video.publish` dan `video.upload`.
2. Sebelum app lulus audit, hanya boleh post **private** (`TIKTOK_PRIVACY=SELF_ONLY`). Boleh juga guna `!mod draft` dan tekan Post sendiri dalam app TikTok.
3. Arahan WhatsApp untuk kaedah ni: `!login`, `!kod <link>`, `!mod direct|draft`, `!privasi public|friends|followers|private`, `!status` dan `!logout`.

---

## Struktur fail

```
src/index.js       – bot WhatsApp (Baileys), arahan & aliran upload
src/tiktok-web.js  – kaedah web: upload melalui tiktok.com guna Playwright
src/tiktok.js      – kaedah api: OAuth TikTok + Content Posting API
src/video.js       – ffprobe/ffmpeg: semak fps & tukar ke 60fps
src/config.js      – baca .env
src/store.js       – simpan token, cookies & setting dalam data/
```
