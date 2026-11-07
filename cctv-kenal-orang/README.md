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

    pip install -r requirements.txt     # termasuk onnxruntime untuk ArcFace

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
| **🏠 Di rumah** | Tab pertama. Ringkasan siapa di rumah dan siapa keluar, kad setiap ahli keluarga dengan status dan pergerakan hari ini, dan butang **Tandakan di rumah / keluar** untuk betulkan status kalau kamera terlepas. |
| **Wajah baru** | Kad untuk setiap orang yang belum dikenali. Taip nama dan tekan Simpan. Ketik gambar yang salah orang supaya ia tidak disimpan. Butang "Mungkin Ali?" muncul jika wajah itu mirip orang yang sudah berdaftar. Kalau orang yang sama ada dalam beberapa kad, tanda **Pilih** pada kad-kad itu dan tekan **Gabungkan**. |
| **Orang berdaftar** | Senarai orang dan gambar mereka. Anda boleh tambah orang baru dengan memuat naik gambar dari telefon, padam gambar yang salah, atau padam orang. |
| **Log & video** | Klip video setiap notifikasi, dan senarai siapa dikesan hari ini. |
| **Langsung** | Video kamera dengan tag nama pada wajah, **kad muka** (gambar, nama, masa) di penjuru kanan, dan **zon pengesanan**. Tekan *Lukis zon pengesanan* dan seret jari di atas video: hanya wajah dalam zon diproses (contohnya untuk abaikan jalan raya atau TV). |

Untuk letak kata laluan pada page web:

    python3 cctv_kenal.py pantau --sumber "rtsp://..." --kata-laluan rahsia123

Untuk tutup page web, guna `--port 0`.

## Dua kamera atau lebih

Gunakan `--kamera "Nama=URL"` untuk setiap kamera, menggantikan `--sumber`:

    python cctv_kenal.py pantau --kamera "Pintu Depan=rtsp://user:pass@192.168.0.106:554/stream1" --kamera "Pagar=rtsp://user:pass@192.168.0.108:554/stream1"

Dalam `mula.bat`, tulis semuanya dalam **satu baris**.

- Mesej WhatsApp menyebut kamera mana: `📍 Pagar`. Klip video diambil dari kamera itu.
- Notifikasi untuk orang yang sama hanya dihantar **sekali** dalam tempoh cooldown, walaupun dia dikesan oleh kedua-dua kamera.
- Dalam page web, tab **Langsung** ada butang untuk pilih kamera. Log dan klip menunjukkan nama kamera.
- Untuk kurangkan beban CPU, kenal wajah dari `stream2` dan rakam HD dari `stream1`:
  `--kamera "Pagar=rtsp://.../stream2|rtsp://.../stream1"` (kenal|rakam).

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

## Masuk atau keluar rumah

Dalam tab **Langsung**, pilih **Arah kamera ini** untuk setiap kamera:

| Pilihan | Sesuai untuk |
|---|---|
| Orang yang dilihat kamera ini sedang **MASUK** | Kamera di luar yang menghadap laluan masuk (contohnya pagar). Kamera ini nampak wajah orang yang datang |
| Orang yang dilihat kamera ini sedang **KELUAR** | Kamera **di dalam rumah yang menghadap pintu**. Kamera ini nampak wajah orang yang keluar |
| **Ikut arah gerakan** (berjalan ke arah kamera = MASUK atau KELUAR) | Satu kamera yang nampak wajah dari kedua-dua arah. Wajah yang makin besar bermaksud orang itu berjalan ke arah kamera |
| **Kamera di sisi laluan**: bergerak ke KANAN (atau KIRI) dalam video = MASUK | **Satu kamera untuk masuk dan keluar.** Pasang di tepi laluan, menghala melintang ke laluan, supaya orang dari kedua-dua arah dilihat dari sisi depan (¾ wajah) semasa mendekati kamera. Arah ditentukan dari gerakan kiri/kanan dalam video |

**Satu kamera untuk masuk dan keluar (kamera di sisi laluan):**

    [PAGAR] ═══════════ laluan ═══════════ [PINTU]
                     ↖  📷  ↗     (di dinding/tiang tepi laluan, ~2 m tinggi,
                                   2–3 m dari laluan, menghala melintang)

1. Pasang kamera di tepi laluan, lebih kurang di tengah antara pagar dan pintu. Halakan melintang ke laluan supaya
   kedua-dua hujung laluan kelihatan dalam video.
2. Dalam tab Langsung, lihat ke arah mana orang yang **masuk** bergerak dalam video (ke kiri atau ke kanan).
3. Pada **Arah kamera ini**, pilih *"Kamera di sisi laluan: bergerak ke KANAN dalam video = MASUK"* (atau KIRI).
4. Cuba berjalan masuk dan keluar. Tab 🏠 *Di rumah* dan terminal (`[MASUK]` / `[KELUAR]`) akan menunjukkan hasilnya.

