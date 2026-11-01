// Sambungan WhatsApp guna Baileys (login sebagai "Linked device", macam WhatsApp Web)
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  jidDecode,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const userOf = (jid) => (jid ? jidDecode(jid)?.user ?? null : null);

export class WhatsApp {
  /**
   * @param {object} opts
   * @param {string} opts.authDir
   * @param {string[]} opts.ownerNumbers
   * @param {string} [opts.pairingNumber]
   * @param {(text: string, ctx: {jid: string, selfChat: boolean}) => Promise<string|null>} opts.onCommand
   */
  constructor({ authDir, ownerNumbers, pairingNumber, onCommand }) {
    this.authDir = authDir;
    this.ownerNumbers = ownerNumbers;
    this.pairingNumber = pairingNumber;
    this.onCommand = onCommand;
    this.sock = null;
    this.connected = false;
    this.outbox = []; // mesej yang menunggu sambungan
    this.sentIds = new Set(); // elak bot proses balasan sendiri dalam self-chat
    this.startedAt = Math.floor(Date.now() / 1000);
    this.pairingRequested = false;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* guna versi default Baileys */
    }

    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        if (this.pairingNumber && !sock.authState.creds.registered) {
          if (!this.pairingRequested) {
            this.pairingRequested = true;
            try {
              const code = await sock.requestPairingCode(this.pairingNumber);
              console.log(`\n🔑 PAIRING CODE: ${code}`);
              console.log('   WhatsApp > Peranti dipaut > Paut peranti > Paut dengan nombor telefon\n');
            } catch (err) {
              console.error('Gagal minta pairing code:', err.message);
            }
          }
        } else {
          console.log('\n📱 Scan QR ini: WhatsApp > Peranti dipaut (Linked devices) > Paut peranti\n');
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === 'open') {
        this.connected = true;
        console.log(`✅ WhatsApp bersambung sebagai ${userOf(sock.user?.id)}`);
        this.flush();
      }

      if (connection === 'close') {
        this.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error('❌ WhatsApp log keluar. Padam folder "auth" dan jalankan semula untuk scan QR baru.');
          process.exit(1);
        }
        console.log(`⚠️ Sambungan WhatsApp terputus (kod ${code ?? '-'}), sambung semula dalam 3 saat...`);
        setTimeout(() => this.start().catch((e) => console.error(e)), 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) this.handleIncoming(m).catch((e) => console.error('Ralat proses mesej:', e));
    });
  }

  /** Nombor & LID akaun bot sendiri */
  selfUsers() {
    return [userOf(this.sock?.user?.id), userOf(this.sock?.user?.lid)].filter(Boolean);
  }

  async handleIncoming(m) {
    if (!m.message || !m.key?.remoteJid) return;
    if (this.sentIds.has(m.key.id)) return;
    if (Number(m.messageTimestamp ?? 0) < this.startedAt - 30) return; // abaikan mesej lama

    const jid = m.key.remoteJid;
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

    const content = normalizeMessageContent(m.message);
    const text = content?.conversation || content?.extendedTextMessage?.text;
    if (!text) return;

    // Siapa penghantar? WhatsApp baru guna LID (ID rahsia @lid) instead of nombor telefon,
    // jadi semak remoteJidAlt dan tukar LID -> nombor guna jadual LID Baileys.
    const chatUsers = [userOf(jid), userOf(m.key.remoteJidAlt)].filter(Boolean);
    if (jid.endsWith('@lid')) {
      try {
        const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
        if (pn) chatUsers.push(userOf(pn));
      } catch {
        /* abaikan */
      }
    }
    const self = this.selfUsers();
    const selfChat = chatUsers.some((u) => self.includes(u));

    let allowed;
    if (m.key.fromMe) {
      allowed = selfChat; // mesej yang kita taip sendiri hanya dalam "Message yourself"
    } else {
      allowed = chatUsers.some((u) => this.ownerNumbers.includes(u));
    }

    const from = m.key.fromMe ? 'saya sendiri' : chatUsers.join(' / ');
    console.log(`📩 Mesej dari ${from}: "${text.slice(0, 40)}" → ${allowed ? 'DIPROSES' : 'DIABAIKAN (bukan owner)'}`);
    if (!allowed) {
      if (!m.key.fromMe)
        console.log(`   Kalau ini nombor anda, letak dalam .env: OWNER_NUMBERS=${chatUsers.find((u) => u.startsWith('6')) ?? chatUsers[0]}`);
      return;
    }

    const reply = await this.onCommand(text, { jid, selfChat });
    if (reply) await this.sendTo(jid, reply);
  }

  async sendTo(jid, text) {
    if (!this.connected) {
      this.outbox.push({ jid, text });
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text });
      if (sent?.key?.id) {
        this.sentIds.add(sent.key.id);
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value);
      }
    } catch (err) {
      console.error('Gagal hantar mesej, cuba semula nanti:', err.message);
      this.outbox.push({ jid, text });
    }
  }

  /** Hantar ke semua owner (atau ke self-chat jika OWNER_NUMBERS kosong) */
  async broadcast(text) {
    const targets = this.ownerNumbers.length
      ? this.ownerNumbers.map((n) => `${n}@s.whatsapp.net`)
      : [null]; // null = self, diselesaikan bila bersambung
    for (const t of targets) {
      const jid = t ?? (this.sock?.user?.id ? `${userOf(this.sock.user.id)}@s.whatsapp.net` : null);
      if (jid) await this.sendTo(jid, text);
      else this.outbox.push({ jid: null, text });
    }
  }

  async flush() {
    const pending = this.outbox.splice(0);
    for (const { jid, text } of pending) {
      const target = jid ?? `${userOf(this.sock.user.id)}@s.whatsapp.net`;
      await this.sendTo(target, text);
    }
  }
}
