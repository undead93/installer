import { config } from './config.js';
import { getPrice } from './bybit.js';
import { getTrends, formatTrends } from './trend.js';
import { AlertStore } from './alerts.js';
import { handleCommand, formatAlertEvent, makeFormatter } from './commands.js';
import { WhatsApp } from './whatsapp.js';

const store = new AlertStore(config.dataFile, { pipSize: config.pipSize });
const f = makeFormatter(config.timezone);
const deps = { store, cfg: config, getPrice, getTrends };

const wa = new WhatsApp({
  authDir: config.authDir,
  ownerNumbers: config.ownerNumbers,
  pairingNumber: config.pairingNumber,
  onCommand: async (text, { selfChat }) => {
    try {
      const reply = await handleCommand(text, deps);
      if (reply === null && !selfChat) return 'Arahan tidak dikenali. Taip *menu* untuk senarai arahan.';
      return reply;
    } catch (err) {
      console.error('Ralat arahan:', err);
      return `⚠️ Ralat: ${err.message}`;
    }
  },
});

// ---- Pantau harga & hantar alert ----
let checking = false;
let failCount = 0;

async function tick() {
  if (checking || store.active().length === 0) return;
  checking = true;
  try {
    const { last } = await getPrice();
    failCount = 0;
    const events = store.check(last);
    if (events.length) {
      // Sertakan trend EMA dalam alert
      const trends = await getTrends().catch(() => null);
      for (const ev of events) {
        console.log(`🚨 Alert #${ev.alert.id} ${ev.direction} @ ${ev.price}`);
        let msg = formatAlertEvent(ev, config, f);
        if (trends) msg += `\n\n📊 *Trend semasa:*\n${formatTrends(trends)}`;
        await wa.broadcast(msg);
      }
    }
  } catch (err) {
    failCount++;
    if (failCount === 1 || failCount % 60 === 0) console.error(`Gagal ambil harga (x${failCount}):`, err.message);
  } finally {
    checking = false;
  }
}

console.log(`▶️ Bot alert ${config.symbol} (${config.category}) — 1 pip = ${config.pipSize}, semak setiap ${config.pollSeconds}s`);
console.log(`   Owner: ${config.ownerNumbers.join(', ') || '(self-chat)'} | Alert aktif: ${store.active().length}`);

await wa.start();
setInterval(tick, config.pollSeconds * 1000);

// Mesej sambutan sekali bila bot mula (selepas WhatsApp bersambung)
wa.broadcast(`✅ Bot ${config.symbol} aktif. Alert aktif: ${store.active().length}\nTaip *menu* untuk senarai arahan.`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
