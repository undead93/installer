// Proses arahan yang dihantar melalui WhatsApp
import { formatTrends } from './trend.js';

export function makeFormatter(timezone) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return {
    time: (ms) => dtf.format(new Date(ms)).replace(',', ''),
    price: (n) => (Number.isFinite(n) ? n.toFixed(2) : '-'),
  };
}

export function helpText(cfg) {
  return [
    `🤖 *BOT ALERT ${cfg.symbol}* (Bybit Futures)`,
    '',
    `*set 2650* — alert bila harga naik/turun ${cfg.defaultPips} pip dari 2650`,
    '*set 2650 50* — guna jarak 50 pip',
    '*set 2650 ulang* — alert berterusan setiap 100 pip',
    '*list* — senarai alert aktif + yang dah kena',
    '*padam 3* — padam alert #3',
    '*padam semua* — padam semua alert aktif',
    '*sejarah padam* — kosongkan sejarah alert',
    '*trend* — trend 15m / 30m / 1H / 4H + EMA',
    '*harga* — harga semasa + alert aktif + trend',
    '*menu* — papar menu ini',
    '',
    `ℹ️ 1 pip = ${cfg.pipSize} → ${cfg.defaultPips} pip = ${(cfg.defaultPips * cfg.pipSize).toFixed(2)} USDT`,
  ].join('\n');
}

export function formatAlertEvent(ev, cfg, f) {
  const arrow = ev.direction === 'NAIK' ? '⬆️' : '⬇️';
  const icon = ev.direction === 'NAIK' ? '🚀' : '🔻';
  return [
    `${icon} *ALERT ${cfg.symbol} ${ev.direction} ${ev.alert.pips} PIP* (#${ev.alert.id})`,
    '',
    `Harga sekarang: *${f.price(ev.price)}*`,
    `Harga asal: ${f.price(ev.base)}`,
    `Sasaran ${arrow}: ${f.price(ev.target)}`,
    `Masa: ${f.time(ev.at)}`,
    ev.alert.repeat
      ? `🔁 Mod ulang — pantau seterusnya ⬆️ ${f.price(ev.alert.upper)} / ⬇️ ${f.price(ev.alert.lower)}`
      : '✅ Alert ini selesai.',
  ].join('\n');
}

