# CCTV Kenal Orang

Sistem ini mengenal wajah orang dalam video CCTV (Tapo, Hikvision, Dahua dan lain-lain), IP camera atau webcam.
Ia juga ada **page web** yang boleh dibuka dari telefon untuk menamakan orang.

Cara ia berfungsi:

1. Sistem pantau kamera. Bila ada orang yang **tidak dikenali**, gambar wajahnya disimpan secara automatik.
   Gambar orang yang sama dikumpulkan dalam satu kad.
2. Buka page web dari telefon. Taip nama pada setiap kad dan tekan **Simpan**.
3. Mulai saat itu, sistem terus kenal orang tersebut. Tak perlu restart.

Sistem ini hanya perlukan OpenCV. GPU tidak diperlukan. Model (~40MB) dimuat turun sendiri kali pertama ia dijalankan.

## 1. Pasang

    pip install -r requirements.txt

Di Mac (Homebrew Python), buat venv dahulu:

    python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt

## 2. Jalankan

    # Kamera Tapo / CCTV (RTSP)
    python3 cctv_kenal.py pantau --sumber "rtsp://namapengguna:katalaluan@192.168.1.25:554/stream1"

    # Webcam
    python3 cctv_kenal.py pantau --sumber 0

Bila sistem bermula, ia akan paparkan alamat page web, contohnya:

    Page web: http://192.168.1.50:8000

Buka alamat itu dari telefon atau komputer yang guna **WiFi yang sama**.

### Page web

| Tab | Kegunaan |
|---|---|
| **Wajah baru** | Kad untuk setiap orang yang belum dikenali. Taip nama dan tekan Simpan. Ketik gambar yang salah orang supaya ia tidak disimpan. Butang "Mungkin Ali?" muncul jika wajah itu mirip orang yang sudah berdaftar. |
| **Orang berdaftar** | Senarai orang dan gambar mereka. Anda boleh tambah orang baru dengan memuat naik gambar dari telefon, padam gambar yang salah, atau padam orang. |
| **Log hari ini** | Siapa dikesan dan bila. |
| **Langsung** | Video kamera dengan label nama. |

Untuk letak kata laluan pada page web:

    python3 cctv_kenal.py pantau --sumber "rtsp://..." --kata-laluan rahsia123

Untuk tutup page web, guna `--port 0`.

## Kamera Tapo

1. Dalam app Tapo, buka kamera, tekan ⚙️ Settings, pilih **Advanced Settings**, kemudian **Camera Account**. Buat nama pengguna dan kata laluan. Ini bukan akaun TP-Link anda. Elakkan simbol `@ : / #`.
2. Pergi ke ⚙️ Settings, kemudian **Device Info**, dan catat alamat IP kamera. Elok juga tetapkan IP tetap untuk kamera dalam router.
3. Untuk URL, guna `rtsp://user:pass@IP:554/stream1` (resolusi penuh) atau `/stream2` (resolusi rendah).

Model bateri (C400/C420/C425) dan loceng pintu biasanya tiada RTSP. Kalau Privacy Mode dihidupkan, video RTSP akan berhenti.

URL RTSP jenama lain:

| Jenama | URL |
|---|---|
| Hikvision | `rtsp://user:pass@IP:554/Streaming/Channels/101` |
| Dahua / Imou | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=0` |
| Ezviz | `rtsp://admin:KODPENGESAHAN@IP:554/h264/ch1/main/av_stream` |

## Fail yang disimpan

| Folder | Isi |
|---|---|
| `orang/<nama>/` | Gambar orang berdaftar. Anda juga boleh letak gambar di sini secara manual, kemudian jalankan `python3 cctv_kenal.py daftar`. |
| `wajah_baru/` | Wajah orang tidak dikenali yang belum dinamakan. Dipadam sendiri selepas 14 hari (`--simpan-hari`). |
| `log/YYYY-MM-DD.csv` | Rekod masa, nama dan skor. Boleh dijadikan rekod kehadiran. |
| `tangkapan/` | Gambar penuh semasa orang tidak dikenali dikesan. |

## Notifikasi WhatsApp

Bila **orang berdaftar** dikesan, sistem hantar mesej WhatsApp seperti ini:

    ✅ Ali dikesan di kamera
    🕒 06/11 10:32 AM

Sistem juga hantar mesej bila **orang tidak dikenali** dikesan, bersama pautan ke page web untuk namakan orang itu.

- Dalam tab **Orang berdaftar**, setiap orang ada suis *Hantar notifikasi*. Matikan suis untuk orang yang anda tak perlu dimaklumkan.
- Untuk orang yang sama, notifikasi hanya dihantar sekali setiap 10 minit. Ubah dengan `--cooldown-maklum 1800` (30 minit).
- Untuk tutup notifikasi orang tidak dikenali, guna `--tanpa-maklum-asing`.
- Butang **Hantar ujian** dalam page web akan hantar mesej ujian untuk memastikan semuanya berfungsi.

Pilih **satu** daripada dua cara di bawah.

