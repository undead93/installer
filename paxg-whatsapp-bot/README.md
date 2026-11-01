# Bot Alert WhatsApp — Bybit PAXGUSDT Futures

Bot ni pantau harga **PAXGUSDT (Bybit USDT Perpetual)** dan hantar alert ke WhatsApp bila harga **naik atau turun 100 pip** dari harga yang anda masukkan. Setiap alert sekali dengan **trend 15m / 30m / 1H / 4H** berdasarkan **EMA 7, 14, 28** (sama dengan setting EMA dalam app Bybit anda).

## Ciri-ciri

- Masukkan harga terus dari WhatsApp: `set 2650`
- Alert bila harga ≥ harga + 100 pip **atau** ≤ harga − 100 pip
- Trend setiap timeframe (15m, 30m, 1H, 4H) dengan nilai EMA7 / EMA14 / EMA28
- Senarai alert aktif dan sejarah alert yang sudah kena: `list`
- Alert disimpan dalam fail, jadi tak hilang bila bot restart
- Data harga diambil dari API awam Bybit, jadi **tak perlu API key**

## Arahan WhatsApp

| Arahan | Fungsi |
|---|---|
| `set 2650` | Alert ±100 pip dari 2650 (naik 2660 / turun 2640) |
| `set 2650 50` | Guna jarak 50 pip |
| `set 2650 ulang` | Alert berterusan: bila kena, harga asal pindah ke paras baru dan bot terus pantau 100 pip seterusnya |
| `list` / `senarai` | Senarai alert aktif + 10 alert terakhir yang sudah kena |
| `padam 3` | Padam alert #3 |
| `padam semua` | Padam semua alert aktif |
| `sejarah padam` | Kosongkan sejarah |
| `trend` | Trend 15m/30m/1H/4H + EMA 7/14/28 |
| `harga` | Harga semasa (last, mark, high/low 24 jam) |
| `menu` | Papar senarai arahan |

### Contoh mesej alert

```
🚀 ALERT PAXGUSDT NAIK 100 PIP (#1)

Harga sekarang: 2660.40
Harga asal: 2650.00
Sasaran ⬆️: 2660.00
Masa: 01/11 14:26
✅ Alert ini selesai.

📊 Trend semasa:
15m 🟢 UPTREND (kuat)
   EMA7 2658.10 | EMA14 2655.42 | EMA28 2651.90
30m 🟢 UPTREND
   EMA7 2654.30 | EMA14 2652.80 | EMA28 2650.11
1H 🟡 SIDEWAYS
   EMA7 2649.20 | EMA14 2650.70 | EMA28 2648.95
4H 🔴 DOWNTREND
   EMA7 2641.00 | EMA14 2645.30 | EMA28 2652.60

Rumusan: 🟢 Condong naik (2/4 TF up)
```

### Cara bot tentukan trend

| Trend | Syarat |
|---|---|
| 🟢 UPTREND | EMA7 > EMA14 > EMA28 (tambah **kuat** kalau harga juga di atas EMA7) |
| 🔴 DOWNTREND | EMA7 < EMA14 < EMA28 (tambah **kuat** kalau harga juga di bawah EMA7) |
| 🟡 SIDEWAYS | EMA bersilang atau bercampur |

EMA dikira dari 200 candle terakhir, termasuk candle yang sedang berjalan, sama macam chart dalam app Bybit.

## Pip

Default **1 pip = 0.1**, jadi **100 pip = 10 USDT**. Ini kiraan biasa untuk emas.
Kalau anda kira 1 pip = 0.01 (100 pip = 1 USDT), tukar `PIP_SIZE=0.01` dalam `.env`.

## Cara pasang

Perlukan **Node.js 20 atau lebih baru**. Boleh jalan di PC, VPS, atau Android (Termux).

```bash
cd paxg-whatsapp-bot
npm install
cp .env.example .env
nano .env        # isi OWNER_NUMBERS dengan nombor anda, contoh 60123456789
npm start
```

Kali pertama, QR code akan keluar di terminal. Scan QR tu dari telefon yang akan jadi **bot**:
WhatsApp → **Peranti dipaut (Linked devices)** → **Paut peranti**.

Lepas tu sesi disimpan dalam folder `auth/`, jadi tak perlu scan lagi.

> Tak boleh scan QR? (contohnya bot jalan di telefon yang sama) Isi `PAIRING_NUMBER=60xxxxxxxxx` (nombor akaun bot) dalam `.env`, kemudian jalankan semula. Bot akan papar **pairing code**. Masukkan code tu di WhatsApp → Peranti dipaut → Paut dengan nombor telefon.

### Pilihan nombor

1. **Disyorkan:** guna **nombor kedua** (SIM lain atau WhatsApp Business) sebagai bot, dan letak nombor utama anda dalam `OWNER_NUMBERS`. Alert akan masuk sebagai mesej biasa, jadi **telefon berbunyi**. Hantar arahan (`set 2650`, `list`…) terus ke nombor bot.
2. **Satu nombor sahaja:** link nombor anda sendiri, kemudian taip arahan dalam chat **"Message yourself" / "Anda"**. Bot balas dalam chat yang sama.
   ⚠️ WhatsApp biasanya **tak bagi notifikasi** untuk mesej dari diri sendiri, jadi alert mungkin senyap.

Hanya nombor dalam `OWNER_NUMBERS` (dan chat diri sendiri) boleh guna bot. Mesej daripada orang lain diabaikan.

### Jalan 24 jam (VPS)

```bash
npm install -g pm2
pm2 start src/index.js --name paxg-bot
pm2 save && pm2 startup
pm2 logs paxg-bot      # tengok log / QR
```

## Setting `.env`

| Nama | Default | Keterangan |
|---|---|---|
| `OWNER_NUMBERS` | – | Nombor penerima alert, pisah dengan koma |
| `PAIRING_NUMBER` | – | Isi untuk login guna pairing code instead of QR |
| `SYMBOL` | `PAXGUSDT` | Simbol Bybit |
| `CATEGORY` | `linear` | `linear` = USDT perpetual futures |
| `PIP_SIZE` | `0.1` | Saiz 1 pip |
| `DEFAULT_PIPS` | `100` | Jarak alert default |
| `POLL_SECONDS` | `5` | Selang semak harga (saat) |
| `EMA_PERIODS` | `7,14,28` | Tempoh EMA |
| `TIMEFRAMES` | `15,30,60,240` | Timeframe trend (minit) |
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Zon masa paparan |

## Struktur

```
src/
  index.js     – mula bot, loop semak harga, hantar alert
  whatsapp.js  – sambungan WhatsApp (Baileys), QR/pairing, tapis owner
  commands.js  – arahan WhatsApp (set, list, padam, trend, harga)
  alerts.js    – simpan & semak alert (data/alerts.json)
  trend.js     – kira EMA & trend
  bybit.js     – API awam Bybit V5 (ticker & kline)
test/          – ujian (npm test)
```

## Nota

- Bot ni guna [Baileys](https://github.com/WhiskeySockets/Baileys), iaitu library WhatsApp Web **tidak rasmi**. Untuk kegunaan peribadi biasanya OK, tapi jangan guna untuk spam. Lebih selamat guna nombor kedua.
- Kalau WhatsApp log keluar, padam folder `auth/` dan scan semula.
- Ini alat bantuan sahaja, bukan nasihat kewangan.
