#!/usr/bin/env python3
"""CCTV kenal orang - pengecaman wajah untuk kamera CCTV / IP camera / webcam.

Guna OpenCV sahaja (YuNet untuk kesan wajah, SFace untuk kenal wajah).

  python3 cctv_kenal.py daftar                      # daftar wajah dari folder orang/
  python3 cctv_kenal.py pantau --sumber 0           # webcam
  python3 cctv_kenal.py pantau --sumber "rtsp://user:pass@192.168.1.10:554/stream1"
"""
import argparse
import csv
import json
import os
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": "models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": "models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
MIRRORS = [
    "https://github.com/opencv/opencv_zoo/raw/main/",
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/",
]
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
DETECT_WIDTH = 640  # bingkai besar dikecilkan ke lebar ini untuk kesan wajah (lebih laju)


# ---------------------------------------------------------------- model
def pastikan_model():
    MODEL_DIR.mkdir(exist_ok=True)
    for name, rel in MODELS.items():
        dest = MODEL_DIR / name
        if dest.exists() and dest.stat().st_size > 100_000:
            continue
        for base in MIRRORS:
            try:
                print(f"[model] muat turun {name} ...")
                tmp = dest.with_suffix(".part")
                urllib.request.urlretrieve(base + rel, tmp)
                if tmp.stat().st_size > 100_000:
                    tmp.rename(dest)
                    break
                tmp.unlink()
            except Exception as e:  # cuba mirror seterusnya
                print(f"[model]   gagal dari {base}: {e}")
        else:
            sys.exit(f"Tak dapat muat turun {name}. Letak fail itu secara manual dalam {MODEL_DIR}/")


