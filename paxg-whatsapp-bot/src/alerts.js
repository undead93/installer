// Simpanan alert dalam fail JSON (data/alerts.json)
import fs from 'node:fs';
import path from 'node:path';

const round = (n) => Math.round(n * 1e6) / 1e6;

export class AlertStore {
  constructor(file, { pipSize }) {
    this.file = file;
    this.pipSize = pipSize;
    this.state = { nextId: 1, alerts: [] };
    this.load();
  }

  load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Gagal baca fail alert:', err.message);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Tambah alert: kena bila harga >= base + pips atau <= base - pips */
  add(base, pips, repeat = false) {
    const step = round(pips * this.pipSize);
    const alert = {
      id: this.state.nextId++,
      base,
      pips,
      step,
      upper: round(base + step),
      lower: round(base - step),
      repeat,
      status: 'active',
      createdAt: Date.now(),
      hits: [],
    };
    this.state.alerts.push(alert);
    this.save();
    return alert;
  }

  active() {
    return this.state.alerts.filter((a) => a.status === 'active');
  }

  /** Alert yang sudah kena (atau pernah kena utk mod ulang), terbaru dulu */
  history(limit = 10) {
    return this.state.alerts
      .flatMap((a) => a.hits.map((h) => ({ ...h, id: a.id, pips: a.pips })))
      .sort((x, y) => y.at - x.at)
      .slice(0, limit);
  }

  remove(id) {
    const before = this.state.alerts.length;
    this.state.alerts = this.state.alerts.filter((a) => a.id !== id);
    const removed = this.state.alerts.length !== before;
    if (removed) this.save();
    return removed;
  }

  clearActive() {
    const n = this.active().length;
    this.state.alerts = this.state.alerts.filter((a) => a.status !== 'active');
    this.save();
    return n;
  }

  clearHistory() {
    this.state.alerts = this.state.alerts.filter((a) => a.status === 'active');
    this.state.alerts.forEach((a) => (a.hits = []));
    this.save();
  }

  /**
   * Semak harga terhadap semua alert aktif.
   * Pulangkan senarai kejadian { alert, direction, price, target, base } untuk dihantar.
   */
  check(price, now = Date.now()) {
    const events = [];
    for (const a of this.active()) {
      let direction = null;
      if (price >= a.upper) direction = 'NAIK';
      else if (price <= a.lower) direction = 'TURUN';
      if (!direction) continue;

      const target = direction === 'NAIK' ? a.upper : a.lower;
      const hit = { direction, price, target, base: a.base, at: now };
      a.hits.push(hit);
      events.push({ alert: a, ...hit });

      if (a.repeat) {
        // Mod ulang: harga asal baru = paras yang baru dicapai, terus pantau 100 pip seterusnya
        a.base = target;
        a.upper = round(target + a.step);
        a.lower = round(target - a.step);
      } else {
        a.status = 'triggered';
        a.triggeredAt = now;
      }
    }
    if (events.length) this.save();
    return events;
  }
}