Sistem kenal wajah perlukan muka. Orang yang keluar biasanya membelakangkan kamera luar, jadi cara paling tepat
ialah satu kamera **MASUK** di luar dan satu kamera **KELUAR** di dalam rumah.

Notifikasi akan berbeza untuk masuk dan keluar (`🏠 Isteri dah balik` / `🚪 Isteri keluar rumah`). Mesej bila keluar
boleh diubah dalam kad setiap orang. Tab **Log & video** menunjukkan **Siapa di rumah**, contohnya
🟢 *Di rumah sejak 6:45 PM* atau ⚪ *Keluar 8:02 AM*. Status ini disimpan dalam `status.json`.

## Daftar wajah dengan kamera (webcam / telefon)

Dalam tab **Orang berdaftar**, guna kad **📷 Daftar wajah dengan kamera**. Taip nama dan tekan **Buka kamera**, kemudian
tekan **Mula ambil gambar**. Ikut arahan di skrin (pandang depan, toleh kiri dan kanan, dongak, tunduk). Sistem akan
mengambil 8 gambar dan mendaftarkannya terus.

Pelayar web hanya membenarkan kamera pada page **https://** atau **localhost**:
- **Di PC yang menjalankan sistem:** buka `http://localhost:8000`, dan webcam boleh terus digunakan.
- **Di telefon:** buka alamat **HTTPS** yang dipaparkan semasa sistem bermula, contohnya `https://192.168.0.50:8443`.
  Pelayar akan memberi amaran kerana sijil keselamatan dijana sendiri oleh sistem ini. Tekan **Advanced → Proceed**
  (Chrome) atau **Show Details → visit this website** (Safari). Langkah ini hanya perlu sekali.

Sijil disimpan dalam `sijil/`. Guna `--port-https 0` untuk tutup page HTTPS.

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
| `log/YYYY-MM-DD.csv` | Rekod masa, nama, skor, kamera dan MASUK/KELUAR. Satu fail baru untuk setiap hari, walaupun sistem tidak ditutup. Boleh dibuka dalam Excel. |
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

### Bot WhatsApp: tanya sistem melalui chat

Hantar mesej kepada **nombor CCTV**, dan bot akan membalas:

| Hantar | Balasan |
|---|---|
| `siapa` / `siapa di rumah` | 🟢 Siapa di rumah dan sejak bila, ⚪ siapa yang keluar |
| `log` | Senarai masuk/keluar hari ini, dan siapa dikesan hari ini |
| `gambar` / `gambar pagar` | Gambar terkini dari semua kamera, atau dari satu kamera |
| `menu` | Senarai arahan |

- Bot **hanya membalas nombor dalam `WHATSAPP_KE`**, dan kumpulan yang disenaraikan di situ. Untuk benarkan nombor lain
  bertanya tanpa menerima notifikasi, set `WHATSAPP_ADMIN="0123456789,0198765432"`.
- Dalam kumpulan, bot hanya membalas arahan yang dikenali, dan perbualan biasa diabaikan.
- Kalau bot tidak membalas mesej peribadi dari nombor anda, tambah nombor anda dalam `WHATSAPP_ADMIN`.
  WhatsApp kini kadang-kadang menyembunyikan nombor pengirim (ID `@lid`).
- Bot memerlukan page web (`--port`) dihidupkan, kerana mesej masuk diproses melaluinya. Ia tetap berfungsi
  walaupun page web dikunci dengan `--kata-laluan`.

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
| `--ambang-kumpul` | 0.38 | Had untuk kumpulkan wajah baru sebagai orang yang sama. Turunkan (0.34) jika orang yang sama masih berpecah ke banyak kad. Naikkan (0.45) jika dua orang berbeza masuk satu kad. |
| `--cooldown` | 60 | Saat sebelum orang yang sama dicatat atau dimaklum semula. |
| `--maks-gambar` | 30 | Maksimum gambar disimpan bagi setiap wajah baru. |
| `--saiz-min` | 60 | Saiz wajah minimum (piksel) untuk disimpan. Wajah yang kecil atau kabur tidak disimpan. |
| `--papar` | – | Tunjuk tetingkap video di komputer. |
| `--rakam fail.mp4` | – | Simpan video berlabel. |

## Model AI: ArcFace (lalai) atau SFace

Sistem menggunakan **ArcFace + SCRFD** dari InsightFace secara lalai. Kali pertama sistem dijalankan, model (~290MB)
dimuat turun secara automatik.

Perbandingan pada 41 orang berbeza, dengan wajah yang dirosakkan seperti rakaman CCTV:

| Keadaan wajah | SFace: betul dikenal | ArcFace: betul dikenal |
|---|---|---|
| 90 piksel | 31/41 | **39/41** |
| 60 piksel | 21/41 | **38/41** |
| 40 piksel | 17/41 | **32/41** |
| kabur / gelap / IR | 23 / 20 / 23 | **37 / 33 / 29** |
| Orang lain tersalah dikenali | 3.2% (had 0.363) | **0.06%** (had 0.35) |