### Cara A: Green-API (dengan gambar) – disyorkan

Green-API menyambung nombor WhatsApp anda melalui QR, sama macam WhatsApp Web. Mesej dihantar **dari nombor itu**,
jadi guna nombor kedua (contohnya nombor prepaid lama) sebagai "nombor CCTV". Penerima boleh nombor anda sendiri
atau satu kumpulan WhatsApp keluarga.

1. Daftar di **green-api.com** dan buat *instance* (ada pelan percuma *Developer*).
2. Dalam console, imbas QR dengan WhatsApp nombor CCTV (Peranti Dipautkan, kemudian Pautkan Peranti).
3. Salin **idInstance**, **apiTokenInstance** dan **apiUrl** dari console.
4. Sebelum jalankan sistem, set:

       export GREENAPI_INSTANCE="7103123456"
       export GREENAPI_TOKEN="abc123..."
       export GREENAPI_URL="https://7103.api.greenapi.com"     # apiUrl dari console
       export WHATSAPP_KE="0123456789,0198765432"             # nombor penerima, dipisah koma

   Untuk hantar ke kumpulan WhatsApp, letak ID kumpulan (contohnya `120363012345678901@g.us`) dalam `WHATSAPP_KE`.
   ID kumpulan boleh didapati dalam console Green-API (getChats).

Green-API bukan servis rasmi WhatsApp. Gunakan nombor kedua, bukan nombor utama anda.

### Cara B: CallMeBot (percuma, teks sahaja)

Cara ini paling mudah, tetapi **tiada gambar**, dan mesej hanya boleh dihantar ke nombor yang mendaftar sendiri.

1. Buka **callmebot.com**, pergi ke bahagian *WhatsApp API*, dan simpan nombor bot yang tertera dalam kenalan telefon. Nombor ini pernah bertukar, jadi sentiasa ambil dari laman itu.
2. Hantar mesej WhatsApp `I allow callmebot to send me messages` ke nombor itu.
3. Anda akan terima **apikey**. Kemudian set:

       export CALLMEBOT="0123456789:123456"

   Untuk beberapa penerima, setiap seorang perlu buat langkah 1–2. Kemudian set: `CALLMEBOT="0123456789:111111,0198765432:222222"`

### Telegram (pilihan)

1. Cari **@BotFather** dalam Telegram, hantar `/newbot` dan salin token yang diberi.
2. Hantar apa-apa mesej kepada bot anda, kemudian buka `https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin `chat.id`.
3. Set `export TELEGRAM_TOKEN="123456:ABC..."` dan `export TELEGRAM_CHAT_ID="987654321"`.

Anda boleh hidupkan WhatsApp dan Telegram serentak. Setiap notifikasi akan dihantar ke semua saluran yang disetkan.

### Simpan tetapan supaya tak perlu taip setiap kali

Simpan semua baris `export` dalam fail `tetapan.sh`, kemudian jalankan:

    source tetapan.sh && python3 cctv_kenal.py pantau --sumber "rtsp://..."

## Tetapan berguna

| Pilihan | Default | Maksud |
|---|---|---|
| `--fps` | 5 | Bilangan bingkai diproses sesaat. Nilai rendah kurangkan beban CPU dan elektrik. `0` = proses semua bingkai. |
| `--ambang` | 0.363 | Had untuk dikira "kenal". Naikkan (0.45) jika orang tersalah dikenali. Turunkan (0.30) jika orang berdaftar tidak dikenali. |
| `--ambang-kumpul` | 0.45 | Had untuk kumpulkan wajah baru sebagai orang yang sama. Naikkan jika dua orang berbeza masuk satu kad. |
| `--cooldown` | 60 | Saat sebelum orang yang sama dicatat atau dimaklum semula. |
| `--maks-gambar` | 30 | Maksimum gambar disimpan bagi setiap wajah baru. |
| `--saiz-min` | 60 | Saiz wajah minimum (piksel) untuk disimpan. Wajah yang kecil atau kabur tidak disimpan. |
| `--papar` | – | Tunjuk tetingkap video di komputer. |
| `--rakam fail.mp4` | – | Simpan video berlabel. |

## Tips ketepatan

- Letak kamera pada paras muka, contohnya di pintu masuk. Kamera di siling yang menghala ke bawah sukar melihat wajah.
- Lebih banyak gambar setiap orang (5–20), dari sudut dan cahaya berbeza, memberi ketepatan yang lebih baik. Gambar dari CCTV itu sendiri adalah yang terbaik.
- Mod malam (IR, hitam putih) kurang tepat. Namakan juga wajah yang ditangkap pada waktu malam.

## Privasi

Sistem ini menyimpan gambar wajah sesiapa sahaja yang lalu di depan kamera.
Jika digunakan di kedai atau pejabat, Akta Perlindungan Data Peribadi 2010 (PDPA) terpakai.
Pasang notis "Kawasan dipantau CCTV", dapatkan persetujuan pekerja yang didaftar, guna `--kata-laluan`,
dan jangan buka port 8000 kepada internet.
