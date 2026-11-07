#!/usr/bin/env python3
"""CCTV kenal orang - pengecaman wajah untuk CCTV / IP camera / webcam, dengan page web.

Guna OpenCV sahaja (YuNet untuk kesan wajah, SFace untuk kenal wajah).

  python3 cctv_kenal.py pantau --sumber "rtsp://user:pass@192.168.1.25:554/stream1"
  # kemudian buka http://<IP-komputer>:8000 dari telefon untuk namakan wajah

  python3 cctv_kenal.py daftar     # proses gambar yang anda letak sendiri dalam orang/<nama>/
"""
import argparse
import atexit
import base64
import bisect
import csv
import json
import os
import re
import shutil
import ipaddress
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Senyapkan mesej penyahkod FFmpeg (cth "[h264] error while decoding MB") yang keluar bila paket video
# rosak/hilang (WiFi lemah). Bingkai tetap dibaca; set OPENCV_FFMPEG_LOGLEVEL=24 untuk lihat semula.
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
ORANG = ROOT / "orang"            # orang berdaftar: orang/<nama>/*.jpg
WAJAH_BARU = ROOT / "wajah_baru"  # wajah tidak dikenali, dikumpul ikut orang: wajah_baru/<id>/*.jpg
LOG_DIR = ROOT / "log"
TANGKAPAN = ROOT / "tangkapan"    # gambar penuh semasa orang tidak dikenali dikesan
KLIP_DIR = ROOT / "klip"          # klip video yang dihantar bersama notifikasi
HALAMAN = ROOT / "halaman.html"
WA_DIR = ROOT / "whatsapp"         # penghantar WhatsApp (Baileys, Node.js)
TETAPAN = ROOT / "tetapan.json"
STATUS = ROOT / "status.json"      # siapa di rumah: arah & masa terakhir setiap orang
# arah kamera: tetap (masuk/keluar), ikut saiz wajah (kamera menghadap laluan),
# atau ikut gerakan kiri/kanan dalam video (kamera di sisi laluan)
ARAH_SAH = ("tiada", "masuk", "keluar", "gerak_masuk", "gerak_keluar", "kanan_masuk", "kiri_masuk")
MOD_GERAK = ("gerak_masuk", "gerak_keluar", "kanan_masuk", "kiri_masuk")

MODELS = {
    "face_detection_yunet_2023mar.onnx": "models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": "models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
MIRRORS = [
    "https://github.com/opencv/opencv_zoo/raw/main/",
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/",
]
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VERSI = "2026.11.07d"  # dipaparkan dalam terminal & page web, untuk sahkan versi yang sedang berjalan
DETECT_WIDTH = 1280  # bingkai besar dikecilkan ke lebar ini untuk kesan wajah (640 terlepas wajah <~135px pada 2K)
NAMA_SAH = re.compile(r"^[\w][\w .'-]{0,39}$")


def slug(teks):
    return re.sub(r"[^\w-]+", "_", teks).strip("_") or "kamera"


def senarai_gambar(folder):
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMG_EXT) if folder.is_dir() else []


AKHIRAN_CIRI = {"sface": ".npy", "arcface": ".arc.npy"}  # cap jari wajah disimpan berasingan bagi setiap model
_akhiran_semasa = [".npy"]


def fail_ciri(img_path):
    """Fail cap jari wajah untuk model yang sedang digunakan."""
    return img_path.with_name(img_path.name + _akhiran_semasa[0])


def pindah_ciri(src, dst):
    """Pindah fail cap jari (semua model) bersama gambarnya."""
    for a in AKHIRAN_CIRI.values():
        f = src.with_name(src.name + a)
        if f.exists():
            shutil.move(str(f), str(dst.with_name(dst.name + a)))


def padam_ciri(img_path):
    for a in AKHIRAN_CIRI.values():
        img_path.with_name(img_path.name + a).unlink(missing_ok=True)


