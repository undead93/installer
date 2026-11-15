#!/bin/bash
# CCTV Rumah: jalan di LATAR BELAKANG di Mac (tanpa tetingkap Terminal), dan mula sendiri bila Mac dihidupkan.
#
#   Klik dua kali (atau: bash latar.command)  -> HIDUPKAN
#   Klik dua kali sekali lagi                  -> MATIKAN
#
# Jalankan mula.command sekurang-kurangnya sekali dahulu (untuk pasang pakej, isi tetapan.sh dan imbas QR WhatsApp).
# Log sistem: log/latar.log   (tengok langsung: tail -f log/latar.log)

cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
LABEL="com.cctvrumah"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$DIR/log/latar.log"

berhenti () { echo; read -r -p "Tekan Enter untuk tutup..." _; exit "${1:-0}"; }

# ---- dipanggil oleh launchd: jalankan sistem
if [ "$1" = "--jalan" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export PYTHONUNBUFFERED=1
  # log tidak membesar tanpa had: kosongkan jika > 5MB
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then : > "$LOG"; fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') CCTV Rumah dimulakan (latar belakang) ==="
  KAMERA=(); LAIN=()
  # shellcheck disable=SC1091
  source ./tetapan.sh
  CAF=(); command -v caffeinate >/dev/null && CAF=(caffeinate -ims)   # Mac tidak tidur
  exec "${CAF[@]}" venv/bin/python cctv_kenal.py pantau "${KAMERA[@]}" "${LAIN[@]}"
fi

echo "=== CCTV Rumah: latar belakang ==="

# ---- sudah hidup? -> matikan
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  echo "DIMATIKAN. Sistem tidak lagi berjalan di latar belakang."
  echo "Untuk hidupkan semula, klik dua kali latar.command sekali lagi."
  berhenti
fi

# ---- semakan
if [ ! -f tetapan.sh ] || [ ! -x venv/bin/python ]; then
  echo "Jalankan mula.command dahulu (sekali) untuk sediakan sistem, kemudian cuba lagi."; berhenti 1
fi
case "$DIR" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
    echo "AMARAN: folder ini dalam Desktop/Documents/Downloads. macOS mungkin menyekat sistem latar belakang"
    echo "daripada membaca fail di situ. Lebih selamat pindahkan folder ke folder Home (Cmd+Shift+H)." ;;
esac
if pgrep -f "cctv_kenal.py pantau" >/dev/null; then
  echo "Sistem sedang berjalan dalam Terminal (mula.command)."
  echo "Hentikan dahulu: pergi ke tetingkap Terminal itu dan tekan Control+C, kemudian cuba lagi."; berhenti 1
fi

# ---- pasang perkhidmatan launchd
mkdir -p "$HOME/Library/LaunchAgents" log
: > "$LOG"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/latar.command</string><string>--jalan</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
launchctl bootstrap "$DOMAIN" "$PLIST" || { rm -f "$PLIST"; echo "Gagal hidupkan perkhidmatan."; berhenti 1; }

echo "DIHIDUPKAN. Sistem berjalan di latar belakang, dan akan mula sendiri setiap kali Mac dihidupkan."
echo "Anda boleh tutup tetingkap ini. Menunggu sistem bermula..."
for _ in $(seq 1 30); do
  sleep 2
  grep -q "Page web:" "$LOG" 2>/dev/null && break
done
echo
grep "Page web:" "$LOG" | tail -1
echo "Log: $LOG   (tengok langsung: tail -f log/latar.log)"
echo "Untuk MATIKAN: klik dua kali latar.command sekali lagi."
berhenti
