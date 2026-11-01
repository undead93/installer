import { config } from './config.js';
import { getCloses } from './bybit.js';

/**
 * EMA ala TradingView/Bybit: nilai pertama = SMA bagi N candle pertama,
 * kemudian EMA = close * k + EMA_sebelum * (1 - k), k = 2 / (N + 1).
 */
export function ema(values, period) {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/**
 * Tentukan trend berdasarkan susunan EMA (pendek -> panjang) dan harga.
 *  - UPTREND   : EMA pendek > EMA sederhana > EMA panjang
 *  - DOWNTREND : EMA pendek < EMA sederhana < EMA panjang
 *  - SIDEWAYS  : selain itu (EMA bersilang / bercampur)
 * "Kuat" bila harga juga berada di atas (uptrend) / bawah (downtrend) EMA terpendek.
 */
export function classify(price, emas) {
  const asc = emas.every((v, i) => i === 0 || emas[i - 1] > v); // 7 > 14 > 28
  const desc = emas.every((v, i) => i === 0 || emas[i - 1] < v); // 7 < 14 < 28
  if (asc) return { key: 'up', label: price > emas[0] ? 'UPTREND (kuat)' : 'UPTREND', icon: '🟢' };
  if (desc) return { key: 'down', label: price < emas[0] ? 'DOWNTREND (kuat)' : 'DOWNTREND', icon: '🔴' };
  return { key: 'side', label: 'SIDEWAYS', icon: '🟡' };
}

export function analyse(closes, periods = config.emaPeriods) {
  const price = closes[closes.length - 1];
  const emas = periods.map((p) => ema(closes, p));
  return { price, periods, emas, trend: classify(price, emas) };
}

export async function getTrends() {
  return Promise.all(
    config.timeframes.map(async (tf) => {
      try {
        const closes = await getCloses(tf, 200);
        return { tf, label: config.tfLabel(tf), ...analyse(closes) };
      } catch (err) {
        return { tf, label: config.tfLabel(tf), error: err.message };
      }
    }),
  );
}

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '-');

export function formatTrends(trends) {
  const lines = [];
  for (const t of trends) {
    if (t.error) {
      lines.push(`*${t.label}* ⚠️ gagal ambil data`);
      continue;
    }
    lines.push(`*${t.label}* ${t.trend.icon} ${t.trend.label}`);
    lines.push('   ' + t.periods.map((p, i) => `EMA${p} ${fmt(t.emas[i])}`).join(' | '));
  }
  const ok = trends.filter((t) => !t.error);
  const ups = ok.filter((t) => t.trend.key === 'up').length;
  const downs = ok.filter((t) => t.trend.key === 'down').length;
  let summary = '🟡 Bercampur';
  if (ok.length && ups === ok.length) summary = '🟢 Semua TF uptrend';
  else if (ok.length && downs === ok.length) summary = '🔴 Semua TF downtrend';
  else if (ups > downs) summary = `🟢 Condong naik (${ups}/${ok.length} TF up)`;
  else if (downs > ups) summary = `🔴 Condong turun (${downs}/${ok.length} TF down)`;
  lines.push('', `Rumusan: ${summary}`);
  return lines.join('\n');
}