ArcFace lebih berat (~10 kali lebih banyak kerja CPU untuk setiap bingkai). Untuk menjimatkan CPU, sistem:
- **melangkau pengesanan bila tiada gerakan** dalam gambar (guna `--tanpa-gerakan` untuk matikan ciri ini),
- **guna semula cap jari wajah** yang sama dari bingkai sebelumnya.

Untuk PC yang lemah, guna `--model sface` (ringan), atau kurangkan `--fps 3`.
Cap jari wajah setiap model disimpan dalam fail berasingan (`.npy` untuk SFace dan `.arc.npy` untuk ArcFace), jadi anda
boleh bertukar model tanpa perlu mendaftar semula. Model ArcFace InsightFace hanya untuk **kegunaan bukan komersial**.

## Tips ketepatan

**Notifikasi hanya bila pasti.** Sebelum notifikasi WhatsApp dihantar, sistem menyemak:
1. Orang yang sama dikesan sekurang-kurangnya **3 kali dalam 4 saat** (`--sahkan`, `--tempoh-sahkan`).
2. **Purata skor** melepasi had notifikasi (`--ambang-maklum`, iaitu 0.40 untuk ArcFace).
3. Skor orang itu **jelas lebih tinggi daripada orang berdaftar lain** (`--beza-min 0.06`), supaya adik-beradik yang mirip tidak tertukar.
4. Sekurang-kurangnya **separuh pengesanan ialah wajah yang jelas**, iaitu menghadap kamera dan ≥ 50px (`--saiz-min-maklum`).
5. Untuk orang asing: wajah itu tidak hampir padan dengan mana-mana ahli keluarga, dan wajahnya jelas.

Kalau notifikasi tidak dihantar, terminal menerangkan sebabnya, contohnya
`[maklum] Isteri dikesan tetapi belum pasti: skor 0.37 < 0.40`. Untuk pengesahan paling ketat, guna **`--ketat`**:
5 pengesanan dalam 6 saat, skor +0.05, dan beza dengan orang lain ≥ 0.10.

Dalam paparan Langsung, kotak **oren** dengan tanda `?` (contohnya `adik?`) bermaksud "mungkin, tetapi belum pasti".

**Semua orang dikenali sebagai nama yang sama?** Biasanya ini berlaku kerana ada gambar orang lain, atau gambar yang
kabur, di bawah nama itu. Dalam tab **Orang berdaftar**, setiap gambar menunjukkan berapa kali ia dipadankan
(contohnya `12×`). Gambar yang padan dengan kebanyakan orang dengan skor rendah ditanda **⚠️**. Ketik gambar itu
untuk **Pindah** ke orang yang betul, atau **Padam**. Seseorang hanya dikenali bila purata 2 gambarnya yang paling
serupa melepasi `--ambang`, jadi satu gambar yang salah tidak lagi cukup untuk menyebabkan orang lain tersalah dikenali.

**Wajah jauh tidak dikesan?** Sistem mengecilkan gambar kamera ke lebar 1280 piksel sebelum mencari wajah (`--lebar-kesan`).
Pada kamera 2K, ini mengesan wajah dari kira-kira 60 piksel. Untuk orang yang lebih jauh, guna `--lebar-kesan 1920`
dan `--saiz-min 40`. Ini perlukan lebih CPU, dan wajah yang kecil kurang tepat untuk dikenal.
Terminal akan beritahu bila orang tidak dikenali dikesan tetapi gambarnya tidak disimpan, beserta sebabnya.

**Orang yang sama dalam satu kad.** Sistem mengemas kad secara automatik dengan tiga cara:
- Wajah baru yang padan dengan beberapa kad akan **menggabungkan** kad-kad itu.
- Setiap kali sistem dimulakan, dan setiap jam, kad yang mirip satu sama lain digabung. Kad yang padan dengan orang yang sudah berdaftar dimasukkan terus ke nama orang itu.
- Selepas anda menamakan satu kad, kad lain orang yang sama **terus masuk** ke nama itu.

Wajah dari sisi, wajah yang terlalu kecil dan wajah yang kabur tidak disimpan, kerana gambar begini sering mencipta kad baru. Kalau masih ada kad berpecah, gunakan **Pilih** dan **Gabungkan**.

- Letak kamera pada paras muka, contohnya di pintu masuk. Kamera di siling yang menghala ke bawah sukar melihat wajah.
- Lebih banyak gambar setiap orang (5–20), dari sudut dan cahaya berbeza, memberi ketepatan yang lebih baik. Gambar dari CCTV itu sendiri adalah yang terbaik.
- Mod malam (IR, hitam putih) kurang tepat. Namakan juga wajah yang ditangkap pada waktu malam.

## Privasi

Sistem ini menyimpan gambar wajah sesiapa sahaja yang lalu di depan kamera.
Jika digunakan di kedai atau pejabat, Akta Perlindungan Data Peribadi 2010 (PDPA) terpakai.
Pasang notis "Kawasan dipantau CCTV", dapatkan persetujuan pekerja yang didaftar, guna `--kata-laluan`,
dan jangan buka port 8000 kepada internet.
