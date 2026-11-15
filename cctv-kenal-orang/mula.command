#!/bin/bash
# CCTV Rumah: pelancar untuk Mac (sama macam mula.bat di Windows).
# Klik dua kali fail ini dalam Finder. Terminal akan dibuka dan sistem berjalan.
# Untuk berhenti: tekan Ctrl+C dalam Terminal, atau tutup tetingkap Terminal.
#
# Kali pertama ia akan:
#   1. buat venv Python dan pasang pakej (beberapa minit),
#   2. pasang pakej WhatsApp (npm install),
#   3. buat fail tetapan.sh dan buka dalam TextEdit untuk anda isi nombor WhatsApp & kamera.

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # Homebrew (Apple Silicon & Intel)

berhenti () { echo; read -r -p "Tekan Enter untuk tutup..." _; exit "${1:-1}"; }

echo "=== CCTV Rumah ==="

# --- tetapan ---
if [ ! -f tetapan.sh ]; then
  cp tetapan.contoh.sh tetapan.sh
  echo "Fail tetapan.sh telah dibuat. Isi nombor WhatsApp dan alamat kamera, simpan (Cmd+S),"
  echo "kemudian klik dua kali mula.command sekali lagi."
  open -e tetapan.sh
  berhenti 0
fi
KAMERA=(); LAIN=()
# shellcheck disable=SC1091
source ./tetapan.sh || { echo "Ralat dalam tetapan.sh"; berhenti; }
if [ ${#KAMERA[@]} -eq 0 ]; then echo "Tiada kamera dalam tetapan.sh (KAMERA=...)"; berhenti; fi
if grep -q "namapengguna:katalaluan" tetapan.sh; then
  echo "AMARAN: tetapan.sh masih guna contoh 'namapengguna:katalaluan'. Tukar kepada akaun kamera sebenar."
fi

# --- Python ---
# Python terlalu baru (3.14+) belum ada pakej onnxruntime/opencv, jadi utamakan 3.12 / 3.13 / 3.11
if [ ! -x venv/bin/python ]; then
  PY=""
  for v in python3.12 python3.13 python3.11 python3.10; do
    if command -v "$v" >/dev/null; then PY="$v"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "Perlukan Python 3.12. Buka Terminal dan jalankan:  brew install python@3.12"
    echo "kemudian klik dua kali mula.command sekali lagi."; berhenti
  fi
  echo "Kali pertama: sediakan Python ($("$PY" --version)) dan pasang pakej..."
  "$PY" -m venv venv || { echo "Gagal buat venv"; berhenti; }
  venv/bin/python -m pip install --upgrade pip -q
  venv/bin/python -m pip install -r requirements.txt || { rm -rf venv; echo "Gagal pasang pakej Python"; berhenti; }
fi
PY=venv/bin/python

# --- WhatsApp (Node.js) ---
if [ -n "$WHATSAPP_KE" ]; then
  if ! command -v node >/dev/null; then
    echo "AMARAN: Node.js belum dipasang, WhatsApp tidak akan berfungsi. Pasang: brew install node"
  elif [ ! -d whatsapp/node_modules ]; then
    echo "Kali pertama: pasang pakej WhatsApp..."
    (cd whatsapp && npm install --no-fund --no-audit) || echo "AMARAN: npm install gagal"
  fi
fi

# --- jalankan ---
caffeinate -ims -w $$ &          # Mac tidak tidur selagi sistem berjalan (skrin boleh padam)
trap 'echo; echo "Sistem dihentikan."; exit 0' INT TERM

while true; do
  "$PY" cctv_kenal.py pantau "${KAMERA[@]}" "${LAIN[@]}"
  kod=$?
  [ $kod -eq 2 ] && { echo "Pilihan dalam tetapan.sh tidak sah (lihat ralat di atas)."; berhenti; }
  echo "Sistem berhenti (kod $kod). Mula semula dalam 10 saat... (Ctrl+C untuk batal)"
  sleep 10
done
