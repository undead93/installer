// Senyapkan log dalaman libsignal (Baileys) seperti "Closing session: SessionEntry {...}".
// Log ni tak berbahaya tapi panjang dan mengandungi kunci sesi, jadi tak perlu dipaparkan.
const NOISE = [
  'Closing session',
  'Opening session',
  'Removing old closed session',
  'Closing open session',
  'Session already',
  'Decrypted message with closed session',
  'Migrating session to',
];

for (const level of ['log', 'info', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && NOISE.some((n) => args[0].startsWith(n))) return;
    original(...args);
  };
}