class Enjin:
    def __init__(self, skor_kesan=0.8):
        pastikan_model()
        self.det = cv2.FaceDetectorYN.create(
            str(MODEL_DIR / "face_detection_yunet_2023mar.onnx"), "", (320, 320), skor_kesan, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(
            str(MODEL_DIR / "face_recognition_sface_2021dec.onnx"), "")

    def kesan(self, img):
        """Pulangkan senarai baris wajah (koordinat ikut saiz asal imej)."""
        h, w = img.shape[:2]
        skala = min(1.0, DETECT_WIDTH / w)
        kecil = cv2.resize(img, (int(w * skala), int(h * skala))) if skala < 1 else img
        self.det.setInputSize((kecil.shape[1], kecil.shape[0]))
        _, faces = self.det.detect(kecil)
        if faces is None:
            return []
        faces = faces.copy()
        faces[:, :14] /= skala
        return list(faces)

    def ciri(self, img, face):
        crop = self.rec.alignCrop(img, face)
        f = self.rec.feature(crop).flatten()
        return f / (np.linalg.norm(f) + 1e-9)


# ---------------------------------------------------------------- daftar
def cmd_daftar(a):
    enjin = Enjin()
    folder = Path(a.folder)
    if not folder.is_dir():
        sys.exit(f"Folder {folder} tak wujud. Buat orang/<nama>/gambar.jpg dahulu.")
    nama_list, ciri_list = [], []
    for orang in sorted(p for p in folder.iterdir() if p.is_dir()):
        n = 0
        for img_path in sorted(orang.iterdir()):
            if img_path.suffix.lower() not in IMG_EXT:
                continue
            img = cv2.imread(str(img_path))
            if img is None:
                print(f"  ! tak boleh baca {img_path}")
                continue
            faces = enjin.kesan(img)
            if not faces:
                print(f"  ! tiada wajah dikesan: {img_path}")
                continue
            if len(faces) > 1:
                print(f"  ~ {len(faces)} wajah dalam {img_path.name}, ambil yang paling besar")
            face = max(faces, key=lambda f: f[2] * f[3])
            nama_list.append(orang.name)
            ciri_list.append(enjin.ciri(img, face))
            n += 1
        print(f"{orang.name}: {n} gambar didaftar")
    if not ciri_list:
        sys.exit("Tiada wajah didaftar.")
    np.savez(a.pangkalan, nama=np.array(nama_list), ciri=np.stack(ciri_list))
    print(f"\nSiap: {len(set(nama_list))} orang, {len(ciri_list)} gambar -> {a.pangkalan}")


# ---------------------------------------------------------------- notifikasi
class Telegram:
    def __init__(self):
        self.token = os.environ.get("TELEGRAM_TOKEN")
        self.chat = os.environ.get("TELEGRAM_CHAT_ID")
        self.aktif = bool(self.token and self.chat)

    def hantar(self, teks, img=None):
        if not self.aktif:
            return
        threading.Thread(target=self._hantar, args=(teks, img), daemon=True).start()

    def _hantar(self, teks, img):
        try:
            url = f"https://api.telegram.org/bot{self.token}/"
            if img is None:
                data = json.dumps({"chat_id": self.chat, "text": teks}).encode()
                req = urllib.request.Request(url + "sendMessage", data, {"Content-Type": "application/json"})
            else:
                ok, jpg = cv2.imencode(".jpg", img)
                b = uuid.uuid4().hex
                body = (
                    f"--{b}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{self.chat}\r\n"
                    f"--{b}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{teks}\r\n"
                    f"--{b}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"cctv.jpg\"\r\n"
                    f"Content-Type: image/jpeg\r\n\r\n"
                ).encode() + jpg.tobytes() + f"\r\n--{b}--\r\n".encode()
                req = urllib.request.Request(url + "sendPhoto", body,
                                             {"Content-Type": f"multipart/form-data; boundary={b}"})
            urllib.request.urlopen(req, timeout=15).read()
        except Exception as e:
            print(f"[telegram] gagal: {e}")


# ---------------------------------------------------------------- kamera
class Kamera:
    """Baca bingkai dalam thread supaya sentiasa dapat bingkai terkini (elak lag RTSP)."""

    def __init__(self, sumber):
        self.sumber = int(sumber) if str(sumber).isdigit() else sumber
        self.fail_video = isinstance(self.sumber, str) and Path(self.sumber).is_file()
        self.bingkai, self.tamat = None, False
        self.kunci = threading.Lock()
        self._buka()
        if not self.fail_video:
            threading.Thread(target=self._loop, daemon=True).start()

    def _buka(self):
        if isinstance(self.sumber, str) and self.sumber.startswith("rtsp"):
            os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        self.cap = cv2.VideoCapture(self.sumber)
        if not self.cap.isOpened():
            print(f"[kamera] tak dapat buka {self.sumber}")

    def _loop(self):
        while not self.tamat:
            ok, f = self.cap.read()
            if not ok:
                print("[kamera] sambungan terputus, cuba semula dalam 3 saat ...")
                self.cap.release()
                time.sleep(3)
                self._buka()
                continue
            with self.kunci:
                self.bingkai = f

    def baca(self):
        if self.fail_video:  # fail video: baca berturutan
            ok, f = self.cap.read()
            if not ok:
                self.tamat = True
            return f if ok else None
        with self.kunci:
            f, self.bingkai = self.bingkai, None
        return f

    def tutup(self):
        self.tamat = True
        self.cap.release()


# ---------------------------------------------------------------- pantau
def cmd_pantau(a):
    if not Path(a.pangkalan).exists():
        sys.exit(f"{a.pangkalan} tiada. Jalankan 'daftar' dahulu.")
    db = np.load(a.pangkalan)
    nama_db, ciri_db = db["nama"], db["ciri"]
    print(f"Pangkalan: {len(set(nama_db))} orang ({', '.join(sorted(set(nama_db)))})")

    enjin = Enjin()
    tg = Telegram()
    print("Telegram:", "aktif" if tg.aktif else "tidak aktif (set TELEGRAM_TOKEN & TELEGRAM_CHAT_ID)")
    log_dir = ROOT / "log"
    asing_dir = ROOT / "tangkapan"
    log_dir.mkdir(exist_ok=True)
    asing_dir.mkdir(exist_ok=True)
    log_path = log_dir / f"{datetime.now():%Y-%m-%d}.csv"
    baru = not log_path.exists()
    log_f = open(log_path, "a", newline="")
    log = csv.writer(log_f)
    if baru:
        log.writerow(["masa", "nama", "skor"])

    kali_akhir = {}  # nama -> masa terakhir dilog/notifikasi (untuk cooldown)
    kam = Kamera(a.sumber)
    penulis = None
    print("Memantau... tekan Ctrl+C (atau 'q' dalam tetingkap) untuk berhenti.")
    try:
        while not kam.tamat:
            img = kam.baca()
            if img is None:
                time.sleep(0.01)
                continue
            sekarang = time.time()
            for face in enjin.kesan(img):
                f = enjin.ciri(img, face)
                skor_all = ciri_db @ f  # cosine similarity
                i = int(np.argmax(skor_all))
                skor = float(skor_all[i])
                nama = str(nama_db[i]) if skor >= a.ambang else "TIDAK DIKENALI"
                x, y, w, h = face[:4].astype(int)
                warna = (0, 200, 0) if nama != "TIDAK DIKENALI" else (0, 0, 255)
                cv2.rectangle(img, (x, y), (x + w, y + h), warna, 2)
                cv2.putText(img, f"{nama} {skor:.2f}", (x, max(0, y - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, warna, 2)

                if sekarang - kali_akhir.get(nama, 0) < a.cooldown:
                    continue
                kali_akhir[nama] = sekarang
                masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                log.writerow([masa, nama, f"{skor:.3f}"])
                log_f.flush()
                print(f"{masa}  {nama:<20} skor={skor:.2f}")
                if nama == "TIDAK DIKENALI":
                    p = asing_dir / f"asing_{datetime.now():%Y%m%d_%H%M%S}.jpg"
                    cv2.imwrite(str(p), img)
                    tg.hantar(f"⚠️ Orang tidak dikenali dikesan ({masa})", img)
                elif a.maklum_dikenali:
                    tg.hantar(f"✅ {nama} dikesan ({masa})", img)

            if a.rakam:
                if penulis is None:
                    penulis = cv2.VideoWriter(a.rakam, cv2.VideoWriter_fourcc(*"mp4v"), 15,
                                              (img.shape[1], img.shape[0]))
                penulis.write(img)
            if a.papar:
                cv2.imshow("CCTV kenal orang", img)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        kam.tutup()
        log_f.close()
        if penulis:
            penulis.release()
        if a.papar:
            cv2.destroyAllWindows()
        print(f"\nBerhenti. Log: {log_path}")


def main():
    p = argparse.ArgumentParser(description="CCTV kenal orang")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("daftar", help="daftar wajah dari folder orang/<nama>/")
    d.add_argument("--folder", default=str(ROOT / "orang"))
    d.add_argument("--pangkalan", default=str(ROOT / "pangkalan.npz"))
    d.set_defaults(fn=cmd_daftar)

    m = sub.add_parser("pantau", help="pantau kamera dan kenal orang")
    m.add_argument("--sumber", default="0", help="RTSP URL, nombor webcam (0) atau fail video")
    m.add_argument("--pangkalan", default=str(ROOT / "pangkalan.npz"))
    m.add_argument("--ambang", type=float, default=0.363,
                   help="had skor untuk dikira 'kenal' (tinggi = lebih ketat). Default 0.363")
    m.add_argument("--cooldown", type=float, default=60,
                   help="saat sebelum orang yang sama dilog/dimaklum semula")
    m.add_argument("--papar", action="store_true", help="tunjuk tetingkap video")
    m.add_argument("--rakam", help="simpan video berlabel ke fail .mp4")
    m.add_argument("--maklum-dikenali", action="store_true",
                   help="hantar Telegram juga untuk orang yang dikenali")
    m.set_defaults(fn=cmd_pantau)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
