# Tetapan CCTV Rumah untuk Mac (dibaca oleh mula.command)
#
# mula.command salin fail ini ke "tetapan.sh" kali pertama. Isi tetapan.sh sahaja, jangan ubah fail contoh ini.
# tetapan.sh mengandungi kata laluan kamera: JANGAN kongsi atau upload fail itu.

# Nombor yang terima notifikasi WhatsApp (beberapa nombor/kumpulan dipisah koma)
export WHATSAPP_KE="0123456789"

# Nombor yang boleh tanya bot (siapa / log / gambar) tanpa terima notifikasi. Biar kosong jika tiada.
export WHATSAPP_ADMIN=""

# Kamera: satu baris untuk setiap kamera, "Nama=URL RTSP".
# Tapo: nama pengguna & kata laluan dari Tapo app > kamera > Tetapan > Lanjutan > Akaun Kamera.
KAMERA=(
  --kamera "Pintu Depan=rtsp://namapengguna:katalaluan@192.168.0.106:554/stream1"
  --kamera "Pagar=rtsp://namapengguna:katalaluan@192.168.0.108:554/stream1"
)

# Pilihan tambahan (biar kosong jika tak perlu). Contoh:
#   --ketat                      pengesahan lebih ketat sebelum hantar notifikasi
#   --kata-laluan rahsia123      kunci page web
#   --simpan-klip-jam 24         padam klip selepas 24 jam
LAIN=(
)
