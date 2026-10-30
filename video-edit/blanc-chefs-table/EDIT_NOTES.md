# BLANC · Chef's Table: nota edit

Video vertical 1080×1920, 30 fps, 47.2 s. Dibina dengan HyperFrames (HTML + GSAP, dirender ke MP4).

## Transkrip

Kesemua 9 klip ditranskrip dengan Whisper (word-level, VAD). **Tiada percakapan yang jelas** dalam footage, cuma bunyi ambien restoran:

| Klip | Keputusan |
| --- | --- |
| IMG_0598, 0604, 0605, 0607, 0608, 0609, 0622 | Tiada suara (hanya ambien dapur/restoran) |
| IMG_0611 | ~2.7–4.6 s: suara staf tidak jelas semasa menghidang |
| IMG_0630 | ~2.3–2.9 s: "thank you" pendek |

Oleh itu, edit ini dipandu oleh visual dan aksi. Animasi, motion graphics dan SFX diletakkan pada aksi di skrin (plating, potongan, hidangan sampai). Bunyi ambien asal dikekalkan sebagai "bed".

## Apa yang dibuang

- Bahagian gelap/kosong (contoh IMG_0609 8–20 s, IMG_0622 24–27 s dan 37–43 s, IMG_0607 hujung)
- Gegaran kamera, zoom tukar lensa, dan whip semasa mula rakam (contoh IMG_0598 0–1.2 s, IMG_0609 4.8–5.1 s)
- Shot yang berulang: hanya **satu** shot lebar ruang makan pembuka dan **satu** shot lebar penutup; antara tiga shot "squeeze bottle" minyak hijau, hanya dua sudut berbeza digunakan
- **Setiap saat footage digunakan sekali sahaja**; tiada segmen yang diulang

## Shot list

| # | Masa | Sumber (in → out) | Kandungan | Grafik / SFX |
| --- | --- | --- | --- | --- |
| 1 | 0.0–3.2 | IMG_0622 4.0–7.2 | Chef plating bawah lampu | Tajuk "An evening at BLANC", push perlahan |
| 2 | 3.2–5.6 | IMG_0608 0.0–2.4 | Ruang makan + dapur terbuka | Whip pan + whoosh, "Open kitchen" |
| 3 | 5.6–8.0 | IMG_0598 1.3–3.7 | Chef di bar | |
| 4 | 8.0–11.4 | IMG_0611 21.7–23.45, slow-mo 2× dari 60fps asal | Minuman | "I · First, a toast." + pop |
| 5 | 11.4–14.0 | IMG_0609 5.2–7.8 | Chef close-up | Dip cut, "II · The craft" |
| 6 | 14.0–17.0 | IMG_0605 0.2–3.2 | Tweezers susun sayur | Punch-in, "Precision." + tick |
| 7 | 17.0–19.6 | IMG_0604 9.0–11.6 | Sudu dari bekas sos | "Patience." |
| 8 | 19.6–21.8 | IMG_0604 13.0–15.2 | Sos dituang | "Detail." |
| 9 | 21.8–24.8 | IMG_0622 28.5–31.5 | Minyak hijau | "Finish." |
| 10 | 24.8–28.2 | IMG_0607 2.0–5.4 | Hidangan di kaunter, cahaya jatuh | Bracket emas "Served." + cinematic whoosh |
| 11 | 28.2–29.5 | IMG_0630 3.85–4.5, slow-mo 2× dari 60fps asal | Roti | Course I (slot roll) + pop |
| 12 | 29.5–32.4 | IMG_0630 0.0–2.9 | Ayam | Course II + pop |
| 13 | 32.4–34.9 | IMG_0630 5.1–7.6 | Hidangan ketiga | Course III + pop |
| 14 | 34.9–37.5 | IMG_0607 11.0–13.6 | Teman semeja | "Good food, better company." |
| 15 | 37.5–42.8 | IMG_0638.HEIC (foto) | Kek birthday | Riser → flash + impact, sparkle, "Happy Birthday, Love" |
| 16 | 42.8–47.2 | IMG_0622 43.4–47.8 | Restoran lengang | End card "BLANC · Chef's Table · until next time." |

## Look

- Footage iPhone HDR (HLG) ditukar ke SDR Rec.709, kemudian di-grade dengan `hyperframes media-treatment`: "food-pop" untuk hidangan, shadow lift + warm untuk shot gelap, "night-lift" untuk shot teman; vignette dan film grain halus pada semua shot.
- Tipografi: Playfair Display (serif, italic) dan Inter (label huruf besar dijarakkan), dengan aksen emas `#c9a46a`.

## Edit

Pemboleh ubah dalam `index.html`: `venue` (nama restoran) dan `wish` (ucapan birthday).
Footage (`assets/video/`), foto (`assets/img/`) dan room tone (`assets/audio/`) tidak disertakan dalam repo (saiz besar / media peribadi). Letak semula fail-fail itu untuk render.

```bash
npx hyperframes preview
npx hyperframes render -o blanc-chefs-table.mp4
```

SFX: library bundled HyperFrames (Pixabay Content License), lihat `assets/sfx/CREDITS.md`.
