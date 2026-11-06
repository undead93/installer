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
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
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
TETAPAN = ROOT / "tetapan.json"   # siapa yang tidak hantar notifikasi, dll

MODELS = {
    "face_detection_yunet_2023mar.onnx": "models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": "models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
MIRRORS = [
    "https://github.com/opencv/opencv_zoo/raw/main/",
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/",
]
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
DETECT_WIDTH = 1280  # bingkai besar dikecilkan ke lebar ini untuk kesan wajah (640 terlepas wajah <~135px pada 2K)
NAMA_SAH = re.compile(r"^[\w][\w .'-]{0,39}$")


def slug(teks):
    return re.sub(r"[^\w-]+", "_", teks).strip("_") or "kamera"


def senarai_gambar(folder):
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMG_EXT) if folder.is_dir() else []


def fail_ciri(img_path):
    return img_path.with_name(img_path.name + ".npy")


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


# ---------------------------------------------------------------- stor data
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
            self.ciri = np.stack(ciri) if ciri else np.zeros((0, 128), np.float32)
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

    # ---- kumpulan wajah baru
    def muat_kumpulan(self):
        self.kumpulan = {}
        for d in sorted(p for p in WAJAH_BARU.iterdir() if p.is_dir()):
            fail, ciri = [], []
            for img_path in senarai_gambar(d):
                npy = fail_ciri(img_path)
                if npy.exists():
                    fail.append(img_path)
                    ciri.append(np.load(npy))
            if fail:
                self.kumpulan[d.name] = {"fail": fail, "ciri": ciri, "akhir_simpan": 0.0,
                                         "akhir_lihat": max(p.stat().st_mtime for p in fail)}
            else:
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
                        shutil.move(str(fail_ciri(p)), fail_ciri(baru))
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
                shutil.move(str(fail_ciri(p)), fail_ciri(dest / f"{kid}_{p.name}"))
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
                fail_ciri(p).unlink(missing_ok=True)
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
                fail_ciri(p).unlink(missing_ok=True)
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
            if fail_ciri(p).exists():
                shutil.move(str(fail_ciri(p)), fail_ciri(dest))
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
            if lama in t["mesej"]:
                m = t["mesej"].pop(lama)
                t["mesej"].setdefault(baru, m.replace(lama, baru))
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

    # ---- notifikasi bagi setiap orang
    def maklum_hidup(self, nama):
        return nama not in self.tetapan["senyap"]

    def mesej_untuk(self, nama):
        return self.tetapan["mesej"].get(nama) or f"✅ {nama} dikesan di kamera"

    def set_mesej(self, nama, mesej):
        nama = self.semak_nama(nama)
        mesej = (mesej or "").strip()[:200]
        with self.kunci:
            if mesej:
                self.tetapan["mesej"][nama] = mesej
            else:
                self.tetapan["mesej"].pop(nama, None)
            self._simpan_tetapan()

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
                orang.append({"nama": d.name, "gambar": gambar, "maklum": self.maklum_hidup(d.name),
                              "mesej": self.tetapan["mesej"].get(d.name, "")})
        log = []
        if self.log_path and self.log_path.exists():
            with open(self.log_path, newline="", encoding="utf-8") as fh:
                log = list(csv.reader(fh))[1:][-200:][::-1]
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
                "saluran": self.notif.nama if self.notif else [],
                "whatsapp": self.notif.whatsapp.status()
                if self.notif and self.notif.whatsapp.aktif else None}

    def set_bingkai(self, img, kotak=None, kamera="Kamera"):
        self.bingkai[kamera] = img
        self.bil_bingkai[kamera] = self.bil_bingkai.get(kamera, 0) + 1
        if kotak is not None:
            self.kotak[kamera] = (time.time(), kotak)

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
        t, kotak = self.kotak.get(nama, (0.0, []))
        if time.time() - t < 0.8:
            for x, y, w, h, label, warna in kotak:
                x, y, w, h = int(x * s), int(y * s), int(w * s), int(h * s)
                cv2.rectangle(img, (x, y), (x + w, y + h), warna, 2)
                cv2.putText(img, label, (x, max(14, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, warna, 2)
        return kunci, cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()


# ---------------------------------------------------------------- page web
def mula_web(stor, port, kata_laluan):
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
            if not self._auth():
                return
            url = urllib.parse.urlparse(self.path)
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
                elif url.path == "/api/mesej":
                    stor.set_mesej(d.get("nama"), d.get("mesej", ""))
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

    def mula(self):
        """Jalankan whatsapp/server.mjs jika belum berjalan."""
        if self.status()["status"] != "tiada":
            return
        node = shutil.which("node")
        if not node:
            print("[whatsapp] Node.js tiada. Pasang dahulu: brew install node")
            return
        if not (WA_DIR / "node_modules").exists():
            print("[whatsapp] Jalankan sekali dahulu:  cd whatsapp && npm install")
            return
        port = urllib.parse.urlparse(self.url).port or 3001
        self.proses = subprocess.Popen([node, "server.mjs"], cwd=WA_DIR, env={**os.environ, "WA_PORT": str(port)})
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
    def __init__(self):
        self.whatsapp = WhatsApp()
        self.saluran = [s for s in (self.whatsapp, Telegram()) if s.aktif]
        if self.whatsapp.aktif:
            self.whatsapp.mula()

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
    stor = Stor(Enjin())
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
        self.kad_baru = set()  # kad orang asing yang baru dicipta (untuk label 🆕)


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
    enjin = Enjin(lebar_kesan=a.lebar_kesan)
    stor = Stor(enjin, a.ambang, a.ambang_kumpul, a.maks_gambar, a.selang_simpan, a.saiz_min)
    stor.bersih(a.simpan_hari)
    print(f"Orang berdaftar: {len(set(stor.nama))} ({', '.join(sorted(set(stor.nama))) or '-'})")
    print(f"Kumpulan wajah belum dinamakan: {len(stor.kumpulan)}")

    LOG_DIR.mkdir(exist_ok=True)
    TANGKAPAN.mkdir(exist_ok=True)
    log_path = LOG_DIR / f"{datetime.now():%Y-%m-%d}.csv"
    baru = not log_path.exists()
    log_f = open(log_path, "a", newline="", encoding="utf-8")
    log = csv.writer(log_f)
    if baru:
        log.writerow(["masa", "nama", "skor", "kumpulan", "kamera"])
        log_f.flush()
    stor.log_path = log_path

    pautan = ""
    if a.port:
        pautan = mula_web(stor, a.port, a.kata_laluan)
        print(f"Page web: {pautan}  (buka dari telefon/komputer dalam WiFi yang sama)")
    notif = Notifikasi()
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

    def proses(kk, img):
        kam = kk.kam
        sekarang = time.time()
        kotak = []
        wajah2 = enjin.kesan(img)
        asal = img.copy() if wajah2 else img  # salinan bersih: kotak/label tidak masuk ke dalam gambar wajah
        for face in wajah2:
            f = enjin.ciri(asal, face)
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
            cv2.rectangle(img, (x, y), (x + w, y + h), warna, 2)
            cv2.putText(img, f"{label} {skor:.2f}", (x, max(0, y - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, warna, 2)
            kotak.append((x, y, w, h, label, warna))

            # --- log (sekali setiap --cooldown saat bagi setiap orang, setiap kamera)
            if sekarang - kali_akhir.get(f"{kunci}@{kk.nama}", 0) >= a.cooldown:
                kali_akhir[f"{kunci}@{kk.nama}"] = sekarang
                masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                log.writerow([masa, nama or "TIDAK DIKENALI", f"{skor:.3f}", kid or "", kk.nama])
                log_f.flush()
                print(f"{masa}  {label_log:<22} skor={skor:.2f}" + (f"  [{kk.nama}]" if banyak else ""))
                if nama is None:
                    cv2.imwrite(str(TANGKAPAN / f"asing_{datetime.now():%Y%m%d_%H%M%S}_{slug(kk.nama)}.jpg"), img)

            # --- pengesahan: notifikasi hanya bila orang yang sama dikesan beberapa kali dengan yakin
            sej = kk.calon.setdefault(kunci, deque())
            sej.append((sekarang, skor))
            while sej and sej[0][0] < sekarang - a.tempoh_sahkan:
                sej.popleft()
            if len(kk.calon) > 200:
                kk.calon = {k: v for k, v in kk.calon.items() if v and v[-1][0] >= sekarang - a.tempoh_sahkan}
            if len(sej) < a.sahkan:
                continue
            if nama is not None:
                if float(np.mean([sk for _, sk in sej])) < a.ambang_maklum or not stor.maklum_hidup(nama):
                    continue
                baris = stor.mesej_untuk(nama)
            else:
                if a.tanpa_maklum_asing or mungkin or max(sk for _, sk in sej) >= a.ambang - 0.04:
                    continue  # mungkin ahli keluarga dalam keadaan sukar (malam/sisi): jangan beri amaran palsu
                baris = "🆕 Orang baru tidak dikenali" if kid in kk.kad_baru else "⚠️ Orang tidak dikenali"
            if sekarang - kali_maklum.get(kunci, 0) < a.cooldown_maklum:
                continue
            kali_maklum[kunci] = sekarang
            sej.clear()
            kk.kad_baru.discard(kid)
            if not guna_video:
                notif.hantar(susun_teks([baris], sekarang, nama is None, kk.nama), img)
                continue
            # gabungkan orang yang disahkan dalam 3 saat yang sama (kamera sama) ke dalam satu klip
            k = kk.klip_semasa
            if k is None or k.siap.is_set() or kam.masa - k.t_mula > 3:
                k = Klip([], kam.masa, kam.masa + a.klip_selepas) if kk.perakam \
                    else kam.mula_klip(a.klip_selepas)
                k.img = img
                kk.klip_semasa = k
                th = threading.Thread(target=hantar_klip, args=(k, kk), daemon=True)
                th.start()
                threads_klip.append(th)
            k.baris.append(baris)
            k.label.append(nama or "TIDAK-DIKENALI")
            k.asing |= nama is None

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
        log_f.close()
        if a.papar:
            cv2.destroyAllWindows()
        print(f"\nBerhenti. Log: {log_path}")


def main():
    for strim in (sys.stdout, sys.stderr):  # elak ralat emoji di konsol Windows
        try:
            strim.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(description="CCTV kenal orang")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("daftar", help="proses gambar dalam orang/<nama>/ (yang anda letak sendiri)")
    d.set_defaults(fn=cmd_daftar)

    m = sub.add_parser("pantau", help="pantau kamera, kenal orang & buka page web")
    m.add_argument("--sumber", default="0", help="RTSP URL, nombor webcam (0) atau fail video")
    m.add_argument("--kamera", action="append", metavar='"NAMA=URL"',
                   help='kamera bernama; ulang untuk beberapa kamera, cth --kamera "Pintu Depan=rtsp://..." '
                        '--kamera "Pagar=rtsp://...". Format "Nama=URL_kenal|URL_hd" untuk rakam HD dari strim lain')
    m.add_argument("--port", type=int, default=8000, help="port page web (0 = tutup page web)")
    m.add_argument("--kata-laluan", help="kata laluan untuk page web (nama pengguna: apa-apa)")
    m.add_argument("--ambang", type=float, default=0.363,
                   help="had skor untuk dikira 'kenal' (tinggi = lebih ketat). Default 0.363")
    m.add_argument("--ambang-kumpul", type=float, default=0.38,
                   help="had skor untuk kumpulkan wajah baru sebagai orang yang sama. Default 0.38")
    m.add_argument("--fps", type=float, default=5, help="bingkai diproses sesaat (0 = semua). Default 5")
    m.add_argument("--cooldown", type=float, default=60,
                   help="saat sebelum orang yang sama dilog/dimaklum semula")
    m.add_argument("--maks-gambar", type=int, default=30, help="maks gambar disimpan bagi setiap wajah baru")
    m.add_argument("--selang-simpan", type=float, default=5, help="saat antara gambar disimpan bagi wajah sama")
    m.add_argument("--saiz-min", type=int, default=60, help="saiz wajah minimum (piksel) untuk disimpan")
    m.add_argument("--lebar-kesan", type=int, default=DETECT_WIDTH,
                   help="lebar gambar semasa mencari wajah. 1280 kesan wajah dari ~60px pada kamera 2K; "
                        "1920 untuk wajah lebih jauh (lebih CPU); 640 untuk PC lemah. Default 1280")
    m.add_argument("--simpan-hari", type=float, default=14,
                   help="padam wajah baru yang tidak dinamakan selepas N hari. Default 14")
    m.add_argument("--papar", action="store_true", help="tunjuk tetingkap video")
    m.add_argument("--rakam", help="simpan video berlabel ke fail .mp4")
    m.add_argument("--cooldown-maklum", type=float, default=600,
                   help="saat sebelum notifikasi untuk orang yang sama dihantar semula. Default 600 (10 min)")
    m.add_argument("--tanpa-maklum-asing", action="store_true",
                   help="jangan hantar notifikasi untuk orang tidak dikenali")
    m.add_argument("--sahkan", type=int, default=3,
                   help="bilangan pengesanan sebelum notifikasi dihantar. Default 3")
    m.add_argument("--tempoh-sahkan", type=float, default=4,
                   help="dalam berapa saat pengesanan itu mesti berlaku. Default 4")
    m.add_argument("--ambang-maklum", type=float, default=0.42,
                   help="purata skor minimum untuk hantar notifikasi ahli keluarga (lebih ketat dari --ambang). "
                        "Default 0.42")
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
