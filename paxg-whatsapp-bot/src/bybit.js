// Bybit V5 public market data (tiada API key diperlukan)
import { config } from './config.js';

async function get(pathname, params) {
  const url = `${config.bybitBaseUrl}${pathname}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status} untuk ${pathname}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`Bybit error ${json.retCode}: ${json.retMsg}`);
  return json.result;
}

/** Harga terkini (last traded price) */
export async function getPrice() {
  const result = await get('/v5/market/tickers', { category: config.category, symbol: config.symbol });
  const t = result.list?.[0];
  if (!t) throw new Error(`Simbol ${config.symbol} tidak dijumpai`);
  return {
    last: Number(t.lastPrice),
    mark: Number(t.markPrice),
    high24h: Number(t.highPrice24h),
    low24h: Number(t.lowPrice24h),
    change24hPct: Number(t.price24hPcnt) * 100,
  };
}

/**
 * Candle (kline). Bybit pulangkan paling baru dulu — kita susun lama -> baru.
 * Candle terakhir ialah candle yang sedang berjalan (sama macam chart app Bybit).
 */
export async function getCloses(interval, limit = 200) {
  const result = await get('/v5/market/kline', {
    category: config.category,
    symbol: config.symbol,
    interval: String(interval),
    limit: String(limit),
  });
  return result.list
    .map((k) => ({ time: Number(k[0]), close: Number(k[4]) }))
    .sort((a, b) => a.time - b.time)
    .map((k) => k.close);
}
