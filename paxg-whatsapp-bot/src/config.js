import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (Node >= 20.12 / 21.7 has process.loadEnvFile built in)
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // tiada .env — guna environment variables / default
}

const env = (key, def) => {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? def : v.trim();
};

const numList = (s) =>
  s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

const TF_LABELS = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1H', 120: '2H', 240: '4H', 360: '6H', 720: '12H', D: '1D' };

export const config = {
  root: ROOT,
  authDir: path.join(ROOT, 'auth'),
  dataFile: path.join(ROOT, 'data', 'alerts.json'),

  ownerNumbers: env('OWNER_NUMBERS', '')
    .split(',')
    .map((x) => x.replace(/\D/g, ''))
    .filter(Boolean),
  pairingNumber: env('PAIRING_NUMBER', '').replace(/\D/g, ''),

  symbol: env('SYMBOL', 'PAXGUSDT').toUpperCase(),
  category: env('CATEGORY', 'linear'),
  bybitBaseUrl: env('BYBIT_BASE_URL', 'https://api.bybit.com').replace(/\/+$/, ''),

  pipSize: Number(env('PIP_SIZE', '0.1')),
  defaultPips: Number(env('DEFAULT_PIPS', '100')),
  pollSeconds: Math.max(1, Number(env('POLL_SECONDS', '5'))),

  emaPeriods: numList(env('EMA_PERIODS', '7,14,28')),
  timeframes: env('TIMEFRAMES', '15,30,60,240')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  tfLabel: (tf) => TF_LABELS[tf] ?? `${tf}m`,

  timezone: env('TIMEZONE', 'Asia/Kuala_Lumpur'),
};