function formatList(store, f) {
  const active = store.active();
  const lines = [`📋 *SENARAI ALERT* — aktif: ${active.length}`];
  if (!active.length) lines.push('_(tiada alert aktif — taip "set 2650")_');
  for (const a of active) {
    lines.push(
      '',
      `*#${a.id}* Harga ${f.price(a.base)} ±${a.pips} pip${a.repeat ? ' 🔁' : ''}`,
      `   ⬆️ ${f.price(a.upper)}  |  ⬇️ ${f.price(a.lower)}`,
      `   Dibuat: ${f.time(a.createdAt)}`,
    );
  }
  const hist = store.history(10);
  if (hist.length) {
    lines.push('', '✅ *Sudah kena (10 terkini):*');
    for (const h of hist) {
      const arrow = h.direction === 'NAIK' ? '⬆️' : '⬇️';
      lines.push(`#${h.id} ${f.price(h.base)} ${arrow} ${h.direction} @ ${f.price(h.price)} — ${f.time(h.at)}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {string} text  mesej masuk
 * @param {object} deps  { store, cfg, getPrice, getTrends }
 * @returns {Promise<string|null>} balasan, atau null jika bukan arahan
 */
export async function handleCommand(text, { store, cfg, getPrice, getTrends }) {
  const f = makeFormatter(cfg.timezone);
  const parts = text.trim().toLowerCase().replace(/,/g, '').split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'menu':
    case 'help':
    case 'bantuan':
      return helpText(cfg);

    case 'set':
    case 'alert':
    case 'a': {
      const base = Number(args[0]);
      if (!Number.isFinite(base) || base <= 0) return '❌ Format: *set 2650* atau *set 2650 50* atau *set 2650 ulang*';
      const repeat = args.includes('ulang') || args.includes('repeat');
      const pipArg = args.slice(1).find((x) => /^\d+(\.\d+)?$/.test(x));
      const pips = pipArg ? Number(pipArg) : cfg.defaultPips;
      if (!(pips > 0)) return '❌ Jumlah pip mesti lebih dari 0';
      const a = store.add(base, pips, repeat);
      let now = '';
      try {
        now = `\nHarga semasa: ${f.price((await getPrice()).last)}`;
      } catch {
        /* abaikan */
      }
      return [
        `✅ Alert *#${a.id}* ditambah${repeat ? ' (🔁 ulang)' : ''}`,
        `Harga asal: ${f.price(a.base)} (±${a.pips} pip = ${f.price(a.step)})`,
        `⬆️ Naik: ${f.price(a.upper)}`,
        `⬇️ Turun: ${f.price(a.lower)}${now}`,
      ].join('\n');
    }

    case 'list':
    case 'senarai':
    case 'ls':
      return formatList(store, f);

    case 'padam':
    case 'del':
    case 'delete':
    case 'buang': {
      if (args[0] === 'semua' || args[0] === 'all') return `🗑️ ${store.clearActive()} alert aktif dipadam.`;
      const id = Number(String(args[0] ?? '').replace('#', ''));
      if (!Number.isInteger(id)) return '❌ Format: *padam 3* atau *padam semua*';
      return store.remove(id) ? `🗑️ Alert #${id} dipadam.` : `❌ Alert #${id} tidak dijumpai.`;
    }

    case 'clear':
      return `🗑️ ${store.clearActive()} alert aktif dipadam.`;

    case 'sejarah':
    case 'history':
      if (args[0] === 'padam' || args[0] === 'clear') {
        store.clearHistory();
        return '🗑️ Sejarah alert dikosongkan.';
      }
      return formatList(store, f);

    case 'harga':
    case 'price':
    case 'p': {
      // Harga + alert aktif (jarak ke sasaran) + trend, dalam satu mesej
      const [p, trends] = await Promise.all([getPrice(), getTrends().catch(() => null)]);
      const sign = p.change24hPct >= 0 ? '+' : '';
      const pipsTo = (target) => Math.abs(target - p.last) / cfg.pipSize;
      const lines = [
        `💰 *${cfg.symbol}* (Bybit Futures) — ${f.time(Date.now())}`,
        `Last: *${f.price(p.last)}*   Mark: ${f.price(p.mark)}`,
        `24j: H ${f.price(p.high24h)} / L ${f.price(p.low24h)} (${sign}${p.change24hPct.toFixed(2)}%)`,
        '',
      ];
      const active = store.active();
      lines.push(`🔔 *Alert aktif: ${active.length}*`);
      if (!active.length) lines.push('_(tiada — taip "set 2650")_');
      for (const a of active) {
        lines.push(
          `*#${a.id}* ${f.price(a.base)} ±${a.pips} pip${a.repeat ? ' 🔁' : ''}`,
          `   ⬆️ ${f.price(a.upper)} (lagi ${pipsTo(a.upper).toFixed(0)} pip)  |  ⬇️ ${f.price(a.lower)} (lagi ${pipsTo(a.lower).toFixed(0)} pip)`,
        );
      }
      lines.push('', '📊 *Trend:*', trends ? formatTrends(trends) : '⚠️ gagal ambil data trend');
      return lines.join('\n');
    }

    case 'trend':
    case 'tren':
    case 't': {
      const [p, trends] = await Promise.all([getPrice().catch(() => null), getTrends()]);
      return [
        `📊 *TREND ${cfg.symbol}* — ${f.time(Date.now())}`,
        p ? `Harga: *${f.price(p.last)}*` : '',
        '',
        formatTrends(trends),
      ]
        .filter((x, i) => x !== '' || i === 2)
        .join('\n');
    }

    default:
      return null;
  }
}