def ip_lan():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # tiada paket dihantar; cuma untuk tahu IP rangkaian rumah
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "localhost"


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
    """SFace (OpenCV): ringan."""
    nama, dim = "sface", 128

    def __init__(self, skor_kesan=0.8, lebar_kesan=DETECT_WIDTH):
        pastikan_model()
        self.lebar_kesan = lebar_kesan
        self.kunci = threading.Lock()  # model OpenCV tidak selamat diguna serentak oleh beberapa thread
        self.det = cv2.FaceDetectorYN.create(
            str(MODEL_DIR / "face_detection_yunet_2023mar.onnx"), "", (320, 320), skor_kesan, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(
            str(MODEL_DIR / "face_recognition_sface_2021dec.onnx"), "")

    def kesan(self, img):
        """Pulangkan senarai baris wajah (koordinat ikut saiz asal imej)."""
        h, w = img.shape[:2]
        skala = min(1.0, self.lebar_kesan / w)
        kecil = cv2.resize(img, (int(w * skala), int(h * skala))) if skala < 1 else img
        with self.kunci:
            self.det.setInputSize((kecil.shape[1], kecil.shape[0]))
            _, faces = self.det.detect(kecil)
        if faces is None:
            return []
        faces = faces.copy()
        faces[:, :14] /= skala
        return list(faces)

    def ciri(self, img, face):
        with self.kunci:
            crop = self.rec.alignCrop(img, face)
            f = self.rec.feature(crop).flatten()
        return (f / (np.linalg.norm(f) + 1e-9)).astype(np.float32)

    def ciri_gambar(self, img):
        """Ciri wajah paling besar dalam gambar, atau None jika tiada wajah."""
        faces = self.kesan(img)
        if not faces:
            return None
        return self.ciri(img, max(faces, key=lambda f: f[2] * f[3]))


ARC_ZIP = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
ARC_FAIL = ("det_10g.onnx", "w600k_r50.onnx")
# kedudukan standard 5 titik wajah (mata, hidung, mulut) dalam gambar 112x112 untuk ArcFace
ARC_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                    [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)


def pastikan_model_arcface():
    d = MODEL_DIR / "buffalo_l"
    d.mkdir(parents=True, exist_ok=True)
    if all((d / f).exists() and (d / f).stat().st_size > 1_000_000 for f in ARC_FAIL):
        return d
    print("[model] muat turun model ArcFace + SCRFD (InsightFace buffalo_l, ~290MB, sekali sahaja) ...")
    tmp = d / "buffalo_l.zip.part"
    langkah = [0]

    def kemajuan(blok, saiz, jumlah):
        if jumlah > 0 and blok * saiz * 10 // jumlah > langkah[0]:
            langkah[0] = blok * saiz * 10 // jumlah
            print(f"[model]   {min(100, langkah[0] * 10)}%")
    urllib.request.urlretrieve(ARC_ZIP, tmp, kemajuan)
    with zipfile.ZipFile(tmp) as z:
        for f in ARC_FAIL:
            nama = next(n for n in z.namelist() if n.endswith(f))
            with z.open(nama) as src, open(d / f, "wb") as dst:
                shutil.copyfileobj(src, dst)
    tmp.unlink()
    return d


class EnjinArcFace:
    """SCRFD (kesan wajah) + ArcFace R50 (kenal wajah) dari InsightFace, melalui onnxruntime.
    Lebih tepat dari SFace, terutama untuk wajah kecil/condong; lebih berat. Model: kegunaan bukan komersial."""
    nama, dim = "arcface", 512

    def __init__(self, skor_kesan=0.5, lebar_kesan=DETECT_WIDTH):
        import onnxruntime as ort
        d = pastikan_model_arcface()
        so = ort.SessionOptions()
        so.log_severity_level = 3
        pv = ["CPUExecutionProvider"]
        self.det = ort.InferenceSession(str(d / "det_10g.onnx"), so, providers=pv)
        self.rec = ort.InferenceSession(str(d / "w600k_r50.onnx"), so, providers=pv)
        self.det_in, self.rec_in = self.det.get_inputs()[0].name, self.rec.get_inputs()[0].name
        self.skor_kesan, self.lebar_kesan = skor_kesan, lebar_kesan
        self.kunci = threading.Lock()

    def kesan(self, img):
        h, w = img.shape[:2]
        if w > self.lebar_kesan:
            skala = self.lebar_kesan / w
        elif max(w, h) < 640:
            skala = 640 / max(w, h)  # gambar kecil (cth potongan wajah) dibesarkan supaya wajah dikesan
        else:
            skala = 1.0
        nw, nh = max(1, int(w * skala)), max(1, int(h * skala))
        W32, H32 = -(-nw // 32) * 32, -(-nh // 32) * 32
        kanvas = np.zeros((H32, W32, 3), np.uint8)
        kanvas[:nh, :nw] = cv2.resize(img, (nw, nh)) if skala != 1.0 else img
        blob = cv2.dnn.blobFromImage(kanvas, 1 / 128, (W32, H32), (127.5, 127.5, 127.5), swapRB=True)
        with self.kunci:
            outs = self.det.run(None, {self.det_in: blob})
        outs = [o[0] if o.ndim == 3 else o for o in outs]
        ikut = lambda d: sorted((o for o in outs if o.shape[-1] == d), key=lambda o: -o.shape[0])
        sk, bb, kp = ikut(1), ikut(4), ikut(10)
        kotak, skor, titik = [], [], []
        for i, stride in enumerate((8, 16, 32)):
            fh, fw = H32 // stride, W32 // stride
            pusat = (np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).reshape(-1, 2).astype(np.float32) * stride)
            pusat = np.repeat(pusat, sk[i].shape[0] // (fh * fw), axis=0)
            s = sk[i].reshape(-1)
            pos = np.flatnonzero(s >= self.skor_kesan)
            if not len(pos):
                continue
            c, d = pusat[pos], bb[i][pos] * stride
            kotak.append(np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], 1))
            titik.append((kp[i][pos] * stride).reshape(-1, 5, 2) + c[:, None, :])
            skor.append(s[pos])
        if not kotak:
            return []
        kotak, skor, titik = np.vstack(kotak), np.hstack(skor), np.vstack(titik)
        xywh = [[float(a), float(b), float(c - a), float(d - b)] for a, b, c, d in kotak]
        pilih = np.array(cv2.dnn.NMSBoxes(xywh, skor.tolist(), self.skor_kesan, 0.4)).reshape(-1)
        out = []
        for j in pilih:
            x1, y1, x2, y2 = kotak[j] / skala
            out.append(np.array([x1, y1, x2 - x1, y2 - y1, *(titik[j] / skala).reshape(-1), skor[j]], np.float32))
        return out

    def ciri(self, img, face):
        M, _ = cv2.estimateAffinePartial2D(np.asarray(face[4:14], np.float32).reshape(5, 2), ARC_DST, method=cv2.LMEDS)
        if M is None:
            M = cv2.getAffineTransform(np.asarray(face[4:10], np.float32).reshape(3, 2), ARC_DST[:3])
        crop = cv2.warpAffine(img, M, (112, 112), borderValue=0)
        blob = cv2.dnn.blobFromImage(crop, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        with self.kunci:
            f = self.rec.run(None, {self.rec_in: blob})[0].flatten()
        return (f / (np.linalg.norm(f) + 1e-9)).astype(np.float32)

    def ciri_gambar(self, img):
        faces = self.kesan(img)
        if not faces:
            # gambar kad dipotong rapat pada muka: SCRFD perlukan ruang di sekeliling wajah, jadi tambah bingkai
            t = int(max(img.shape[:2]) * 0.5)
            img = cv2.copyMakeBorder(img, t, t, t, t, cv2.BORDER_CONSTANT, value=(110, 110, 110))
            faces = self.kesan(img)
        if not faces:
            return None
        return self.ciri(img, max(faces, key=lambda f: f[2] * f[3]))


# had skor lalai bagi setiap model (skala skor kedua-dua model berbeza)
LALAI_AMBANG = {
    "sface": {"ambang": 0.363, "ambang_kumpul": 0.38, "ambang_maklum": 0.42},
    # diukur pada 41 orang x keadaan CCTV (kecil/kabur/gelap/IR): 0.35 -> 99% orang sama diterima,
    # 0.06% orang lain tersalah diterima; 0.40 -> 0.02%
    "arcface": {"ambang": 0.35, "ambang_kumpul": 0.38, "ambang_maklum": 0.40},
}


def isi_ambang_lalai(a, enjin):
    for k, v in LALAI_AMBANG[enjin.nama].items():
        if getattr(a, k, None) is None:
            setattr(a, k, v)


def buat_enjin(model="arcface", lebar_kesan=None):
    """Pilih enjin; jika ArcFace tidak dapat dimuat (cth tiada internet/onnxruntime), guna SFace."""
    enjin = None
    if model == "arcface":
        try:
            enjin = EnjinArcFace(lebar_kesan=lebar_kesan or 960)  # SCRFD@960 kesan wajah dari ~44px pada 2K
        except Exception as e:
            print(f"[model] ArcFace tidak dapat dimuat ({e}). Guna SFace.")
    if enjin is None:
        enjin = Enjin(lebar_kesan=lebar_kesan or DETECT_WIDTH)
    _akhiran_semasa[0] = AKHIRAN_CIRI[enjin.nama]
    print(f"Model kenal wajah: {'ArcFace + SCRFD (InsightFace)' if enjin.nama == 'arcface' else 'SFace + YuNet (OpenCV)'}")
    return enjin


# ---------------------------------------------------------------- stor data
FON = cv2.FONT_HERSHEY_SIMPLEX


def lukis_tag(img, x, y, w, h, label, warna, skala=0.55):
    """Kotak wajah dengan tag nama berlatar warna di atasnya."""
    cv2.rectangle(img, (x, y), (x + w, y + h), warna, 2)
    (tw, th), _ = cv2.getTextSize(label, FON, skala, 1)
    y0 = y - th - 8 if y - th - 8 >= 0 else y + h
    cv2.rectangle(img, (x - 1, y0), (x + tw + 8, y0 + th + 8), warna, -1)
    cv2.putText(img, label, (x + 4, y0 + th + 3), FON, skala, (255, 255, 255), 1, cv2.LINE_AA)


def lukis_kad_muka(img, peristiwa, sekarang, tempoh=60, maks=4):
    """Kad muka (gambar + nama + masa) bertindan di penjuru kanan atas, seperti NVR."""
    H, W = img.shape[:2]
    saiz = max(64, int(W * 0.1))
    bh = max(16, saiz // 6)
    x, y = W - saiz - 12, 12
    for ev in list(peristiwa)[::-1][:maks]:
        if sekarang - ev["t"] > tempoh or y + saiz + 2 * bh > H:
            break
        warna = ev["warna"]
        cv2.rectangle(img, (x - 2, y - 2), (x + saiz + 1, y + saiz + 2 * bh + 1), warna, -1)
        img[y + bh:y + bh + saiz, x:x + saiz] = cv2.resize(ev["gambar"], (saiz, saiz))
        for teks, ty in ((ev["nama"][:14], y + bh - 4), (ev["masa"], y + bh + saiz + bh - 4)):
            sk = 0.42 * bh / 16
            cv2.putText(img, teks, (x + 3, ty), FON, sk, (255, 255, 255), 1, cv2.LINE_AA)
        y += saiz + 2 * bh + 10


def iou(a, b):
    """Pertindihan dua kotak (x, y, w, h): 0 = tiada, 1 = sama."""
    ax, ay, aw, ah = (float(v) for v in a[:4])
    bx, by, bw, bh = (float(v) for v in b[:4])
    iw = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    ih = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    sama = iw * ih
    return sama / (aw * ah + bw * bh - sama + 1e-9)


def potong_segi(img, face, saiz=160):
    """Potongan segi empat sama sekitar wajah, untuk kad muka."""
    x, y, w, h = (int(v) for v in face[:4])
    sisi = int(max(w, h) * 1.5)
    cx, cy = x + w // 2, y + h // 2
    H, W = img.shape[:2]
    x0, y0 = max(0, cx - sisi // 2), max(0, cy - sisi // 2)
    x1, y1 = min(W, x0 + sisi), min(H, y0 + sisi)
    c = img[y0:y1, x0:x1]
    return cv2.resize(c, (saiz, saiz)) if c.size else np.zeros((saiz, saiz, 3), np.uint8)


class Stor:
    """Pegang senarai orang berdaftar & kumpulan wajah baru. Dikongsi antara kamera dan page web."""

    def __init__(self, enjin, ambang=0.363, ambang_kumpul=0.38, maks_gambar=30, selang_simpan=5.0,
                 saiz_min=60):
        self.enjin = enjin
        self.ambang, self.ambang_kumpul = ambang, ambang_kumpul
        # masukkan kad terus ke orang berdaftar hanya jika sangat serupa (elak orang asing tersalah masuk)
        self.ambang_serap = max(0.5, ambang_kumpul + 0.1)
        self.maks_gambar, self.selang_simpan, self.saiz_min = maks_gambar, selang_simpan, saiz_min
        self.kunci = threading.RLock()
        self.kamera = {}           # nama -> Kamera (untuk paparan langsung yang lancar)
        self.bingkai = {}          # nama kamera -> bingkai terakhir yang diproses
        self.bil_bingkai = {}      # nama kamera -> bilangan bingkai diproses
        self.kotak = {}            # nama kamera -> (masa, kotak wajah terkini) untuk paparan langsung
        self.log_path = None
        self.notif = None
        self._diag = {}  # sebab -> masa terakhir dicetak
        try:
            self.tetapan = json.loads(TETAPAN.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.tetapan = {}
        self.tetapan.setdefault("senyap", [])  # orang berdaftar yang TIDAK hantar notifikasi
        self.tetapan.setdefault("mesej", {})   # mesej notifikasi khas, cth {"Isteri": "🏠 Isteri dah balik"}
        self.tetapan.setdefault("zon", {})     # nama kamera -> [x0, y0, x1, y1] (0..1): kawasan wajah diproses
        self.tetapan.setdefault("arah", {})    # nama kamera -> salah satu ARAH_SAH
        self.tetapan.setdefault("mesej_keluar", {})  # mesej khas bila orang keluar rumah
        try:
            self.status = json.loads(STATUS.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.status = {}
        self.peristiwa = {}                    # nama kamera -> deque kad muka terkini untuk paparan langsung
        self.dikesan = {}                      # nama -> pengecaman terakhir {t, kamera, skor} (untuk tab Di rumah)
        ORANG.mkdir(exist_ok=True)
        WAJAH_BARU.mkdir(exist_ok=True)
        self.muat_orang()
        self.muat_kumpulan()
        self.gabung_semua()

    # ---- orang berdaftar
    def muat_orang(self, verbose=False):
        nama, ciri, fail = [], [], []
        for d in sorted(p for p in ORANG.iterdir() if p.is_dir()):
            n = 0
            for img_path in senarai_gambar(d):
                npy = fail_ciri(img_path)
                if npy.exists():
                    f = np.load(npy)
                else:
                    img = cv2.imread(str(img_path))
                    f = self.enjin.ciri_gambar(img) if img is not None else None
                    if f is None:
                        print(f"  ! tiada wajah dikesan: {img_path.relative_to(ROOT)}")
                        continue
                    np.save(npy, f)
                nama.append(d.name)
                ciri.append(f)
                fail.append(img_path)
                n += 1
            if verbose:
                print(f"{d.name}: {n} gambar")
        with self.kunci:
            self.nama = np.array(nama)
            self.ciri = np.stack(ciri) if ciri else np.zeros((0, self.enjin.dim), np.float32)
            self.fail_orang = fail
            self.indeks_nama = {n: np.flatnonzero(self.nama == n) for n in set(nama)}
            if not hasattr(self, "kiraan_padan"):
                self.kiraan_padan = {}  # laluan gambar -> [bilangan padanan, jumlah skor]

    def padan_orang(self, f, catat=False):
        """-> (nama, skor). Skor seseorang = purata 2 gambarnya yang paling serupa (atau 1 jika dia ada
        satu gambar sahaja), supaya satu gambar kabur/salah tidak boleh 'menarik' semua orang."""
        if len(self.ciri) == 0:
            return None, 0.0
        s = self.ciri @ f
        terbaik, nama_t, i_t = -1.0, None, -1
        for n, idx in self.indeks_nama.items():
            sk = s[idx]
            urut = np.argsort(sk)[::-1]
            skor = float(np.mean(sk[urut[:2]]))
            if skor > terbaik:
                terbaik, nama_t, i_t = skor, n, int(idx[urut[0]])
        if catat and terbaik >= self.ambang:
            k = self.kiraan_padan.setdefault(str(self.fail_orang[i_t]), [0, 0.0])
            k[0] += 1
            k[1] += float(s[i_t])
        return nama_t, terbaik

    def beza_kedua(self, f, nama):
        """Beza skor `nama` dengan orang berdaftar kedua paling serupa (1.0 jika hanya seorang berdaftar)."""
        s = self.ciri @ f
        skor = {n: float(np.mean(np.sort(s[idx])[::-1][:2])) for n, idx in self.indeks_nama.items()}
        lain = [v for n, v in skor.items() if n != nama]
        return skor.get(nama, 0.0) - max(lain) if lain else 1.0

    # ---- kumpulan wajah baru
    def muat_kumpulan(self):
        self.kumpulan = {}
        for d in sorted(p for p in WAJAH_BARU.iterdir() if p.is_dir()):
            fail, ciri = [], []
            gambar = senarai_gambar(d)
            for img_path in gambar:
                npy = fail_ciri(img_path)
                if npy.exists():
                    f = np.load(npy)
                else:  # cth selepas tukar model: kira semula dari gambar yang disimpan
                    im = cv2.imread(str(img_path))
                    f = self.enjin.ciri_gambar(im) if im is not None else None
                    if f is None:
                        continue
                    np.save(npy, f)
                fail.append(img_path)
                ciri.append(f)
            if fail:
                self.kumpulan[d.name] = {"fail": fail, "ciri": ciri, "akhir_simpan": 0.0,
                                         "akhir_lihat": max(p.stat().st_mtime for p in fail)}
            elif not gambar:
                shutil.rmtree(d, ignore_errors=True)

    def kenal(self, f):
        """-> (nama | None, skor, id_kumpulan | None)"""
        with self.kunci:
            nama, skor = self.padan_orang(f, catat=True)
            if nama is not None and skor >= self.ambang:
                return nama, skor, None
            cocok = []
            for k_id, k in self.kumpulan.items():
                s = float(np.max(np.stack(k["ciri"]) @ f))
                if s >= self.ambang_kumpul:
                    cocok.append((s, k_id))
            if not cocok:
                return None, skor, None
            cocok.sort(reverse=True)
            # wajah ini padan dengan beberapa kad -> kad-kad itu orang yang sama, gabungkan
            jambatan = [k_id for s, k_id in cocok if s >= self.ambang_kumpul + 0.04]
            if len(jambatan) > 1:
                sasaran = self._gabung(jambatan)
                return None, skor, sasaran
            return None, skor, cocok[0][1]

    def rekod_asing(self, img, face, f, kid, sekarang):
        """Simpan potongan wajah orang tidak dikenali. -> (id_kumpulan | None, kumpulan_baru)"""
        x, y, w, h = face[:4]
        with self.kunci:
            if kid in self.kumpulan:
                k = self.kumpulan[kid]
                k["akhir_lihat"] = sekarang
                if len(k["fail"]) >= self.maks_gambar:
                    return kid, False
            if not self._menghadap(face):
                self._diagnostik("sisi", "wajah dari sisi (tidak menghadap kamera)")
                return kid, False  # cap jari wajah lemah, mudah jadi kad berasingan
            if min(w, h) < self.saiz_min:
                self._diagnostik("kecil", f"wajah terlalu kecil ({int(min(w, h))}px, minimum {self.saiz_min}px - "
                                          f"guna --saiz-min untuk ubah)")
                return kid, False
            crop = self._potong(img, x, y, w, h)
            if crop is None:
                self._diagnostik("kabur", "wajah terlalu kabur")
                return kid, False
            baru = kid not in self.kumpulan
            if not baru:
                # simpan gambar TERBAIK (paling tajam & besar) dalam setiap tempoh --selang-simpan
                k = self.kumpulan[kid]
                q = self._kualiti(img, face)
                calon = k.get("calon")
                if calon is None or q > calon[2]:
                    k["calon"] = (crop, f, q)
                if sekarang - k["akhir_simpan"] < self.selang_simpan:
                    return kid, False
                crop, f, _ = k.pop("calon")
            if baru:
                kid = f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}"
                self.kumpulan[kid] = {"fail": [], "ciri": [], "akhir_simpan": 0.0, "akhir_lihat": sekarang}
            d = WAJAH_BARU / kid
            d.mkdir(exist_ok=True)
            p = d / f"{datetime.now():%Y%m%d-%H%M%S-%f}.jpg"
            cv2.imwrite(str(p), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])
            np.save(fail_ciri(p), f)
            k = self.kumpulan[kid]
            k["fail"].append(p)
            k["ciri"].append(f)
            k["akhir_simpan"] = sekarang
            return kid, baru

    @staticmethod
    def _kualiti(img, face):
        """Markah kualiti wajah: ketajaman (dinormalkan ke 112px) x saiz. Tinggi = lebih jelas."""
        x, y, w, h = (int(v) for v in face[:4])
        wajah = img[max(0, y):y + h, max(0, x):x + w]
        if wajah.size == 0:
            return 0.0
        g = cv2.resize(cv2.cvtColor(wajah, cv2.COLOR_BGR2GRAY), (112, 112))
        return float(cv2.Laplacian(g, cv2.CV_64F).var()) * min(w, h)

    def _diagnostik(self, jenis, sebab):
        if time.time() - self._diag.get(jenis, 0) > 30:  # maks sekali setiap 30 saat bagi setiap jenis
            self._diag[jenis] = time.time()
            print(f"[wajah] orang tidak dikenali dikesan, tetapi gambar tidak disimpan: {sebab}")

    @staticmethod
    def _menghadap(face):
        """True jika wajah lebih kurang menghadap kamera (hidung di antara kedua-dua mata)."""
        w = float(face[2])
        m1, m2 = sorted((float(face[4]), float(face[6])))
        lebar = m2 - m1
        if w <= 0 or lebar < 0.2 * w:
            return False
        return 0.15 <= (float(face[8]) - m1) / lebar <= 0.85

    # ---- gabung kad orang yang sama
    @staticmethod
    def _skor_set(a, b):
        """Purata 3 pasangan paling serupa antara dua set cap jari wajah."""
        s = np.sort((np.stack(a) @ np.stack(b).T).ravel())[::-1]
        return float(np.mean(s[:3]))

    def _gabung(self, ids):
        """Gabungkan beberapa kad ke dalam kad yang paling banyak gambar. -> id kad sasaran"""
        with self.kunci:
            ids = [i for i in dict.fromkeys(ids) if i in self.kumpulan]
            if not ids:
                return None
            sasaran = max(ids, key=lambda i: len(self.kumpulan[i]["fail"]))
            k, d = self.kumpulan[sasaran], WAJAH_BARU / sasaran
            d.mkdir(exist_ok=True)
            for sid in ids:
                if sid == sasaran:
                    continue
                sk = self.kumpulan.pop(sid)
                for p, c in zip(sk["fail"], sk["ciri"]):
                    baru = d / f"{sid[-4:]}_{p.name}"
                    try:
                        shutil.move(str(p), baru)
                        pindah_ciri(p, baru)
                    except OSError:
                        continue
                    k["fail"].append(baru)
                    k["ciri"].append(c)
                k["akhir_lihat"] = max(k["akhir_lihat"], sk["akhir_lihat"])
                shutil.rmtree(WAJAH_BARU / sid, ignore_errors=True)
            if len(ids) > 1:
                print(f"[wajah] {len(ids)} kad digabung (orang yang sama) -> #{sasaran[-4:]}")
            return sasaran

    def gabung_semua(self):
        """Kemaskan kad: masukkan kad yang padan dengan orang berdaftar, dan gabung kad orang yang sama."""
        with self.kunci:
            dilabel = 0
            if len(self.ciri):
                for kid in list(self.kumpulan):
                    terbaik, nama = 0.0, None
                    for n in set(self.nama.tolist()):
                        sk = self._skor_set(self.kumpulan[kid]["ciri"], list(self.ciri[self.nama == n]))
                        if sk > terbaik:
                            terbaik, nama = sk, n
                    if nama and terbaik >= self.ambang_serap:
                        print(f"[wajah] kad #{kid[-4:]} dimasukkan ke {nama} (skor {terbaik:.2f})")
                        self.label(kid, nama, gabung=False)
                        dilabel += 1
            berubah = True
            while berubah:
                berubah = False
                ids = list(self.kumpulan)
                for i in range(len(ids)):
                    for j in range(i + 1, len(ids)):
                        if self._skor_set(self.kumpulan[ids[i]]["ciri"],
                                          self.kumpulan[ids[j]]["ciri"]) >= self.ambang_kumpul:
                            self._gabung([ids[i], ids[j]])
                            berubah = True
                            break
                    if berubah:
                        break
            if dilabel:
                print(f"[wajah] {dilabel} kad dimasukkan terus ke orang berdaftar (wajah sepadan)")

    def gabung_manual(self, ids):
        ids = [i for i in (ids or []) if i in self.kumpulan]
        if len(ids) < 2:
            raise ValueError("Pilih sekurang-kurangnya 2 kad untuk digabung.")
        self._gabung(ids)

    @staticmethod
    def _potong(img, x, y, w, h):
        H, W = img.shape[:2]
        # potong rapat pada muka (sedikit ruang di sekeliling), bukan bahu/latar belakang
        x0, y0 = int(max(0, x - 0.25 * w)), int(max(0, y - 0.3 * h))
        x1, y1 = int(min(W, x + 1.25 * w)), int(min(H, y + 1.2 * h))
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return None
        wajah = img[int(max(0, y)):int(y + h), int(max(0, x)):int(x + w)]
        if wajah.size and cv2.Laplacian(cv2.cvtColor(wajah, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var() < 30:
            return None  # terlalu kabur
        s = 640 / max(crop.shape[:2])  # simpan sehingga 640px (tidak dibesarkan jika lebih kecil)
        return cv2.resize(crop, None, fx=s, fy=s) if s < 1 else crop

    def bersih(self, hari):
        """Padam kumpulan wajah baru yang tidak dinamakan selepas beberapa hari."""
        had = time.time() - hari * 86400
        with self.kunci:
            for kid in [k for k, v in self.kumpulan.items() if v["akhir_lihat"] < had]:
                self.buang_kumpulan(kid)
            self.gabung_semua()
        if KLIP_DIR.is_dir():
            for f in KLIP_DIR.glob("*.mp4"):
                try:
                    if f.stat().st_mtime < had:
                        f.unlink()
                except OSError:  # sedang dimainkan dalam page web (Windows) - cuba lagi nanti
                    pass

    # ---- tindakan dari page web
    @staticmethod
    def semak_nama(nama):
        nama = (nama or "").strip()
        if not NAMA_SAH.match(nama) or ".." in nama:
            raise ValueError("Nama tidak sah. Guna huruf, nombor, jarak, - atau _ sahaja (maks 40).")
        return nama

    def label(self, kid, nama, keluarkan=(), gabung=True):
        nama = self.semak_nama(nama)
        with self.kunci:
            k = self.kumpulan.pop(kid, None)
            if k is None:
                raise ValueError("Kumpulan tidak dijumpai (mungkin sudah disimpan).")
            dest = ORANG / nama
            dest.mkdir(exist_ok=True)
            for p in k["fail"]:
                if p.name in keluarkan:
                    continue
                shutil.move(str(p), dest / f"{kid}_{p.name}")
                pindah_ciri(p, dest / f"{kid}_{p.name}")
            shutil.rmtree(WAJAH_BARU / kid, ignore_errors=True)
            self.muat_orang()
            if gabung:
                self.gabung_semua()  # kad lain orang yang sama terus masuk ke nama ini

    def buang_kumpulan(self, kid):
        with self.kunci:
            self.kumpulan.pop(kid, None)
            shutil.rmtree(WAJAH_BARU / kid, ignore_errors=True)

    def buang_gambar(self, rel):
        p = self._laluan_selamat(rel)
        with self.kunci:
            if p.parent.parent == ORANG:
                p.unlink(missing_ok=True)
                padam_ciri(p)
                if not senarai_gambar(p.parent):
                    shutil.rmtree(p.parent, ignore_errors=True)
                self.muat_orang()
            else:
                k = self.kumpulan.get(p.parent.name)
                if k and p in k["fail"]:
                    i = k["fail"].index(p)
                    k["fail"].pop(i)
                    k["ciri"].pop(i)
                p.unlink(missing_ok=True)
                padam_ciri(p)
                if k is not None and not k["fail"]:
                    self.buang_kumpulan(p.parent.name)

    def pindah_gambar(self, rel, nama):
        """Pindah satu gambar orang berdaftar ke orang lain (dicipta jika belum wujud)."""
        p, nama = self._laluan_selamat(rel), self.semak_nama(nama)
        if p.parent.parent != ORANG or not p.exists():
            raise ValueError("Gambar tidak dijumpai.")
        with self.kunci:
            dest_dir = ORANG / nama
            dest_dir.mkdir(exist_ok=True)
            dest = dest_dir / p.name
            if dest.exists():
                dest = dest_dir / f"{p.parent.name}_{p.name}"
            shutil.move(str(p), dest)
            pindah_ciri(p, dest)
            if not senarai_gambar(p.parent):
                shutil.rmtree(p.parent, ignore_errors=True)
            self.kiraan_padan.pop(str(p), None)
            self.muat_orang()

    def tukar_nama(self, lama, baru):
        """Tukar nama orang berdaftar. Jika nama baru sudah wujud, gambar digabung ke dalamnya."""
        lama, baru = self.semak_nama(lama), self.semak_nama(baru)
        if lama == baru:
            return
        with self.kunci:
            sumber, sasaran = ORANG / lama, ORANG / baru
            if not sumber.is_dir():
                raise ValueError(f"{lama} tidak dijumpai.")
            if sasaran.is_dir():
                for f in sumber.iterdir():
                    dest = sasaran / f.name
                    if dest.exists():
                        dest = sasaran / f"{lama}_{f.name}"
                    shutil.move(str(f), dest)
                shutil.rmtree(sumber, ignore_errors=True)
            else:
                sumber.rename(sasaran)
            t = self.tetapan
            for k in ("mesej", "mesej_keluar"):
                if lama in t[k]:
                    m = t[k].pop(lama)
                    t[k].setdefault(baru, m.replace(lama, baru))
            if lama in self.status:
                self.status.setdefault(baru, self.status.pop(lama))
            if lama in t["senyap"]:
                t["senyap"] = sorted((set(t["senyap"]) - {lama}) | {baru})
            self._simpan_tetapan()
            self.muat_orang()

    def padam_orang(self, nama):
        nama = self.semak_nama(nama)
        with self.kunci:
            shutil.rmtree(ORANG / nama, ignore_errors=True)
            self.muat_orang()
            if nama in self.tetapan["senyap"]:
                self.set_maklum(nama, True)
            if nama in self.tetapan["mesej"]:
                self.set_mesej(nama, "")
            if nama in self.tetapan["mesej_keluar"]:
                self.set_mesej(nama, "", "keluar")
            self.status.pop(nama, None)

    # ---- notifikasi bagi setiap orang
    def maklum_hidup(self, nama):
        return nama not in self.tetapan["senyap"]

    def mesej_untuk(self, nama, arah=None):
        if arah == "keluar":
            return self.tetapan["mesej_keluar"].get(nama) or f"🚪 {nama} keluar rumah"
        return self.tetapan["mesej"].get(nama) or (f"🏠 {nama} masuk rumah" if arah == "masuk"
                                                     else f"✅ {nama} dikesan di kamera")

    def set_mesej(self, nama, mesej, jenis="masuk"):
        nama = self.semak_nama(nama)
        mesej = (mesej or "").strip()[:200]
        kunci = "mesej_keluar" if jenis == "keluar" else "mesej"
        with self.kunci:
            if mesej:
                self.tetapan[kunci][nama] = mesej
            else:
                self.tetapan[kunci].pop(nama, None)
            self._simpan_tetapan()

    # ---- arah kamera (masuk / keluar) dan status siapa di rumah
    def arah_untuk(self, kamera):
        return self.tetapan["arah"].get(kamera, "tiada")

    def set_arah(self, kamera, arah):
        if not isinstance(kamera, str) or kamera not in self.kamera:
            raise ValueError("Kamera belum sedia atau tidak dikenali.")
        if arah not in ARAH_SAH:
            raise ValueError("Arah tidak sah.")
        with self.kunci:
            if arah == "tiada":
                self.tetapan["arah"].pop(kamera, None)
            else:
                self.tetapan["arah"][kamera] = arah
            self._simpan_tetapan()

    def tulis_log(self, baris):
        """Tulis satu baris log ke fail hari ini (fail baru dibuka secara automatik bila tarikh bertukar)."""
        with self.kunci:
            laluan = LOG_DIR / f"{datetime.now():%Y-%m-%d}.csv"
            if getattr(self, "_log_f", None) is None or self.log_path != laluan:
                if getattr(self, "_log_f", None):
                    self._log_f.close()
                LOG_DIR.mkdir(exist_ok=True)
                baru = not laluan.exists()
                self._log_f = open(laluan, "a", newline="", encoding="utf-8")
                self._log = csv.writer(self._log_f)
                if baru:
                    self._log.writerow(["masa", "nama", "skor", "kumpulan", "kamera", "arah"])
                self.log_path = laluan
            if baris:
                self._log.writerow(baris)
            self._log_f.flush()

    def tutup_log(self):
        with self.kunci:
            if getattr(self, "_log_f", None):
                self._log_f.close()
                self._log_f = None

    def set_status_manual(self, nama, arah):
        """Betulkan status masuk/keluar secara manual dari page web (cth kamera terlepas)."""
        nama = self.semak_nama(nama)
        if arah not in ("masuk", "keluar"):
            raise ValueError("Status tidak sah.")
        if not (ORANG / nama).is_dir():
            raise ValueError(f"{nama} tidak dijumpai.")
        self.kemas_status(nama, arah, "manual")
        self.tulis_log([datetime.now().strftime("%Y-%m-%d %H:%M:%S"), nama, "", "", "manual", arah])

    def kemas_status(self, nama, arah, kamera):
        with self.kunci:
            self.status[nama] = {"arah": arah, "masa": time.time(), "kamera": kamera}
            STATUS.write_text(json.dumps(self.status, indent=2, ensure_ascii=False), encoding="utf-8")

    def _simpan_tetapan(self):
        TETAPAN.write_text(json.dumps(self.tetapan, indent=2, ensure_ascii=False), encoding="utf-8")

    def set_maklum(self, nama, hidup):
        nama = self.semak_nama(nama)
        with self.kunci:
            senyap = set(self.tetapan["senyap"])
            senyap.discard(nama) if hidup else senyap.add(nama)
            self.tetapan["senyap"] = sorted(senyap)
            self._simpan_tetapan()

    def tambah_gambar(self, nama, data):
        nama = self.semak_nama(nama)
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Fail bukan gambar yang boleh dibaca (guna JPG/PNG).")
        s = 1280 / max(img.shape[:2])
        if s < 1:
            img = cv2.resize(img, None, fx=s, fy=s)
        f = self.enjin.ciri_gambar(img)
        if f is None:
            raise ValueError("Tiada wajah dikesan dalam gambar ini.")
        with self.kunci:
            dest = ORANG / nama
            dest.mkdir(exist_ok=True)
            p = dest / f"muatnaik_{datetime.now():%Y%m%d-%H%M%S-%f}.jpg"
            cv2.imwrite(str(p), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            np.save(fail_ciri(p), f)
            self.muat_orang()

    def _laluan_selamat(self, rel):
        p = (ROOT / urllib.parse.unquote(rel)).resolve()
        if p.suffix.lower() not in IMG_EXT or p.parent.parent not in (ORANG.resolve(), WAJAH_BARU.resolve()):
            raise ValueError("Laluan tidak sah.")
        return p

    # ---- data untuk page web
    def data(self):
        url = lambda p: "/fail/" + urllib.parse.quote(p.relative_to(ROOT).as_posix())
        with self.kunci:
            baru = []
            for kid, k in sorted(self.kumpulan.items(), key=lambda kv: -kv[1]["akhir_lihat"]):
                min_ = np.mean(np.stack(k["ciri"]), axis=0)
                cad, skor = self.padan_orang(min_ / (np.linalg.norm(min_) + 1e-9))
                baru.append({
                    "id": kid, "pendek": kid[-4:],
                    "gambar": [{"url": url(p), "fail": p.name, "rel": p.relative_to(ROOT).as_posix()} for p in k["fail"]],
                    "akhir": datetime.fromtimestamp(k["akhir_lihat"]).strftime("%d/%m %H:%M"),
                    "cadangan": cad if cad and skor >= self.ambang - 0.08 else None,
                })
            rekod = []
            if self.log_path and self.log_path.exists():
                with open(self.log_path, newline="", encoding="utf-8") as fh:
                    rekod = list(csv.reader(fh))[1:]
            gerak = {}  # nama -> pergerakan masuk/keluar hari ini
            for r in rekod:
                if len(r) > 5 and r[5] in ("masuk", "keluar"):
                    gerak.setdefault(r[1], []).append({"masa": r[0][11:16], "arah": r[5], "kamera": r[4]})
            orang = []
            for d in sorted(p for p in ORANG.iterdir() if p.is_dir()):
                gambar = []
                for p in senarai_gambar(d):
                    k = self.kiraan_padan.get(str(p), [0, 0.0])
                    gambar.append({"url": url(p), "rel": p.relative_to(ROOT).as_posix(), "padan": k[0],
                                   "skor": round(k[1] / k[0], 2) if k[0] else None})
                jumlah = sum(g["padan"] for g in gambar)
                for g in gambar:  # gambar yang padan dengan kebanyakan pengesanan tetapi skornya rendah
                    g["curiga"] = bool(g["padan"] >= 10 and len(gambar) > 2 and g["padan"] > 0.5 * jumlah
                                       and g["skor"] is not None and g["skor"] < self.ambang + 0.1)
                st = self.status.get(d.name)
                orang.append({"nama": d.name, "gambar": gambar, "maklum": self.maklum_hidup(d.name),
                              "mesej_keluar": self.tetapan["mesej_keluar"].get(d.name, ""),
                              "status": {"arah": st["arah"], "kamera": st.get("kamera", ""),
                                         "masa": datetime.fromtimestamp(st["masa"]).strftime("%d/%m %I:%M %p"),
                                         "masa_mesra": self._masa_mesra(st["masa"])}
                              if st else None,
                              "hari_ini": gerak.get(d.name, []),
                              "terakhir": {"masa": self._masa_mesra(self.dikesan[d.name]["t"]),
                                           "kamera": self.dikesan[d.name]["kamera"],
                                           "skor": round(self.dikesan[d.name]["skor"], 2),
                                           "selepas_status": not st or self.dikesan[d.name]["t"] > st["masa"] + 5}
                              if d.name in self.dikesan else None,
                              "mesej": self.tetapan["mesej"].get(d.name, "")})
        log = rekod[-200:][::-1]
        klip = []
        if KLIP_DIR.is_dir():
            for f in sorted(KLIP_DIR.glob("*.mp4"), reverse=True)[:30]:
                try:
                    masa = datetime.strptime(f.name[:15], "%Y%m%d-%H%M%S").strftime("%d/%m %I:%M %p")
                except ValueError:
                    masa = ""
                label, _, kam = f.stem[16:].partition("__")
                klip.append({"url": "/klip/" + urllib.parse.quote(f.name), "masa": masa,
                             "label": label.replace("+", ", ").replace("_", " "),
                             "kamera": kam.replace("_", " ")})
        return {"baru": baru, "orang": orang, "log": log, "klip": klip,
                "kamera": list(self.kamera) or list(self.bingkai),
                "zon": dict(self.tetapan["zon"]),
                "https": getattr(self, "port_https", None),
                "versi": VERSI,
                "arah": dict(self.tetapan["arah"]),
                "saluran": self.notif.nama if self.notif else [],
                "whatsapp": self.notif.whatsapp.status()
                if self.notif and self.notif.whatsapp.aktif else None}

    def set_bingkai(self, img, kotak=None, kamera="Kamera"):
        self.bingkai[kamera] = img
        self.bil_bingkai[kamera] = self.bil_bingkai.get(kamera, 0) + 1
        if kotak is not None:
            self.kotak[kamera] = (time.time(), kotak)

    def tambah_peristiwa(self, kamera, nama, warna, gambar):
        self.peristiwa.setdefault(kamera, deque(maxlen=6)).append(
            {"t": time.time(), "nama": nama, "warna": warna, "gambar": gambar,
             "masa": datetime.now().strftime("%H:%M:%S")})

    def zon_untuk(self, kamera):
        z = self.tetapan["zon"].get(kamera)
        return tuple(z) if z else None

    def set_zon(self, kamera, zon):
        if not isinstance(kamera, str) or kamera not in self.kamera:
            raise ValueError("Kamera belum sedia atau tidak dikenali. Muat semula page dan cuba lagi.")
        with self.kunci:
            if zon:
                try:
                    x0, y0, x1, y1 = (min(1.0, max(0.0, float(v))) for v in zon)
                except (TypeError, ValueError):
                    raise ValueError("Zon tidak sah.")
                if x1 - x0 < 0.05 or y1 - y0 < 0.05:
                    raise ValueError("Zon terlalu kecil.")
                self.tetapan["zon"][kamera] = [round(v, 4) for v in (x0, y0, x1, y1)]
            else:
                self.tetapan["zon"].pop(kamera, None)
            self._simpan_tetapan()

    # ---- bot WhatsApp: balas arahan dari ahli keluarga
    def _wa_dibenarkan(self, d):
        wa = self.notif.whatsapp if self.notif else None
        senarai = (wa.ke if wa else []) + [x.strip() for x in os.environ.get("WHATSAPP_ADMIN", "").split(",") if x.strip()]
        nombor, kumpulan = set(), set()
        for e in senarai:
            if "@g.us" in e:
                kumpulan.add(e)
            else:
                n = re.sub(r"\D", "", e)
                nombor.add("6" + n if n.startswith("0") else n)
        if d.get("chat") in kumpulan:
            return True
        for c in [d.get("chat", "")] + list(d.get("dari") or []):
            if c and not c.endswith(("@lid", "@g.us")) and re.sub(r"\D", "", c.split("@")[0].split(":")[0]) in nombor:
                return True
        return False

    @staticmethod
    def _masa_mesra(t):
        dt = datetime.fromtimestamp(t)
        return dt.strftime("%I:%M %p").lstrip("0") if dt.date() == datetime.now().date() \
            else dt.strftime("%d/%m %I:%M %p")

    def teks_siapa(self):
        baris = [f"🏠 *Siapa di rumah* ({datetime.now():%d/%m %I:%M %p})"]
        semua = sorted(set(self.nama.tolist()) | set(self.status))
        di_rumah = [n for n in semua if self.status.get(n, {}).get("arah") == "masuk"]
        keluar = [n for n in semua if self.status.get(n, {}).get("arah") == "keluar"]
        tiada = [n for n in semua if n not in self.status]
        for n in di_rumah:
            baris.append(f"🟢 {n} – di rumah sejak {self._masa_mesra(self.status[n]['masa'])}")
        for n in keluar:
            baris.append(f"⚪ {n} – keluar {self._masa_mesra(self.status[n]['masa'])}")
        for n in tiada:
            baris.append(f"❔ {n} – tiada rekod masuk/keluar")
        if len(baris) == 1:
            baris.append("Belum ada orang berdaftar.")
        if not di_rumah and not keluar:
            baris.append("\n_Tetapkan 'Arah kamera' dalam page web supaya masuk/keluar direkod._")
        return "\n".join(baris)

    def teks_log(self):
        baris = [f"📋 *Log hari ini* ({datetime.now():%d/%m})"]
        rekod = []
        if self.log_path and self.log_path.exists():
            with open(self.log_path, newline="", encoding="utf-8") as fh:
                rekod = list(csv.reader(fh))[1:]
        arah = [r for r in rekod if len(r) > 5 and r[5] in ("masuk", "keluar")]
        for r in arah[-25:]:
            ikon, kata = ("🟢", "masuk") if r[5] == "masuk" else ("⚪", "keluar")
            baris.append(f"{r[0][11:16]} {ikon} {r[1]} {kata}" + (f" ({r[4]})" if len(r) > 4 and r[4] else ""))
        dikesan = {}
        for r in rekod:
            if len(r) > 1 and not (len(r) > 5 and r[5]):
                n = r[1]
                dikesan[n] = (dikesan.get(n, (0, ""))[0] + 1, r[0][11:16])
        if dikesan:
            baris.append("\n👀 *Dikesan hari ini:*")
            for n, (bil, akhir) in sorted(dikesan.items(), key=lambda kv: kv[1][1], reverse=True)[:15]:
                baris.append(f"• {n} – {bil}x, terakhir {akhir}")
        if len(baris) == 1:
            baris.append("Belum ada rekod hari ini.")
        return "\n".join(baris)

    def jawab_wa(self, d):
        """-> senarai balasan [{teks, gambar?}] untuk satu mesej WhatsApp masuk ([] = tidak dibalas)."""
        if not self._wa_dibenarkan(d):
            return []
        t = re.sub(r"\s+", " ", (d.get("teks") or "").lower()).strip().lstrip("!/#.")
        kumpulan = str(d.get("chat", "")).endswith("@g.us")
        if re.match(r"^(siapa|siapa di ?rumah|siapa ada|status|rumah)\b", t):
            return [{"teks": self.teks_siapa()}]
        if re.match(r"^(log|rekod|sejarah)\b", t):
            return [{"teks": self.teks_log()}]
        if re.match(r"^(gambar|foto|snap|tengok|lihat|kamera|cctv)\b", t):
            balas = []
            for nama in self.kamera:
                if any(k in t for k in nama.lower().split()) or not any(
                        any(k in t for k in n.lower().split()) for n in self.kamera):
                    _, jpg = self.jpg_terkini(nama)
                    if jpg:
                        balas.append({"teks": f"📷 {nama} – {datetime.now():%I:%M %p}".replace(" 0", " "),
                                      "gambar": base64.b64encode(jpg).decode()})
            return balas or [{"teks": "Tiada gambar kamera buat masa ini."}]
        if re.match(r"^(menu|bantuan|help|arahan|hi|hai|helo|hello)\b", t) or not kumpulan:
            kam = ", ".join(self.kamera) or "-"
            return [{"teks": "🤖 *CCTV Kenal Orang* – arahan:\n"
                             "• *siapa* – siapa di rumah sekarang\n"
                             "• *log* – masuk/keluar & siapa dikesan hari ini\n"
                             f"• *gambar* – gambar terkini semua kamera ({kam})\n"
                             "• *gambar <nama kamera>* – gambar satu kamera\n"
                             "• *menu* – senarai ini"}]
        return []  # dalam kumpulan: abaikan perbualan biasa

    def bingkai_terkini(self):
        """Bingkai terbaru dari kamera pertama (untuk notifikasi ujian), atau None."""
        for nama, kam in self.kamera.items():
            if kam.terkini is not None:
                return kam.terkini
        return next((b for b in self.bingkai.values() if b is not None), None)

    def jpg_terkini(self, kamera=None):
        """Bingkai terkini terus dari kamera (lancar), dengan kotak nama terkini dilukis di atasnya."""
        nama = kamera if kamera in self.kamera or kamera in self.bingkai else \
            next(iter(self.kamera or self.bingkai), None)
        kam = self.kamera.get(nama)
        if kam is not None and kam.terkini is not None:
            img, kunci = kam.terkini, ("kam", kam.idx)
        else:
            img, kunci = self.bingkai.get(nama), ("proses", self.bil_bingkai.get(nama, 0))
        if img is None:
            return None, None
        s = 960 / img.shape[1]
        img = cv2.resize(img, None, fx=s, fy=s) if s < 1 else img.copy()
        s = min(s, 1.0)
        H, W = img.shape[:2]
        zon = self.zon_untuk(nama)
        if zon:  # zon pengesanan (hijau)
            cv2.rectangle(img, (int(zon[0] * W), int(zon[1] * H)), (int(zon[2] * W), int(zon[3] * H)), (0, 200, 0), 2)
        t, kotak = self.kotak.get(nama, (0.0, []))
        if time.time() - t < 0.8:
            for x, y, w, h, label, warna in kotak:
                lukis_tag(img, int(x * s), int(y * s), int(w * s), int(h * s), label, warna, 0.5)
        lukis_kad_muka(img, self.peristiwa.get(nama, ()), time.time())
        kunci = (kunci, len(self.peristiwa.get(nama, ())), self.peristiwa.get(nama, [{}])[-1].get("t") if self.peristiwa.get(nama) else 0)
        return kunci, cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()


# ---------------------------------------------------------------- page web
def sijil_sendiri():
    """Sijil HTTPS yang ditandatangani sendiri (supaya kamera telefon boleh digunakan dalam page web).
    -> (crt, key) atau None jika pakej cryptography tiada."""
    d = ROOT / "sijil"
    crt, key = d / "cctv.crt", d / "cctv.key"
    if crt.exists() and key.exists():
        return crt, key
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
    except ImportError:
        return None
    from datetime import timedelta, timezone
    d.mkdir(exist_ok=True)
    k = ec.generate_private_key(ec.SECP256R1())
    nama = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CCTV Kenal Orang")])
    alt = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        alt.append(x509.IPAddress(ipaddress.ip_address(ip_lan())))
    except ValueError:
        pass
    kini = datetime.now(timezone.utc)
    c = (x509.CertificateBuilder().subject_name(nama).issuer_name(nama).public_key(k.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(kini - timedelta(days=1))
         .not_valid_after(kini + timedelta(days=3650))
         .add_extension(x509.SubjectAlternativeName(alt), critical=False).sign(k, hashes.SHA256()))
    key.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    crt.write_bytes(c.public_bytes(serialization.Encoding.PEM))
    return crt, key


def mula_web(stor, port, kata_laluan, port_https=0):
    halaman = HALAMAN.read_bytes()
    auth_sah = kata_laluan

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _auth(self):
            if not auth_sah:
                return True
            h = self.headers.get("Authorization", "")
            if h.startswith("Basic "):
                try:
                    if base64.b64decode(h[6:]).decode().split(":", 1)[1] == auth_sah:
                        return True
                except Exception:
                    pass
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="CCTV"')
            self.end_headers()
            return False

        def _hantar(self, kod, jenis, badan):
            self.send_response(kod)
            self.send_header("Content-Type", jenis)
            self.send_header("Content-Length", str(len(badan)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(badan)

        def _json(self, obj, kod=200):
            self._hantar(kod, "application/json; charset=utf-8", json.dumps(obj).encode())

        def do_GET(self):
            if not self._auth():
                return
            path = urllib.parse.urlparse(self.path).path
            try:
                if path == "/":
                    self._hantar(200, "text/html; charset=utf-8", halaman)
                elif path == "/api/data":
                    self._json(stor.data())
                elif path.startswith("/fail/"):
                    p = stor._laluan_selamat(path[len("/fail/"):])
                    if not p.exists():
                        return self._hantar(404, "text/plain", b"tiada")
                    self._hantar(200, "image/jpeg", p.read_bytes())
                elif path == "/strim":
                    k = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("k", [None])[0]
                    self._strim(k)
                elif path.startswith("/klip/"):
                    self._klip(urllib.parse.unquote(path[len("/klip/"):]))
                else:
                    self._hantar(404, "text/plain", b"tiada")
            except ValueError as e:
                self._json({"ralat": str(e)}, 400)
            except ConnectionError:  # telefon tutup paparan (BrokenPipe / Reset / Windows 10053 Aborted)
                pass

        def _klip(self, nama):
            p = (KLIP_DIR / nama).resolve()
            if p.parent != KLIP_DIR.resolve() or p.suffix != ".mp4" or not p.exists():
                return self._hantar(404, "text/plain", b"tiada")
            data = p.read_bytes()
            m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
            if not m or not (m[1] or m[2]):
                self.send_response(200)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            if m[1]:
                mula, akhir = int(m[1]), min(int(m[2]) if m[2] else len(data) - 1, len(data) - 1)
            else:
                mula, akhir = max(0, len(data) - int(m[2])), len(data) - 1
            if mula > akhir:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(data)}")
                return self.end_headers()
            self.send_response(206)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Range", f"bytes {mula}-{akhir}/{len(data)}")
            self.send_header("Content-Length", str(akhir - mula + 1))
            self.end_headers()
            self.wfile.write(data[mula:akhir + 1])

        def _strim(self, kamera=None):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=bingkai")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            akhir = None
            while True:
                kunci, jpg = stor.jpg_terkini(kamera)
                if jpg and kunci != akhir:  # hantar hanya bila ada bingkai baru
                    akhir = kunci
                    self.wfile.write(b"--bingkai\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                time.sleep(0.07)  # ~12-15 bingkai sesaat

        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            dari_pc_ini = self.client_address[0] in ("127.0.0.1", "::1")
            if url.path == "/api/wa-masuk":  # mesej WhatsApp masuk dari penghantar (komputer ini sahaja)
                if not dari_pc_ini:
                    return self._json({"ralat": "tidak dibenarkan"}, 403)
                d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                try:
                    return self._json({"balas": stor.jawab_wa(d)})
                except Exception as e:
                    print(f"[bot] ralat: {e}")
                    return self._json({"balas": []})
            if not self._auth():
                return
            panjang = int(self.headers.get("Content-Length", 0))
            if panjang > 20_000_000:
                return self._json({"ralat": "Fail terlalu besar."}, 413)
            badan = self.rfile.read(panjang)
            jenis = self.headers.get("Content-Type", "")
            try:
                if url.path == "/api/muat-naik":
                    if not jenis.startswith("image/"):
                        raise ValueError("Hantar fail gambar.")
                    nama = urllib.parse.parse_qs(url.query).get("nama", [""])[0]
                    stor.tambah_gambar(nama, badan)
                    return self._json({"ok": True})
                if not jenis.startswith("application/json"):
                    raise ValueError("Jenis kandungan tidak sah.")
                d = json.loads(badan or b"{}")
                if url.path == "/api/label":
                    stor.label(d.get("id"), d.get("nama"), set(d.get("keluarkan", [])))
                elif url.path == "/api/gabung":
                    stor.gabung_manual(d.get("ids"))
                elif url.path == "/api/buang-kumpulan":
                    stor.buang_kumpulan(d.get("id"))
                elif url.path == "/api/buang-gambar":
                    stor.buang_gambar(d.get("rel", ""))
                elif url.path == "/api/pindah-gambar":
                    stor.pindah_gambar(d.get("rel", ""), d.get("nama"))
                elif url.path == "/api/tukar-nama":
                    stor.tukar_nama(d.get("nama"), d.get("baru"))
                elif url.path == "/api/padam-orang":
                    stor.padam_orang(d.get("nama"))
                elif url.path == "/api/maklum":
                    stor.set_maklum(d.get("nama"), bool(d.get("hidup")))
                elif url.path == "/api/status":
                    stor.set_status_manual(d.get("nama"), d.get("arah"))
                elif url.path == "/api/arah":
                    stor.set_arah(d.get("kamera"), d.get("arah"))
                elif url.path == "/api/zon":
                    stor.set_zon(d.get("kamera"), d.get("zon"))
                elif url.path == "/api/mesej":
                    stor.set_mesej(d.get("nama"), d.get("mesej", ""), d.get("jenis", "masuk"))
                elif url.path == "/api/uji-maklum":
                    if not stor.notif or not stor.notif.saluran:
                        raise ValueError("Notifikasi belum disetkan. Set WHATSAPP_KE (lihat README).")
                    ralat = stor.notif.hantar_segera("🔔 Ujian notifikasi dari CCTV Kenal Orang",
                                                     stor.bingkai_terkini())
                    if ralat:
                        raise ValueError("Gagal: " + "; ".join(ralat))
                else:
                    return self._json({"ralat": "tiada"}, 404)
                self._json({"ok": True})
            except ValueError as e:
                self._json({"ralat": str(e)}, 400)

    class Pelayan(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            if isinstance(sys.exc_info()[1], ConnectionError):
                return  # pelayar ditutup di tengah jalan: perkara biasa, tak perlu dicetak
            super().handle_error(request, client_address)

    srv = Pelayan(("0.0.0.0", port), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    stor.port_https = None
    if port_https:
        sijil = sijil_sendiri()
        if sijil is None:
            print("Page web HTTPS: tidak aktif (pip install cryptography) - kamera telefon tidak boleh digunakan")
        else:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(*sijil)

            class PelayanHTTPS(Pelayan):
                def finish_request(self, request, client_address):
                    try:  # jabat tangan TLS dalam thread permintaan (bukan thread utama pelayan)
                        request = ctx.wrap_socket(request, server_side=True)
                    except (ssl.SSLError, OSError):
                        return
                    super().finish_request(request, client_address)

            try:
                srv2 = PelayanHTTPS(("0.0.0.0", port_https), H)
                srv2.daemon_threads = True
                threading.Thread(target=srv2.serve_forever, daemon=True).start()
                stor.port_https = port_https
                print(f"Page web HTTPS (untuk daftar wajah guna kamera telefon): https://{ip_lan()}:{port_https}")
            except OSError as e:
                print(f"Page web HTTPS: tidak dapat dibuka ({e})")
    return f"http://{ip_lan()}:{port}"


# ---------------------------------------------------------------- notifikasi
def _jpg(img):
    s = 1280 / max(img.shape[:2])
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def _post_multipart(url, medan, nama_fail_medan, data, nama_fail="cctv.jpg", jenis="image/jpeg"):
    b = uuid.uuid4().hex
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                    for k, v in medan.items())
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"{nama_fail_medan}\"; filename=\"{nama_fail}\"\r\n"
             f"Content-Type: {jenis}\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url, body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return urllib.request.urlopen(req, timeout=120).read()


def _post_json(url, obj, timeout=30):
    req = urllib.request.Request(url, json.dumps(obj).encode(), {"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()


class Telegram:
    nama = "Telegram"

    def __init__(self):
        self.token = os.environ.get("TELEGRAM_TOKEN")
        self.chat = os.environ.get("TELEGRAM_CHAT_ID")
        self.aktif = bool(self.token and self.chat)

    def hantar(self, teks, img, video=None):
        url = f"https://api.telegram.org/bot{self.token}/"
        if video:
            _post_multipart(url + "sendVideo", {"chat_id": self.chat, "caption": teks, "supports_streaming": "true"},
                            "video", video, "cctv.mp4", "video/mp4")
        elif img is None:
            _post_json(url + "sendMessage", {"chat_id": self.chat, "text": teks})
        else:
            _post_multipart(url + "sendPhoto", {"chat_id": self.chat, "caption": teks}, "photo", _jpg(img))


class WhatsApp:
    """WhatsApp melalui Baileys (whatsapp/server.mjs). Mesej dihantar dari nombor yang imbas QR."""
    nama = "WhatsApp"

    def __init__(self):
        self.url = os.environ.get("WHATSAPP_API", "http://127.0.0.1:3001").rstrip("/")
        self.ke = [x.strip() for x in os.environ.get("WHATSAPP_KE", "").split(",") if x.strip()]
        self.aktif = bool(self.ke)
        self.proses = None

    def status(self):
        try:
            return json.loads(urllib.request.urlopen(self.url + "/status", timeout=1).read())
        except Exception:
            return {"status": "tiada", "nombor": None, "qr": None}

    def mula(self, panggil_balik=None):
        """Jalankan whatsapp/server.mjs jika belum berjalan. `panggil_balik`: URL untuk mesej WhatsApp masuk (bot)."""
        if self.status()["status"] != "tiada":
            if panggil_balik:  # penghantar sudah berjalan: beritahu ke mana mesej masuk perlu dihantar
                try:
                    _post_json(self.url + "/panggil-balik", {"url": panggil_balik}, timeout=3)
                except Exception:
                    pass
            return
        node = shutil.which("node")
        if not node:
            print("[whatsapp] Node.js tiada. Pasang dahulu: brew install node")
            return
        if not (WA_DIR / "node_modules").exists():
            print("[whatsapp] Jalankan sekali dahulu:  cd whatsapp && npm install")
            return
        port = urllib.parse.urlparse(self.url).port or 3001
        env = {**os.environ, "WA_PORT": str(port)}
        if panggil_balik:
            env["WA_PY"] = panggil_balik
        self.proses = subprocess.Popen([node, "server.mjs"], cwd=WA_DIR, env=env)
        atexit.register(self.proses.terminate)
        for _ in range(50):  # tunggu API sedia
            if self.status()["status"] != "tiada":
                break
            time.sleep(0.2)

    def hantar(self, teks, img, video=None):
        badan = {"ke": self.ke, "teks": teks,
                 "gambar": base64.b64encode(_jpg(img)).decode() if img is not None and not video else None,
                 "video": base64.b64encode(video).decode() if video else None}
        try:
            _post_json(self.url + "/hantar", badan, timeout=180 if video else 60)
        except urllib.error.HTTPError as e:
            try:
                ralat = "; ".join(json.loads(e.read()).get("ralat", [])) or str(e)
            except ValueError:
                ralat = str(e)
            raise RuntimeError(ralat)
        except urllib.error.URLError:
            raise RuntimeError("penghantar WhatsApp tidak berjalan")


class Notifikasi:
    def __init__(self, panggil_balik=None):
        self.whatsapp = WhatsApp()
        self.saluran = [s for s in (self.whatsapp, Telegram()) if s.aktif]
        if self.whatsapp.aktif:
            self.whatsapp.mula(panggil_balik)

    @property
    def nama(self):
        return [s.nama for s in self.saluran]

    def hantar_segera(self, teks, img=None, video=None):
        """Hantar ke semua saluran sekarang. -> senarai ralat"""
        ralat = []
        for s in self.saluran:
            try:
                s.hantar(teks, img, video)
            except Exception as e:
                print(f"[{s.nama}] gagal: {e}")
                ralat.append(f"{s.nama}: {e}")
        return ralat

    def hantar(self, teks, img=None, video=None):
        if self.saluran:
            threading.Thread(target=self.hantar_segera, args=(teks, img, video), daemon=True).start()


# ---------------------------------------------------------------- klip video
def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def _tulis_teks(img, teks, org, skala, warna):
    x, y = org
    for dx, dy in ((-1, -1), (1, -1), (-1, 1), (1, 1), (0, 2), (2, 0), (0, -2), (-2, 0)):  # garis luar hitam
        cv2.putText(img, teks, (x + dx, y + dy), cv2.FONT_HERSHEY_SIMPLEX, skala, (0, 0, 0), 1, cv2.LINE_AA)
    cv2.putText(img, teks, org, cv2.FONT_HERSHEY_SIMPLEX, skala, warna, 1, cv2.LINE_AA)


def buat_video(bingkai, anotasi, laluan):
    """bingkai: [(masa, img)], anotasi: [(masa, lebar_asal, [(x, y, w, h, label, warna)])].
    Tulis MP4 H.264 (boleh dimainkan dalam WhatsApp) ke `laluan`. -> bait video atau None"""
    exe = ffmpeg_exe()
    if not exe:
        print("[klip] ffmpeg tiada. Pasang: pip install imageio-ffmpeg")
        return None
    if len(bingkai) < 2:
        return None
    h, w = bingkai[0][1].shape[:2]
    tempoh = bingkai[-1][0] - bingkai[0][0]
    fps = min(30.0, max(2.0, (len(bingkai) - 1) / tempoh)) if tempoh > 0 else 10.0
    anotasi = sorted(anotasi, key=lambda a: a[0])
    masa_a = [a[0] for a in anotasi]
    laluan.parent.mkdir(exist_ok=True)
    p = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                          "-s", f"{w}x{h}", "-r", f"{fps:.3f}", "-i", "-",
                          "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
                          "-movflags", "+faststart", str(laluan)],
                         stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for t, f in bingkai:
            f = cv2.resize(f, (w, h)) if f.shape[:2] != (h, w) else f.copy()
            i = bisect.bisect_right(masa_a, t + 0.1) - 1  # anotasi terkini (dalam 0.6 saat)
            if i >= 0 and t - masa_a[i] < 0.6:
                s = w / anotasi[i][1]
                for x, y, bw, bh, label, warna in anotasi[i][2]:
                    x, y, bw, bh = int(x * s), int(y * s), int(bw * s), int(bh * s)
                    cv2.rectangle(f, (x, y), (x + bw, y + bh), warna, 2)
                    _tulis_teks(f, label, (x, max(14, y - 6)), 0.5, warna)
            _tulis_teks(f, datetime.fromtimestamp(t).strftime("%d/%m/%Y %H:%M:%S"), (8, 22), 0.6, (255, 255, 255))
            p.stdin.write(f.tobytes())
        p.stdin.close()
        p.wait(timeout=60)
    except (BrokenPipeError, subprocess.TimeoutExpired):
        p.kill()
    if p.returncode != 0 or not laluan.exists():
        print(f"[klip] gagal buat video: {p.stderr.read().decode(errors='ignore')[:300]}")
        return None
    return laluan.read_bytes()


class PerakamHD:
    """Rakam strim asal kamera tanpa ditukar (kualiti penuh, hampir tiada CPU) dalam potongan ~2 saat.
    Bila orang dikesan, potongan yang meliputi masa itu dicantum menjadi satu MP4."""

    def __init__(self, sumber, simpan_saat=90, audio=True, nama="kamera"):
        self.sumber, self.simpan, self.audio = sumber, simpan_saat, audio
        self.fail = Path(sumber).is_file()
        akar = KLIP_DIR / ".penimbal"
        for lama in akar.glob("*.ts"):  # sisa versi lama (satu kamera)
            lama.unlink(missing_ok=True)
        self.dir = akar / slug(nama)       # folder sendiri untuk setiap kamera
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.exe = ffmpeg_exe()
        self.proses, self.tamat = None, False
        self.kodek = None
        threading.Thread(target=self._loop, daemon=True).start()
        atexit.register(self.tutup)

    def _arahan(self):
        masuk = []
        if "://" in self.sumber:
            # buang paket rosak (WiFi lemah) & berhenti jika kamera senyap 10 saat (supaya disambung semula)
            masuk = ["-timeout", "10000000", "-fflags", "+genpts+discardcorrupt"]
            if self.sumber.startswith("rtsp"):
                masuk = ["-rtsp_transport", "tcp"] + masuk
        if self.fail:
            masuk = ["-re"]  # fail video (ujian): main ikut masa sebenar
        audio = ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "64k"] if self.audio else ["-an"]
        return [self.exe, "-hide_banner", "-loglevel", "error", *masuk, "-i", self.sumber,
                "-map", "0:v:0", "-c:v", "copy", *audio,
                # cap masa berterusan merentasi potongan (tiada reset) -> boleh disambung terus tanpa sentakan.
                # Nama ikut nombor urutan (bukan saat) supaya dua potongan dalam saat yang sama tak bertindih.
                "-f", "segment", "-segment_time", "2", "-segment_format", "mpegts",
                str(self.dir / f"{datetime.now():%Y%m%d%H%M%S}_%06d.ts")]

    def _loop(self):
        while not self.tamat:
            with open(self.dir / "ffmpeg.log", "ab") as log:
                self.proses = subprocess.Popen(self._arahan(), stdin=subprocess.DEVNULL,
                                               stdout=subprocess.DEVNULL, stderr=log)
                while self.proses.poll() is None and not self.tamat:
                    self._bersih()
                    time.sleep(2)
            if self.fail or self.tamat:
                break
            print("[klip-hd] perakam terhenti (kamera terputus?), cuba semula dalam 3 saat ...")
            time.sleep(3)

    def _bersih(self):
        had = time.time() - self.simpan
        for f in self.dir.glob("*.ts"):
            try:
                if f.stat().st_mtime < had:
                    f.unlink()
            except OSError:  # sudah dipadam, atau masih dibuka (Windows)
                pass

    def _senarai(self):
        """-> [(mula, akhir, fail)] ikut masa. Akhir = masa fail terakhir ditulis; mula = akhir potongan sebelumnya."""
        fail = []
        for f in self.dir.glob("*.ts"):
            try:
                fail.append((f.stat().st_mtime, f))
            except OSError:
                pass
        fail.sort()
        out, sebelum = [], None
        for akhir, f in fail:
            mula = sebelum if sebelum is not None and akhir - sebelum < 10 else akhir - 2.5
            out.append((mula, akhir, f))
            sebelum = akhir
        return out

    def _berjalan(self):
        return self.proses is not None and self.proses.poll() is None

    def klip(self, t_dari, t_hingga, laluan, tunggu=40):
        """Cantum potongan yang meliputi [t_dari, t_hingga] ke `laluan`. -> bait MP4 atau None"""
        had = time.time() + tunggu
        def lengkap():  # potongan terakhir masih ditulis semasa perakam berjalan
            seg = self._senarai()
            return seg[:-1] if self._berjalan() else seg
        while time.time() < had:  # tunggu sehingga potongan yang meliputi t_hingga ditutup
            if any(akhir >= t_hingga for _, akhir, _ in lengkap()) or not self._berjalan():
                break
            time.sleep(0.5)
        pilih = [f for mula, akhir, f in lengkap() if akhir > t_dari and mula < t_hingga]
        if not pilih:
            print("[klip-hd] tiada rakaman untuk tempoh ini")
            return None
        # MPEG-TS boleh disambung bait-demi-bait; dengan cap masa berterusan hasilnya lancar tanpa jurang
        gabung = laluan.with_suffix(".ts")
        with open(gabung, "wb") as out:
            for f in pilih:
                try:
                    out.write(f.read_bytes())
                except OSError:
                    pass
        if self.kodek is None:  # semak kodek kamera sekali
            r = subprocess.run([self.exe, "-hide_banner", "-i", str(pilih[0])], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.kodek = "hevc" if "Video: hevc" in r.stderr else "h264"
            if self.kodek == "hevc":
                print("[klip-hd] kamera guna H.265 - klip akan ditukar ke H.264 supaya boleh dimain di WhatsApp")
        video = ["-c:v", "copy"] if self.kodek == "h264" else \
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]
        r = subprocess.run([self.exe, "-hide_banner", "-loglevel", "error", "-y", "-i", str(gabung),
                            *video, "-c:a", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart",
                            str(laluan)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        gabung.unlink(missing_ok=True)
        if r.returncode != 0 or not laluan.exists():
            print(f"[klip-hd] gagal cantum: {r.stderr[:300]}")
            return None
        return laluan.read_bytes()

    def tutup(self):
        self.tamat = True
        if self._berjalan():
            self.proses.terminate()


class Klip:
    """Satu klip yang sedang dirakam: bingkai sebelum + selepas orang dikesan."""

    def __init__(self, awal, t_mula, t_tamat):
        self.bingkai = list(awal)
        self.t_mula, self.t_tamat = t_mula, t_tamat
        self.masa_dinding = time.time()
        self.baris = []        # baris mesej, cth ["🏠 Isteri dah balik", "🏠 Adik dah balik"]
        self.label = []        # untuk nama fail
        self.asing = False     # ada orang tidak dikenali -> sertakan pautan page web
        self.img = None        # gambar penuh (jika video gagal)
        self.siap = threading.Event()


# ---------------------------------------------------------------- kamera
class Kamera:
    """Baca bingkai dalam thread supaya sentiasa dapat bingkai terkini (elak lag RTSP)."""

    def __init__(self, sumber, sebelum=3.0, lebar_klip=854):
        self.sumber = int(sumber) if str(sumber).isdigit() else sumber
        self.fail_video = isinstance(self.sumber, str) and Path(self.sumber).is_file()
        self.bingkai, self.tamat = None, False
        self.terkini = None  # bingkai terbaru (untuk paparan langsung), tidak dikosongkan bila dibaca
        self.kunci = threading.Lock()
        # penimbal klip: bingkai kecil beberapa saat terakhir
        self.sebelum, self.lebar_klip = sebelum, lebar_klip
        self.penimbal, self.klip_aktif = deque(), []
        self.kunci_klip = threading.Lock()
        self.masa = self.t_akhir = 0.0
        self.idx, self.t0 = 0, time.time()
        self._buka()
        self.fps_fail = (self.cap.get(cv2.CAP_PROP_FPS) or 15) if self.fail_video else 0
        if not self.fail_video:
            threading.Thread(target=self._loop, daemon=True).start()

    def _buka(self):
        if isinstance(self.sumber, str) and self.sumber.startswith("rtsp"):
            os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
        if isinstance(self.sumber, int) and os.name == "nt":
            self.cap = cv2.VideoCapture(self.sumber, cv2.CAP_DSHOW)  # webcam Windows: lebih cepat dibuka
        else:
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
            t = self._terima(f)
            with self.kunci:
                self.bingkai = (t, f)
            self.terkini = f

    def _terima(self, f):
        """Masukkan bingkai ke penimbal klip. -> masa bingkai"""
        t = self.t0 + self.idx / self.fps_fail if self.fail_video else time.time()
        self.idx += 1
        if not self.lebar_klip:
            return t
        h, w = f.shape[:2]
        s = self.lebar_klip / w
        kecil = cv2.resize(f, (self.lebar_klip // 2 * 2, int(h * s) // 2 * 2)) if s < 1 else f[:h // 2 * 2, :w // 2 * 2]
        with self.kunci_klip:
            self.t_akhir = t
            self.penimbal.append((t, kecil))
            while self.penimbal and self.penimbal[0][0] < t - self.sebelum:
                self.penimbal.popleft()
            for k in self.klip_aktif[:]:
                k.bingkai.append((t, kecil))
                if t >= k.t_tamat:
                    self.klip_aktif.remove(k)
                    k.siap.set()
        return t

    def mula_klip(self, selepas):
        with self.kunci_klip:
            k = Klip(self.penimbal, self.t_akhir, self.t_akhir + selepas)
            self.klip_aktif.append(k)
            return k

    def baca(self):
        if self.fail_video:  # fail video: baca berturutan
            ok, f = self.cap.read()
            if not ok:
                self.tamat = True
                return None
            self.masa = self._terima(f)
            self.terkini = f
            return f
        with self.kunci:
            b, self.bingkai = self.bingkai, None
        if b is None:
            return None
        self.masa = b[0]
        return b[1]

    def tutup(self):
        self.tamat = True
        with self.kunci_klip:
            for k in self.klip_aktif:
                k.siap.set()
            self.klip_aktif = []
        self.cap.release()


# ---------------------------------------------------------------- arahan
def cmd_daftar(a):
    enjin = buat_enjin(a.model)
    stor = Stor(enjin, LALAI_AMBANG[enjin.nama]["ambang"], LALAI_AMBANG[enjin.nama]["ambang_kumpul"])
    stor.muat_orang(verbose=True)
    print(f"\nSiap: {len(set(stor.nama))} orang, {len(stor.nama)} gambar berdaftar.")


class KonteksKamera:
    """Satu kamera yang dipantau: sambungan, perakam HD dan klip yang sedang dirakam."""

    def __init__(self, nama, kam, perakam):
        self.nama, self.kam, self.perakam = nama, kam, perakam
        self.anotasi = deque(maxlen=600)  # kotak wajah terkini untuk dilukis dalam klip (mod label)
        self.klip_semasa = None
        self.t_proses = 0.0
        self.penulis = None
        self.calon = {}        # kunci -> deque[(masa, skor)]: pengesanan terkini sebelum disahkan
        self.kelabu_lepas = None  # bingkai kecil sebelumnya (untuk kesan gerakan)
        self.wajah_akhir = 0.0    # masa terakhir wajah dikesan
        self.kesan_akhir = 0.0    # masa terakhir pengesanan wajah dijalankan
        self.cache = []           # [(kotak, cap jari, masa)] dari bingkai sebelumnya
        self.kad_baru = set()  # kad orang asing yang baru dicipta (untuk label 🆕)
        self.sejarah = {}      # kunci -> deque[(masa, saiz wajah)]: untuk tahu arah gerakan
        self.calon_status = {}  # nama -> deque[(masa, skor)]: pengecaman untuk kemas kini status di rumah
        self.arah_baru = set()  # nama yang statusnya baru berubah (notifikasi seterusnya abaikan cooldown)
        self.tertunda = {}     # kunci -> notifikasi yang menunggu arah gerakan jelas


def senarai_kamera(a):
    """-> [(nama, url_kenal, url_hd | None)] dari --kamera "Nama=URL" (atau "Nama=URL|URL_HD"), atau --sumber."""
    if not a.kamera:
        return [("Kamera", a.sumber, a.sumber_hd)]
    out = []
    for x in a.kamera:
        nama, sama, url = x.partition("=")
        nama, url = nama.strip(), url.strip()
        kenal, _, hd = url.partition("|")
        if not sama or not nama or not kenal.strip():
            sys.exit(f'--kamera perlu format "Nama=rtsp://...": {x}')
        if any(n == nama for n, _, _ in out):
            sys.exit(f"Nama kamera berulang: {nama}")
        out.append((nama, kenal.strip(), hd.strip() or None))
    return out


def cmd_pantau(a):
    enjin = buat_enjin(a.model, a.lebar_kesan)
    isi_ambang_lalai(a, enjin)
    if a.ketat:
        a.sahkan, a.tempoh_sahkan = max(a.sahkan, 5), max(a.tempoh_sahkan, 6)
        a.ambang_maklum, a.beza_min = round(a.ambang_maklum + 0.05, 3), max(a.beza_min, 0.10)
    print(f"Pengesahan notifikasi: {a.sahkan} pengesanan dalam {a.tempoh_sahkan:g}s, purata skor >= {a.ambang_maklum}, "
          f"beza dengan orang lain >= {a.beza_min}, separuh wajah jelas (>= {a.saiz_min_maklum}px, menghadap)")
    print(f"Had skor: kenal {a.ambang} | notifikasi {a.ambang_maklum} | kumpul wajah baru {a.ambang_kumpul}")
    stor = Stor(enjin, a.ambang, a.ambang_kumpul, a.maks_gambar, a.selang_simpan, a.saiz_min)
    stor.bersih(a.simpan_hari)
    print(f"CCTV Kenal Orang versi {VERSI}")
    print(f"Orang berdaftar: {len(set(stor.nama))} ({', '.join(sorted(set(stor.nama))) or '-'})")
    print(f"Kumpulan wajah belum dinamakan: {len(stor.kumpulan)}")

    TANGKAPAN.mkdir(exist_ok=True)
    stor.tulis_log(None)  # buka fail log hari ini

    pautan = ""
    if a.port:
        pautan = mula_web(stor, a.port, a.kata_laluan, a.port_https)
        print(f"Page web: {pautan}  (buka dari telefon/komputer dalam WiFi yang sama)")
    notif = Notifikasi(f"http://127.0.0.1:{a.port}/api/wa-masuk" if a.port else None)
    stor.notif = notif
    print("Notifikasi:", ", ".join(notif.nama) or "tiada (set WHATSAPP_KE untuk WhatsApp, lihat README)")
    senyap = stor.tetapan["senyap"]
    print("Orang yang tidak hantar notifikasi:", ", ".join(senyap) if senyap else "-")

    kali_akhir = {}   # kunci@kamera -> masa terakhir dilog (untuk cooldown)
    kali_maklum = {}  # kunci -> masa terakhir notifikasi (sama untuk semua kamera: tiada notifikasi berganda)
    guna_video = not a.tanpa_video and bool(ffmpeg_exe())
    kamera = []
    for nama, sumber, sumber_hd in senarai_kamera(a):
        perakam = None
        if guna_video:
            shd = sumber_hd or sumber
            boleh_hd = "://" in shd or Path(shd).is_file()
            if a.klip_mod == "hd" or (a.klip_mod == "auto" and boleh_hd):
                if not boleh_hd:
                    sys.exit(f"--klip-mod hd perlukan kamera RTSP ({nama})")
                perakam = PerakamHD(shd, simpan_saat=a.klip_sebelum + a.klip_selepas + 90,
                                    audio=not a.tanpa_audio, nama=nama)
        kam = Kamera(sumber, a.klip_sebelum, a.klip_lebar if guna_video and not perakam else 0)
        kamera.append(KonteksKamera(nama, kam, perakam))
    stor.kamera = {kk.nama: kk.kam for kk in kamera}
    banyak = len(kamera) > 1
    if banyak:
        print("Kamera:", ", ".join(kk.nama for kk in kamera))
    if not a.tanpa_video and not guna_video:
        print("Klip video: tidak aktif - ffmpeg tiada (pip install imageio-ffmpeg)")
    elif not guna_video:
        print("Klip video: dimatikan")
    else:
        mod = "HD asal kamera" + (", tanpa bunyi" if a.tanpa_audio else "") if kamera[0].perakam \
            else f"berlabel {a.klip_lebar}px"
        print(f"Klip video: {a.klip_sebelum:g}s sebelum + {a.klip_selepas:g}s selepas ({mod})")
    threads_klip = []

    def susun_teks(baris, masa_dinding, asing, nama_kamera):
        t = "\n".join(baris)
        if banyak:
            t += f"\n📍 {nama_kamera}"
        t += f"\n🕒 {datetime.fromtimestamp(masa_dinding):%d/%m %I:%M %p}"
        return t + (f"\nNamakan di {pautan}" if asing and pautan else "")

    def hantar_klip(k, kk):
        if kk.perakam:
            time.sleep(1.5)  # beri masa orang lain yang sampai serentak digabung
        else:
            k.siap.wait(timeout=a.klip_selepas + 60)
        label = "+".join(dict.fromkeys(slug(x) for x in k.label))[:80]
        nama_fail = f"{datetime.fromtimestamp(k.masa_dinding):%Y%m%d-%H%M%S}_{label}"
        if banyak:
            nama_fail += f"__{slug(kk.nama)}"
        laluan = KLIP_DIR / f"{nama_fail}.mp4"
        KLIP_DIR.mkdir(exist_ok=True)
        if kk.perakam:
            video = kk.perakam.klip(k.t_mula - a.klip_sebelum, k.t_tamat, laluan, tunggu=a.klip_selepas + 40)
        else:
            with kk.kam.kunci_klip:
                bingkai = list(k.bingkai)
            video = buat_video(bingkai, list(kk.anotasi), laluan)
        if k.baris:
            notif.hantar_segera(susun_teks(k.baris, k.masa_dinding, k.asing, kk.nama), k.img, video)

    diag_akhir = {}

    def diag_maklum(kunci, mesej):
        """Terangkan kenapa notifikasi belum dihantar (maks sekali setiap 30 saat bagi setiap orang)."""
        if time.time() - diag_akhir.get(kunci, 0) > 30:
            diag_akhir[kunci] = time.time()
            print(f"[maklum] {mesej}")

    def arah_gerakan(sej, mod):
        """Tentukan masuk/keluar dari sejarah wajah [(masa, saiz, x_tengah 0..1)].
        gerak_*: saiz wajah (makin besar = berjalan ke arah kamera). kanan_/kiri_masuk: gerakan melintang dalam video."""
        if len(sej) < 4:
            return None
        n = max(1, len(sej) // 3)
        awal, akhir = list(sej)[:n], list(sej)[-n:]
        if mod in ("kanan_masuk", "kiri_masuk"):
            dx = float(np.median([e[2] for e in akhir])) - float(np.median([e[2] for e in awal]))
            if abs(dx) < 0.06:  # bergerak kurang dari 6% lebar gambar: tak pasti
                return None
            ke_kanan = dx > 0
            return "masuk" if ke_kanan == (mod == "kanan_masuk") else "keluar"
        nisbah = float(np.median([e[1] for e in akhir])) / max(1.0, float(np.median([e[1] for e in awal])))
        if 0.87 <= nisbah <= 1.15:
            return None
        dekat = nisbah > 1.15
        return "masuk" if dekat == (mod == "gerak_masuk") else "keluar"

    def cetus(kk, kunci, nama, kid, img, t_kam, sekarang, arah):
        """Hantar notifikasi (dengan klip) untuk orang yang telah disahkan."""
        if nama is not None:
            baris = stor.mesej_untuk(nama, arah)
        else:
            baris = ("🆕 Orang baru tidak dikenali" if kid in kk.kad_baru else "⚠️ Orang tidak dikenali") + \
                {"masuk": " – sedang masuk", "keluar": " – sedang keluar"}.get(arah, "")
        # 1. status siapa di rumah: SENTIASA dikemas kini bila arah berubah (tidak bergantung pada cooldown notifikasi)
        berubah = nama in kk.arah_baru  # status baru berubah melalui kemas_kini_status() -> tetap maklumkan
        kk.arah_baru.discard(nama)
        if arah and nama is not None and stor.status.get(nama, {}).get("arah") != arah:
            stor.kemas_status(nama, arah, kk.nama)
            berubah = True
            masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            stor.tulis_log([masa, nama, "", "", kk.nama, arah])
            print(f"{masa}  [{arah.upper()}] {nama}" + (f"  [{kk.nama}]" if banyak else ""))
        # 2. notifikasi: cooldown mengelak mesej berulang, tetapi perubahan arah (keluar -> masuk) sentiasa dimaklumkan
        km = f"{kunci}:{arah or '-'}"  # masuk & keluar ada cooldown berasingan
        if sekarang - kali_maklum.get(km, 0) < a.cooldown_maklum and not berubah:
            return
        kali_maklum[km] = sekarang
        kk.kad_baru.discard(kid)
        if arah and nama is None:
            masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            stor.tulis_log([masa, "TIDAK DIKENALI", "", kid or "", kk.nama, arah])
            print(f"{masa}  [{arah.upper()}] TIDAK DIKENALI" + (f"  [{kk.nama}]" if banyak else ""))
        if not guna_video:
            notif.hantar(susun_teks([baris], sekarang, nama is None, kk.nama), img)
            return
        # gabungkan orang yang disahkan dalam 3 saat yang sama (kamera sama) ke dalam satu klip
        k = kk.klip_semasa
        if k is None or k.siap.is_set() or t_kam - k.t_mula > 3:
            k = Klip([], t_kam, t_kam + a.klip_selepas) if kk.perakam else kk.kam.mula_klip(a.klip_selepas)
            k.img = img
            kk.klip_semasa = k
            th = threading.Thread(target=hantar_klip, args=(k, kk), daemon=True)
            th.start()
            threads_klip.append(th)
        k.baris.append(baris)
        k.label.append(nama or "TIDAK-DIKENALI")
        k.asing |= nama is None

    def semak_tertunda(kk, sekarang):
        """Kamera 'ikut arah gerakan': putuskan masuk/keluar bila gerakan sudah jelas atau orang itu hilang."""
        mod = stor.arah_untuk(kk.nama)
        for kunci, t in list(kk.tertunda.items()):
            sej_saiz = kk.sejarah.get(kunci) or deque()
            akhir = sej_saiz[-1][0] if sej_saiz else t["t"]
            if sekarang - t["t"] < 2.5 and sekarang - akhir < 1.5:
                continue  # tunggu lagi
            del kk.tertunda[kunci]
            arah = arah_gerakan(sej_saiz, mod)
            cetus(kk, kunci, t["nama"], t["kid"], t["img"], t["t_kam"], sekarang, arah)

    def proses(kk, img):
        kam = kk.kam
        sekarang = time.time()
        kotak = []
        semak_tertunda(kk, sekarang)
        # --- jimat CPU: langkau pengesanan wajah bila tiada gerakan dan tiada wajah baru-baru ini
        kecil = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(img, (320, 180)), cv2.COLOR_BGR2GRAY), (5, 5), 0)
        gerak = kk.kelabu_lepas is None or float((cv2.absdiff(kecil, kk.kelabu_lepas) > 25).mean()) > 0.0005
        kk.kelabu_lepas = kecil
        if (not a.tanpa_gerakan and not gerak and sekarang - kk.wajah_akhir > 2.0
                and sekarang - kk.kesan_akhir < 10):
            stor.set_bingkai(img, [], kk.nama)
            return
        kk.kesan_akhir = sekarang
        wajah2 = enjin.kesan(img)
        zon = stor.zon_untuk(kk.nama)
        if zon:  # hanya wajah yang berada dalam zon pengesanan
            H, W = img.shape[:2]
            wajah2 = [fc for fc in wajah2
                      if zon[0] <= (fc[0] + fc[2] / 2) / W <= zon[2] and zon[1] <= (fc[1] + fc[3] / 2) / H <= zon[3]]
        asal = img.copy() if wajah2 else img  # salinan bersih: kotak/label tidak masuk ke dalam gambar wajah
        if wajah2:
            kk.wajah_akhir = sekarang
        cache_baru = []
        for face in wajah2:
            # guna semula cap jari wajah yang sama (kedudukan hampir sama) dari bingkai sebelumnya, maks 0.6 saat
            f = None
            for kb, kf, kt in kk.cache:
                if sekarang - kt < 0.6 and iou(face[:4], kb) > 0.5:
                    f, t_f = kf, kt
                    break
            if f is None:
                f, t_f = enjin.ciri(asal, face), sekarang
            cache_baru.append((face[:4].copy(), f, t_f))
            nama, skor, kid = stor.kenal(f)
            mungkin = None  # orang asing yang hampir padan dengan ahli keluarga (belum pasti)
            if nama is None:
                kid, kumpulan_baru = stor.rekod_asing(asal, face, f, kid, sekarang)
                if kumpulan_baru:
                    kk.kad_baru.add(kid)
                kunci = f"asing:{kid}"
                hampir, s_hampir = stor.padan_orang(f)
                if hampir and s_hampir >= a.ambang - 0.04:
                    mungkin = hampir
                label = f"{mungkin}?" if mungkin else "TIDAK DIKENALI" + (f" #{kid[-4:]}" if kid else "")
                label_log = "TIDAK DIKENALI" + (f" #{kid[-4:]}" if kid else "") + (f" (mungkin {mungkin})" if mungkin else "")
                warna = (0, 165, 255) if mungkin else (0, 0, 255)
            else:
                kunci = nama
                pasti = skor >= a.ambang_maklum
                label = nama if pasti else f"{nama}?"
                label_log = label
                warna = (0, 200, 0) if pasti else (0, 165, 255)  # oren = dikenali tetapi belum pasti
            x, y, w, h = face[:4].astype(int)
            lukis_tag(img, x, y, w, h, f"{label} {skor:.2f}", warna, 0.6)
            kotak.append((x, y, w, h, label, warna))

            # --- log (sekali setiap --cooldown saat bagi setiap orang, setiap kamera)
            if sekarang - kali_akhir.get(f"{kunci}@{kk.nama}", 0) >= a.cooldown:
                kali_akhir[f"{kunci}@{kk.nama}"] = sekarang
                stor.tambah_peristiwa(kk.nama, label if nama or mungkin else "TIDAK DIKENALI", warna,
                                      potong_segi(asal, face))
                masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                stor.tulis_log([masa, nama or "TIDAK DIKENALI", f"{skor:.3f}", kid or "", kk.nama])
                print(f"{masa}  {label_log:<22} skor={skor:.2f}" + (f"  [{kk.nama}]" if banyak else ""))
                if nama is None:
                    cv2.imwrite(str(TANGKAPAN / f"asing_{datetime.now():%Y%m%d_%H%M%S}_{slug(kk.nama)}.jpg"), img)

            # --- status di rumah (syarat lebih ringan dari notifikasi): kamera MASUK/KELUAR yang kenal ahli keluarga
            if nama is not None:
                stor.dikesan[nama] = {"t": sekarang, "kamera": kk.nama, "skor": skor}
            mod_arah = stor.arah_untuk(kk.nama)
            if nama is not None and mod_arah in ("masuk", "keluar"):
                cs = kk.calon_status.setdefault(nama, deque())
                cs.append((sekarang, skor))
                while cs and cs[0][0] < sekarang - a.tempoh_sahkan:
                    cs.popleft()
                yakin = skor >= a.ambang_maklum + 0.1 or (len(cs) >= 2 and np.mean([v for _, v in cs]) >= a.ambang_maklum)
                if yakin and stor.status.get(nama, {}).get("arah") != mod_arah and stor.beza_kedua(f, nama) >= a.beza_min:
                    stor.kemas_status(nama, mod_arah, kk.nama)
                    kk.arah_baru.add(nama)
                    masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    stor.tulis_log([masa, nama, f"{skor:.3f}", "", kk.nama, mod_arah])
                    print(f"{masa}  [{mod_arah.upper()}] {nama} (status dikemas kini)" + (f"  [{kk.nama}]" if banyak else ""))

            # --- sejarah saiz wajah (untuk arah gerakan: makin besar = berjalan ke arah kamera)
            ss = kk.sejarah.setdefault(kunci, deque(maxlen=80))
            ss.append((sekarang, float(max(w, h)), (x + w / 2) / img.shape[1]))
            while ss and ss[0][0] < sekarang - 8:
                ss.popleft()
            if len(kk.sejarah) > 200:
                kk.sejarah = {k: v for k, v in kk.sejarah.items() if v and v[-1][0] >= sekarang - 8}

            # --- pengesahan: notifikasi hanya bila orang yang sama dikesan beberapa kali dengan yakin
            elok = bool(min(w, h) >= a.saiz_min_maklum and stor._menghadap(face))  # wajah jelas & menghadap
            beza = stor.beza_kedua(f, nama) if nama is not None else 0.0
            sej = kk.calon.setdefault(kunci, deque())
            sej.append((sekarang, skor, elok, beza))
            while sej and sej[0][0] < sekarang - a.tempoh_sahkan:
                sej.popleft()
            if len(kk.calon) > 200:
                kk.calon = {k: v for k, v in kk.calon.items() if v and v[-1][0] >= sekarang - a.tempoh_sahkan}
            if len(sej) < a.sahkan:
                continue
            bil_elok = sum(1 for _, _, e, _ in sej if e)
            perlu_elok = -(-a.sahkan // 2)  # sekurang-kurangnya separuh pengesanan mesti wajah yang jelas
            if nama is not None:
                if not stor.maklum_hidup(nama):
                    continue
                purata = float(np.mean([sk for _, sk, _, _ in sej]))
                beza_min = min(b for _, _, _, b in sej)
                sebab = (f"skor {purata:.2f} < {a.ambang_maklum}" if purata < a.ambang_maklum else
                         f"terlalu mirip orang lain (beza {beza_min:.2f} < {a.beza_min})" if beza_min < a.beza_min else
                         f"wajah kurang jelas/sisi ({bil_elok}/{len(sej)} jelas)" if bil_elok < perlu_elok else None)
                if sebab:
                    diag_maklum(f"{nama}@{kk.nama}", f"{nama} dikesan tetapi belum pasti: {sebab}")
                    continue
            else:
                if a.tanpa_maklum_asing or mungkin or max(sk for _, sk, _, _ in sej) >= a.ambang - 0.04:
                    continue  # mungkin ahli keluarga dalam keadaan sukar (malam/sisi): jangan beri amaran palsu
                if bil_elok < perlu_elok:
                    diag_maklum(f"asing@{kk.nama}", "orang tidak dikenali, tetapi wajah kurang jelas: amaran tidak dihantar")
                    continue
            sej.clear()
            mod = stor.arah_untuk(kk.nama)
            if mod in MOD_GERAK:
                if kunci not in kk.tertunda:  # tunggu arah gerakan jelas sebelum hantar
                    kk.tertunda[kunci] = {"nama": nama, "kid": kid, "img": img, "t": sekarang, "t_kam": kam.masa}
                continue
            cetus(kk, kunci, nama, kid, img, kam.masa, sekarang, mod if mod in ("masuk", "keluar") else None)

        kk.cache = cache_baru
        if kotak:
            kk.anotasi.append((kam.masa, img.shape[1], kotak))
        stor.set_bingkai(img, kotak, kk.nama)
        if a.rakam:
            if kk.penulis is None:
                fail = a.rakam if not banyak else str(Path(a.rakam).with_stem(f"{Path(a.rakam).stem}_{slug(kk.nama)}"))
                kk.penulis = cv2.VideoWriter(fail, cv2.VideoWriter_fourcc(*"mp4v"), 15,
                                             (img.shape[1], img.shape[0]))
            kk.penulis.write(img)
        if a.papar:
            cv2.imshow(f"CCTV kenal orang - {kk.nama}", img)

    t_bersih = 0.0
    print("Memantau... tekan Ctrl+C (atau 'q' dalam tetingkap) untuk berhenti.")
    try:
        while True:
            aktif = [kk for kk in kamera if not kk.kam.tamat]
            if not aktif:
                break
            if time.time() - t_bersih > 3600:
                stor.bersih(a.simpan_hari)
                t_bersih = time.time()
            diproses = False
            for kk in aktif:  # setiap kamera diproses bergilir, maks --fps bingkai sesaat setiap satu
                if a.fps and not kk.kam.fail_video and time.time() - kk.t_proses < 1 / a.fps:
                    continue
                img = kk.kam.baca()
                if img is None:
                    continue
                kk.t_proses = time.time()
                proses(kk, img)
                diproses = True
            if a.papar and cv2.waitKey(1) & 0xFF == ord("q"):
                break
            if not diproses:
                time.sleep(0.01)
        if all(kk.kam.fail_video for kk in kamera):
            for kk in kamera:
                semak_tertunda(kk, time.time() + 10)  # putuskan arah yang masih menunggu
            for kk in kamera:
                kk.kam.tutup()  # siapkan klip yang masih dirakam
            for th in threads_klip:
                th.join(timeout=120)
            if a.port and a.kekal:
                print("Video tamat. Page web masih berjalan - Ctrl+C untuk berhenti.")
                while True:
                    time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for kk in kamera:
            kk.kam.tutup()
            if kk.penulis:
                kk.penulis.release()
        stor.tutup_log()
        if a.papar:
            cv2.destroyAllWindows()
        print(f"\nBerhenti. Log: {stor.log_path}")


def main():
    for strim in (sys.stdout, sys.stderr):  # elak ralat emoji di konsol Windows
        try:
            strim.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(description="CCTV kenal orang")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("daftar", help="proses gambar dalam orang/<nama>/ (yang anda letak sendiri)")
    d.add_argument("--model", choices=["arcface", "sface"], default="arcface")
    d.set_defaults(fn=cmd_daftar)

    m = sub.add_parser("pantau", help="pantau kamera, kenal orang & buka page web")
    m.add_argument("--sumber", default="0", help="RTSP URL, nombor webcam (0) atau fail video")
    m.add_argument("--kamera", action="append", metavar='"NAMA=URL"',
                   help='kamera bernama; ulang untuk beberapa kamera, cth --kamera "Pintu Depan=rtsp://..." '
                        '--kamera "Pagar=rtsp://...". Format "Nama=URL_kenal|URL_hd" untuk rakam HD dari strim lain')
    m.add_argument("--port", type=int, default=8000, help="port page web (0 = tutup page web)")
    m.add_argument("--port-https", type=int, default=8443,
                   help="port page web HTTPS, perlu untuk guna kamera telefon dalam page web (0 = tutup)")
    m.add_argument("--kata-laluan", help="kata laluan untuk page web (nama pengguna: apa-apa)")
    m.add_argument("--model", choices=["arcface", "sface"], default="arcface",
                   help="arcface = paling tepat (InsightFace, lebih berat); sface = ringan (OpenCV). Default arcface")
    m.add_argument("--ambang", type=float, default=None,
                   help="had skor untuk dikira 'kenal' (tinggi = lebih ketat). Lalai ikut model")
    m.add_argument("--ambang-kumpul", type=float, default=None,
                   help="had skor untuk kumpulkan wajah baru sebagai orang yang sama. Lalai ikut model")
    m.add_argument("--fps", type=float, default=5, help="bingkai diproses sesaat (0 = semua). Default 5")
    m.add_argument("--cooldown", type=float, default=60,
                   help="saat sebelum orang yang sama dilog/dimaklum semula")
    m.add_argument("--maks-gambar", type=int, default=30, help="maks gambar disimpan bagi setiap wajah baru")
    m.add_argument("--selang-simpan", type=float, default=5, help="saat antara gambar disimpan bagi wajah sama")
    m.add_argument("--saiz-min", type=int, default=60, help="saiz wajah minimum (piksel) untuk disimpan")
    m.add_argument("--lebar-kesan", type=int, default=None,
                   help="lebar gambar semasa mencari wajah. Lalai: 960 untuk arcface (wajah dari ~44px pada 2K), "
                        "1280 untuk sface (~65px). Naikkan untuk wajah lebih jauh (lebih CPU)")
    m.add_argument("--tanpa-gerakan", action="store_true",
                   help="proses setiap bingkai walaupun tiada gerakan (lebih CPU)")
    m.add_argument("--simpan-hari", type=float, default=14,
                   help="padam wajah baru yang tidak dinamakan selepas N hari. Default 14")
    m.add_argument("--papar", action="store_true", help="tunjuk tetingkap video")
    m.add_argument("--rakam", help="simpan video berlabel ke fail .mp4")
    m.add_argument("--cooldown-maklum", type=float, default=600,
                   help="saat sebelum notifikasi untuk orang yang sama dihantar semula. Default 600 (10 min)")
    m.add_argument("--tanpa-maklum-asing", action="store_true",
                   help="jangan hantar notifikasi untuk orang tidak dikenali")
    m.add_argument("--ketat", action="store_true",
                   help="mod paling ketat: 5 pengesanan dalam 6 saat, skor +0.05, beza dengan orang lain >= 0.10")
    m.add_argument("--beza-min", type=float, default=0.06,
                   help="skor orang itu mesti melebihi orang berdaftar kedua paling serupa sekurang-kurangnya ini. "
                        "Default 0.06")
    m.add_argument("--saiz-min-maklum", type=int, default=50,
                   help="saiz wajah minimum (px) untuk dikira 'jelas' semasa pengesahan notifikasi. Default 50")
    m.add_argument("--sahkan", type=int, default=3,
                   help="bilangan pengesanan sebelum notifikasi dihantar. Default 3")
    m.add_argument("--tempoh-sahkan", type=float, default=4,
                   help="dalam berapa saat pengesanan itu mesti berlaku. Default 4")
    m.add_argument("--ambang-maklum", type=float, default=None,
                   help="purata skor minimum untuk hantar notifikasi ahli keluarga (lebih ketat dari --ambang). "
                        "Lalai ikut model")
    m.add_argument("--tanpa-video", action="store_true", help="hantar gambar sahaja, tanpa klip video")
    m.add_argument("--klip-sebelum", type=float, default=3, help="saat video sebelum orang dikesan. Default 3")
    m.add_argument("--klip-selepas", type=float, default=5, help="saat video selepas orang dikesan. Default 5")
    m.add_argument("--klip-mod", choices=["auto", "hd", "label"], default="auto",
                   help="hd = rakaman asal kamera (kualiti penuh + bunyi, tanpa kotak nama); "
                        "label = video 480p dengan kotak nama. auto = hd jika kamera RTSP")
    m.add_argument("--sumber-hd", help="URL RTSP lain untuk rakaman HD (cth stream1), jika --sumber guna stream2")
    m.add_argument("--tanpa-audio", action="store_true", help="klip HD tanpa bunyi")
    m.add_argument("--klip-lebar", type=int, default=854, help="lebar video klip mod label (piksel). Default 854")
    m.add_argument("--kekal", action="store_true", help=argparse.SUPPRESS)  # untuk ujian dengan fail video
    m.set_defaults(fn=cmd_pantau)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
