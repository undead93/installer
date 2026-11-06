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
| **Log & video** | Klip video setiap notifikasi, dan senarai siapa dikesan hari ini. |
| **Langsung** | Video kamera dengan label nama. |

Untuk letak kata laluan pada page web:

    python3 cctv_kenal.py pantau --sumber "rtsp://..." --kata-laluan rahsia123

Untuk tutup page web, guna `--port 0`.

## Guna di Windows

Sistem ini juga berjalan di Windows 10/11, jadi anda boleh cuba dulu sebelum pindah ke Mac.

**1. Pasang alat (sekali sahaja)**
- **Python 3.11 atau lebih baru:** muat turun dari python.org. Semasa memasang, tanda ✅ **"Add python.exe to PATH"**.
- **Node.js LTS:** muat turun dari nodejs.org. Ini hanya perlu untuk WhatsApp.

**2. Pasang pakej.** Buka **PowerShell** dalam folder `cctv-kenal-orang` (Shift + klik kanan dalam folder, kemudian *Open PowerShell window here*):

    pip install -r requirements.txt
    cd whatsapp; npm install; cd ..

**3. Jalankan.** Di Windows, guna `python` (bukan `python3`), dan `$env:` (bukan `export`):

    $env:WHATSAPP_KE="0123456789"
    python cctv_kenal.py pantau --sumber "rtsp://user:pass@192.168.1.25:554/stream1"

    # atau cuba dengan webcam laptop dahulu:
    python cctv_kenal.py pantau --sumber 0 --papar

Untuk simpan tetapan, buat fail `tetapan.ps1` yang mengandungi baris-baris `$env:...`, kemudian jalankan `. .\tetapan.ps1` sebelum sistem dimulakan.

**Perkara yang biasa berlaku di Windows:**
- **Windows Firewall akan bertanya** sama ada Python dibenarkan guna rangkaian. Tanda **Private networks** dan tekan *Allow*. Tanpa kebenaran ini, telefon tak dapat buka page web.
- `python` membuka Microsoft Store: Python belum dipasang dengan betul. Pasang semula dari python.org dan tanda "Add to PATH".
- Kalau `npm` disekat oleh *execution policy*, jalankan sekali `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, atau guna Command Prompt (`cmd`). Dalam cmd, guna `set WHATSAPP_KE=0123456789`, bukan `$env:`.
- Supaya PC tidak tidur, pergi ke Settings, kemudian System, kemudian Power, dan tetapkan *Sleep* kepada **Never** semasa sistem berjalan.
- Untuk pindah ke Mac nanti, salin folder `orang/`, `whatsapp/auth/` dan fail `tetapan.json`. Wajah yang sudah dinamakan, sesi WhatsApp dan mesej khas akan ikut sekali, jadi tak perlu daftar atau imbas QR semula.

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
| `klip/` | Klip video yang dihantar bersama notifikasi. Dipadam sendiri selepas 14 hari. |
| `tangkapan/` | Gambar penuh semasa orang tidak dikenali dikesan. |

## Notifikasi WhatsApp (Baileys)

Bila **orang berdaftar** dikesan, sistem hantar mesej WhatsApp **bersama klip video HD**
(dari 3 saat sebelum hingga 5 saat selepas orang itu dikesan):

    🏠 Isteri dah balik
    🎒 Anak dah balik sekolah
    🕒 06/11 6:45 PM

- **Mesej khas setiap orang:** dalam tab **Orang berdaftar**, taip mesej (contohnya `🏠 Isteri dah balik`) dan tekan **Simpan mesej**.
  Kalau dibiarkan kosong, mesej asal `✅ <nama> dikesan di kamera` akan digunakan.
- Kalau beberapa orang sampai **serentak** (dalam 3 saat yang sama), mereka digabung dalam **satu** mesej dan satu video.
- Semua klip disimpan dalam `klip/` dan boleh ditonton dalam tab **Log & video** di page web. Klip dipadam sendiri selepas 14 hari (`--simpan-hari`).

Sistem juga hantar mesej bila **orang tidak dikenali** dikesan, bersama pautan ke page web untuk namakan orang itu.

Mesej dihantar terus dari Mac anda menggunakan [Baileys](https://github.com/WhiskeySockets/Baileys), iaitu sambungan
WhatsApp Web. Tiada servis luar dan tiada bayaran. Mesej akan datang **dari nombor yang imbas QR**,
jadi guna nombor kedua (contohnya nombor prepaid lama) sebagai "nombor CCTV". Penerima boleh nombor anda sendiri
atau satu kumpulan WhatsApp keluarga.

### Pasang (sekali sahaja)

    brew install node              # Node.js 20 atau lebih baru
    cd whatsapp && npm install && cd ..

### Jalankan

    export WHATSAPP_KE="0123456789"                 # nombor penerima; beberapa nombor dipisah koma
    python3 cctv_kenal.py pantau --sumber "rtsp://..."

1. Penghantar WhatsApp dimulakan secara automatik. **Kali pertama**, QR akan dipaparkan dalam terminal dan
   dalam page web (tab **Orang berdaftar**).
2. Dengan telefon nombor CCTV, buka WhatsApp, pergi ke **Tetapan**, kemudian **Peranti Dipautkan**, kemudian **Pautkan Peranti**, dan imbas QR itu.
3. Bila page web tunjuk "WhatsApp bersambung", tekan **Hantar ujian**.

Sesi disimpan dalam `whatsapp/auth/`, jadi QR tidak perlu diimbas lagi selepas ini. Jangan kongsi folder itu.
Untuk tukar nombor CCTV, padam folder itu, atau log keluar peranti dari telefon, dan imbas QR baru.

Telefon nombor CCTV tak perlu sentiasa hidup. Ia cuma perlu dibuka sekurang-kurangnya sekali setiap 14 hari,
supaya WhatsApp tidak memutuskan peranti yang dipautkan.

### Hantar ke kumpulan WhatsApp keluarga

1. Masukkan nombor CCTV ke dalam kumpulan itu.
2. Semasa sistem berjalan, buka `http://127.0.0.1:3001/kumpulan` di Mac. Salin `id` kumpulan, contohnya `120363012345678901@g.us`.
3. Set `export WHATSAPP_KE="120363012345678901@g.us"`. Anda boleh campur ID kumpulan dengan nombor biasa, dipisah koma.

