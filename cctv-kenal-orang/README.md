# CCTV Kenal Orang

Skrip Python yang mengenal wajah orang dalam video CCTV, IP camera atau webcam.
Ia hanya perlukan OpenCV: YuNet untuk mengesan wajah, SFace untuk mengenal wajah.
Model (~40MB) dimuat turun sendiri kali pertama skrip dijalankan.

## 1. Pasang

    pip install -r requirements.txt

Komputer biasa, mini PC atau Raspberry Pi 4/5 sudah cukup. GPU tidak diperlukan.

## 2. Daftar orang yang anda kenal

Buat satu folder untuk setiap orang dan masukkan 3–10 gambar wajahnya
(dari depan, sisi sedikit, cahaya berbeza):

    orang/
      ali/      1.jpg 2.jpg 3.jpg
      siti/     1.jpg 2.jpg

Kemudian jalankan:

    python3 cctv_kenal.py daftar

Jalankan arahan ini semula setiap kali anda tambah atau buang gambar.

## 3. Pantau kamera

    # Kamera CCTV / IP camera (RTSP)
    python3 cctv_kenal.py pantau --sumber "rtsp://admin:katalaluan@192.168.1.64:554/Streaming/Channels/101" --papar

    # Webcam
    python3 cctv_kenal.py pantau --sumber 0 --papar

    # Fail video rakaman
    python3 cctv_kenal.py pantau --sumber rakaman.mp4 --rakam hasil.mp4

Contoh URL RTSP mengikut jenama (tukar IP, nama pengguna dan kata laluan):

| Jenama | URL |
|---|---|
| Hikvision | `rtsp://user:pass@IP:554/Streaming/Channels/101` (`102` = sub-stream) |
| Dahua / Imou | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=0` |
| TP-Link Tapo | `rtsp://user:pass@IP:554/stream1` (akaun kamera dibuat dalam app Tapo) |
| Ezviz | `rtsp://admin:KODPENGESAHAN@IP:554/h264/ch1/main/av_stream` |

Untuk DVR/NVR, tukar nombor saluran (channel) mengikut kamera yang anda mahu.

### Apa yang berlaku

- Kotak **hijau** dengan nama dilukis pada orang yang dikenali. Kotak **merah** "TIDAK DIKENALI" dilukis pada orang lain.
- Setiap pengesanan dicatat dalam `log/YYYY-MM-DD.csv` (masa, nama, skor). Fail ini boleh dijadikan rekod kehadiran.
- Gambar orang tidak dikenali disimpan dalam `tangkapan/`.
- `--cooldown 60`: orang yang sama hanya dicatat sekali setiap 60 saat.

## 4. Notifikasi Telegram (pilihan)

1. Cari **@BotFather** dalam Telegram, hantar `/newbot` dan salin token yang diberi.
2. Hantar apa-apa mesej kepada bot anda, kemudian buka
   `https://api.telegram.org/bot<TOKEN>/getUpdates` dan salin nombor `chat.id`.
3. Jalankan:

       export TELEGRAM_TOKEN="123456:ABC..."
       export TELEGRAM_CHAT_ID="987654321"
       python3 cctv_kenal.py pantau --sumber "rtsp://..."

Anda akan terima gambar setiap kali orang tidak dikenali dikesan.
Tambah `--maklum-dikenali` untuk terima notifikasi bagi orang yang dikenali juga.

## Tips ketepatan

- **Ambang (`--ambang`)**: nilai default 0.363. Jika orang lain tersalah dikenali, naikkan ke 0.45. Jika orang yang didaftar tidak dikenali, turunkan ke 0.30, atau tambah lebih banyak gambar orang itu.
- Letak kamera pada paras muka, contohnya di pintu masuk. Kamera di siling yang menghala tegak ke bawah sukar melihat wajah.
- Wajah perlu sekurang-kurangnya ~60×60 piksel dalam gambar. Guna main-stream (resolusi penuh) jika orang berdiri jauh dari kamera.
- Cahaya belakang yang kuat dan mod malam (IR, hitam putih) mengurangkan ketepatan. Daftar juga gambar yang diambil dari kamera itu sendiri, termasuk pada waktu malam.

## Privasi

Jika digunakan di kedai atau pejabat, Akta Perlindungan Data Peribadi 2010 (PDPA) terpakai.
Pasang notis "Kawasan dipantau CCTV", dapatkan persetujuan pekerja yang didaftar,
dan simpan fail `pangkalan.npz`, `log/` serta `tangkapan/` dengan selamat.
