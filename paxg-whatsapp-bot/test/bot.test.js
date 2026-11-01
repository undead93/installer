import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ema, classify, analyse, formatTrends } from '../src/trend.js';
import { AlertStore } from '../src/alerts.js';
import { handleCommand } from '../src/commands.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paxg-')), 'alerts.json');

const cfg = {
  symbol: 'PAXGUSDT',
  pipSize: 0.1,
  defaultPips: 100,
  timezone: 'Asia/Kuala_Lumpur',
};

test('EMA: seed SMA kemudian smoothing', () => {
  assert.equal(ema([1, 2, 3], 3), 2);
  // k = 0.5 utk period 3: 2*0.5 + 4*0.5 = 3
  assert.equal(ema([1, 2, 3, 4], 3), 3);
  assert.ok(Number.isNaN(ema([1, 2], 3)));
});

test('classify trend ikut susunan EMA', () => {
  assert.equal(classify(105, [104, 102, 100]).key, 'up');
  assert.equal(classify(105, [104, 102, 100]).label, 'UPTREND (kuat)');
  assert.equal(classify(103, [104, 102, 100]).label, 'UPTREND');
  assert.equal(classify(95, [96, 98, 100]).key, 'down');
  assert.equal(classify(100, [101, 99, 100]).key, 'side');
});

test('analyse: siri naik = uptrend', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 2000 + i);
  const r = analyse(closes, [7, 14, 28]);
  assert.equal(r.trend.key, 'up');
  assert.ok(r.emas[0] > r.emas[1] && r.emas[1] > r.emas[2]);
  const out = formatTrends([{ label: '15m', ...r }, { label: '1H', error: 'x' }]);
  assert.match(out, /15m\* 🟢 UPTREND/);
  assert.match(out, /EMA7 .* \| EMA14 .* \| EMA28/);
  assert.match(out, /1H\* ⚠️/);
});

test('alert: 100 pip = 10 USDT, kena sekali sahaja', () => {
  const s = new AlertStore(tmpFile(), { pipSize: 0.1 });
  const a = s.add(2650, 100);
  assert.equal(a.upper, 2660);
  assert.equal(a.lower, 2640);
  assert.equal(s.check(2659.99).length, 0);
  const ev = s.check(2660.5);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].direction, 'NAIK');
  assert.equal(s.active().length, 0);
  assert.equal(s.check(2700).length, 0);
  assert.equal(s.history().length, 1);
});

test('alert: turun & mod ulang', () => {
  const file = tmpFile();
  const s = new AlertStore(file, { pipSize: 0.1 });
  s.add(2650, 100, true);
  assert.equal(s.check(2639)[0].direction, 'TURUN');
  const a = s.active()[0];
  assert.equal(a.base, 2640);
  assert.equal(a.lower, 2630);
  assert.equal(a.upper, 2650);
  // disimpan dalam fail & boleh dibaca semula
  const s2 = new AlertStore(file, { pipSize: 0.1 });
  assert.equal(s2.active()[0].base, 2640);
  assert.equal(s2.history().length, 1);
});

test('arahan WhatsApp', async () => {
  const store = new AlertStore(tmpFile(), { pipSize: 0.1 });
  const deps = {
    store,
    cfg,
    getPrice: async () => ({ last: 2651.23, mark: 2651.2, high24h: 2670, low24h: 2630, change24hPct: 0.5 }),
    getTrends: async () => [
      { label: '15m', ...analyse(Array.from({ length: 50 }, (_, i) => 2600 + i), [7, 14, 28]) },
    ],
  };

  let r = await handleCommand('set 2,650', deps);
  assert.match(r, /#1/);
  assert.match(r, /2660\.00/);
  assert.match(r, /2640\.00/);
  assert.match(r, /2651\.23/);

  r = await handleCommand('SET 2700 50 ulang', deps);
  assert.match(r, /2705\.00/);
  assert.match(r, /ulang/);

  assert.match(r, /Alert lama #1 \(2650\.00\) diganti/);

  // hanya satu alert aktif
  r = await handleCommand('list', deps);
  assert.match(r, /aktif: 1/);
  assert.match(r, /#2.*🔁/);
  assert.doesNotMatch(r, /\*#1\*/);

  store.check(2706);
  r = await handleCommand('senarai', deps);
  assert.match(r, /Sudah kena/);
  assert.match(r, /NAIK @ 2706\.00/);

  assert.match(await handleCommand('padam', deps), /1 alert aktif dipadam/);
  assert.match(await handleCommand('padam 9', deps), /tidak dijumpai/);
  assert.match(await handleCommand('trend', deps), /15m\* 🟢 UPTREND/);
  r = await handleCommand('harga', deps);
  assert.match(r, /2651\.23/);
  assert.match(r, /Alert aktif: 0/);
  assert.match(r, /15m\* 🟢 UPTREND/);
  store.add(2650, 100);
  r = await handleCommand('harga', deps);
  assert.match(r, /Alert aktif: 1/);
  assert.match(r, /2660\.00 \(lagi 88 pip\).*2640\.00 \(lagi 112 pip\)/);
  assert.match(await handleCommand('set abc', deps), /Format/);
  assert.equal(await handleCommand('hello', deps), null);
});
