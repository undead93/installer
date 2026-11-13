// All user-facing bot text (Bahasa Melayu).
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

export function menu(p, inGroup = false) {
  return [
    '🎬 *TikTok HD Bot*',
    '',
    `Hantar video sebagai *DOKUMEN*${inGroup ? ' dalam group ini' : ''} (📎 → Dokumen → pilih video).`,
    'Bot balas dengan dokumen yang sudah siap convert untuk TikTok HD.',
    '',
    '*Pilihan* (tulis pada kapsyen dokumen, atau reply video):',
    `• ${p}max — 4K 2160p 30fps (lalai)`,
    `• ${p}hd — 1080p 30fps (lebih laju)`,
    `• ${p}keep — kekal resolusi asal`,
    `• ${p}info — semak video sedia TikTok HD atau tidak`,
    `• ${p}status — lihat barisan giliran`,
    `Tambah *60* untuk 60fps, contoh: ${p}max 60`,
    '',
    `⚠️ Video biasa (bukan dokumen) sudah dimampat WhatsApp${inGroup ? ` — dalam group, reply video itu dengan *${p}max* kalau tetap mahu proses` : ''}.`,
  ].join('\n');
}

export const needMedia = (p, cmd) => `Hantar video sebagai dokumen dengan kapsyen *${p}${cmd}*, atau reply video/dokumen dengan *${p}${cmd}*.`;
export const notVideo = () => 'Fail itu bukan video. Hantar fail .mov / .mp4.';
export const tooBig = (size, max) => `Fail terlalu besar (${mb(size)}). Had: ${max} MB.`;
export const tooLong = (sec, max) => `Video terlalu panjang (${Math.round(sec)}s). Had: ${max}s.`;
export const alreadyQueued = (pos) => (pos === 0 ? '⏳ Video anda sedang diproses, tunggu sekejap.' : `⏳ Anda sudah dalam barisan (no. ${pos}).`);
export const queued = (pos) => `📥 Diterima. Giliran anda: no. ${pos}.`;
export const compressedWarning = () =>
  '⚠️ Video ini dihantar sebagai *video biasa*, jadi WhatsApp sudah mampatkannya. Untuk hasil terbaik, hantar fail asal sebagai *DOKUMEN*. Saya tetap proses yang ini.';
export const downloading = () => '⬇️ Memuat turun video...';
export const failed = (msg) => `❌ Gagal: ${msg}`;

export function progress(stage, percent, fps) {
  const pct = Number.isFinite(Number(percent)) && percent !== null ? Math.max(0, Math.min(100, Number(percent))) : 0;
  const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░');
  const label = stage === 'mux' ? 'Menyusun fail' : 'Encode video';
  return `⚙️ ${label}\n${bar} ${pct.toFixed(0)}%${fps ? ` • ${fps} fps` : ''}`;
}

export function status(queue) {
  return `📊 Sedang diproses: ${queue.busy} • Dalam barisan: ${queue.length}`;
}

function describeVideo(v) {
  if (!v) return '-';
  const hdr = v.hdr ? ` HDR-${v.hdr.toUpperCase()}${v.dolbyVision ? '+DV' : ''}` : ' SDR';
  return `${String(v.codec).toUpperCase()} ${v.width}x${v.height} ${Math.round(v.fps)}fps${hdr}`;
}

export function done(res) {
  const r = res.result;
  const i = res.input;
  const lines = [
    `✅ *Siap!* (${Math.round(res.seconds)}s)`,
    `📥 Asal: ${describeVideo(i.video)}, ${mb(i.size)}${i.device ? ` • ${i.device}` : ''}`,
    `📤 Hasil: H.264 ${r.width}x${r.height} ${res.plan.fps}fps SDR, ${(r.bitrate / 1e6).toFixed(1)} Mbps, ${mb(r.size)}`,
  ];
  if (i.appleTracks) lines.push(`🧩 Metadata kamera iPhone dikekalkan (${i.appleTracks} trek${i.spatialAudio ? ' + Spatial Audio' : ''})`);
  if (i.hadGps) lines.push('🔒 Lokasi GPS & info peranti dibuang');
  lines.push(
    '',
    '*Cara upload:*',
    '1. Buka dokumen ini → Kongsi → *Simpan Video* (masuk galeri)',
    '2. TikTok → + → pilih video dari galeri',
    '3. Sebelum post: *Lagi pilihan* → hidupkan *Upload HD / kualiti tinggi*',
    '4. Jangan tambah filter/teks dalam editor TikTok (TikTok akan encode semula)',
  );
  return lines.join('\n');
}