### Kawalan

- Dalam tab **Orang berdaftar**, setiap orang ada suis *Hantar notifikasi*. Matikan suis untuk orang yang anda tak perlu dimaklumkan.
- Untuk orang yang sama, notifikasi hanya dihantar sekali setiap 10 minit. Ubah dengan `--cooldown-maklum 1800` (30 minit).
- Untuk tutup notifikasi orang tidak dikenali, guna `--tanpa-maklum-asing`.
- Untuk cuba tanpa menghantar mesej sebenar, guna `WA_KERING=1`. Mesej akan dicetak dalam terminal sahaja.

### Kualiti klip video

**Mod HD (default untuk kamera RTSP seperti Tapo):** strim asal kamera dirakam terus, tanpa ditukar.
- Resolusi penuh kamera: 2K atau 1080p untuk Tapo `stream1`.
- **Ada bunyi.** Guna `--tanpa-audio` untuk tutup bunyi.
- Hampir tidak guna CPU, jadi sesuai untuk Mac mini Intel.
- Kotak nama tidak dilukis pada video. Nama tetap tertulis dalam mesej, dan Tapo sendiri sudah paparkan masa pada video.
- Kalau kamera guna H.265, klip ditukar ke H.264 secara automatik supaya boleh dimainkan dalam WhatsApp. Langkah ini guna sedikit CPU.
- Panjang klip mungkin 1–2 saat lebih daripada yang ditetapkan, kerana rakaman dipotong pada bingkai kunci (keyframe) kamera.

Kalau `--sumber` guna `stream2` (resolusi rendah, jimat CPU untuk kenal wajah), anda masih boleh rakam dari `stream1`:

    python3 cctv_kenal.py pantau --sumber "rtsp://u:p@IP:554/stream2" --sumber-hd "rtsp://u:p@IP:554/stream1"

**Mod label (`--klip-mod label`):** video 480p dengan kotak nama dilukis pada wajah. Mod ini digunakan secara automatik untuk webcam.

| Pilihan | Default | Maksud |
|---|---|---|
| `--klip-sebelum` | 3 | Saat video **sebelum** orang dikesan. |
| `--klip-selepas` | 5 | Saat video **selepas** orang dikesan. Notifikasi dihantar selepas tempoh ini tamat. |
| `--klip-mod` | auto | `hd`, `label` atau `auto` (HD jika kamera RTSP). |
| `--tanpa-audio` | – | Klip HD tanpa bunyi. |
| `--tanpa-video` | – | Hantar gambar sahaja. |

Video diproses menggunakan ffmpeg dari pakej `imageio-ffmpeg`, yang dipasang bersama `pip install -r requirements.txt`.

### Telegram (pilihan)

1. Cari **@BotFather** dalam Telegram, hantar `/newbot` dan salin token yang diberi.
2. Hantar apa-apa mesej kepada bot anda, kemudian buka `https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin `chat.id`.
3. Set `export TELEGRAM_TOKEN="123456:ABC..."` dan `export TELEGRAM_CHAT_ID="987654321"`.

Anda boleh hidupkan WhatsApp dan Telegram serentak.

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
