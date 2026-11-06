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

## Notifikasi Telegram (pilihan)

1. Cari **@BotFather** dalam Telegram, hantar `/newbot` dan salin token yang diberi.
2. Hantar apa-apa mesej kepada bot anda, kemudian buka `https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin `chat.id`.
3. Jalankan:

       export TELEGRAM_TOKEN="123456:ABC..."
       export TELEGRAM_CHAT_ID="987654321"

Anda akan terima gambar dan pautan ke page web setiap kali orang tidak dikenali dikesan.
Tambah `--maklum-dikenali` untuk terima notifikasi bagi orang yang dikenali juga.

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
