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
DETECT_WIDTH = 640  # bingkai besar dikecilkan ke lebar ini untuk kesan wajah (lebih laju)
NAMA_SAH = re.compile(r"^[\w][\w .'-]{0,39}$")


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
    def __init__(self, skor_kesan=0.8):
        pastikan_model()
        self.kunci = threading.Lock()  # model OpenCV tidak selamat diguna serentak oleh beberapa thread
        self.det = cv2.FaceDetectorYN.create(
            str(MODEL_DIR / "face_detection_yunet_2023mar.onnx"), "", (320, 320), skor_kesan, 0.3, 5000)
        self.rec = cv2.FaceRecognizerSF.create(
            str(MODEL_DIR / "face_recognition_sface_2021dec.onnx"), "")

    def kesan(self, img):
        """Pulangkan senarai baris wajah (koordinat ikut saiz asal imej)."""
        h, w = img.shape[:2]
        skala = min(1.0, DETECT_WIDTH / w)
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

    def __init__(self, enjin, ambang=0.363, ambang_kumpul=0.45, maks_gambar=30, selang_simpan=5.0,
                 saiz_min=60):
        self.enjin = enjin
        self.ambang, self.ambang_kumpul = ambang, ambang_kumpul
        self.maks_gambar, self.selang_simpan, self.saiz_min = maks_gambar, selang_simpan, saiz_min
        self.kunci = threading.RLock()
        self.bingkai = None
        self.log_path = None
        self.notif = None
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

    # ---- orang berdaftar
    def muat_orang(self, verbose=False):
        nama, ciri = [], []
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
                n += 1
            if verbose:
                print(f"{d.name}: {n} gambar")
        with self.kunci:
            self.nama = np.array(nama)
            self.ciri = np.stack(ciri) if ciri else np.zeros((0, 128), np.float32)

    def padan_orang(self, f):
        if len(self.ciri) == 0:
            return None, 0.0
        s = self.ciri @ f
        i = int(np.argmax(s))
        return str(self.nama[i]), float(s[i])

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
            nama, skor = self.padan_orang(f)
            if nama is not None and skor >= self.ambang:
                return nama, skor, None
            terbaik, kid = -1.0, None
            for k_id, k in self.kumpulan.items():
                s = float(np.max(np.stack(k["ciri"]) @ f))
                if s > terbaik:
                    terbaik, kid = s, k_id
            return None, skor, (kid if terbaik >= self.ambang_kumpul else None)

    def rekod_asing(self, img, face, f, kid, sekarang):
        """Simpan potongan wajah orang tidak dikenali. -> (id_kumpulan | None, kumpulan_baru)"""
        x, y, w, h = face[:4]
        with self.kunci:
            if kid in self.kumpulan:
                k = self.kumpulan[kid]
                k["akhir_lihat"] = sekarang
                if len(k["fail"]) >= self.maks_gambar or sekarang - k["akhir_simpan"] < self.selang_simpan:
                    return kid, False
            crop = self._potong(img, x, y, w, h)
            if min(w, h) < self.saiz_min or crop is None:
                return kid, False  # wajah terlalu kecil/kabur untuk disimpan
            baru = kid not in self.kumpulan
            if baru:
                kid = f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}"
                self.kumpulan[kid] = {"fail": [], "ciri": [], "akhir_simpan": 0.0, "akhir_lihat": sekarang}
            d = WAJAH_BARU / kid
            d.mkdir(exist_ok=True)
            p = d / f"{datetime.now():%Y%m%d-%H%M%S-%f}.jpg"
            cv2.imwrite(str(p), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            np.save(fail_ciri(p), f)
            k = self.kumpulan[kid]
            k["fail"].append(p)
            k["ciri"].append(f)
            k["akhir_simpan"] = sekarang
            return kid, baru

    @staticmethod
    def _potong(img, x, y, w, h):
        H, W = img.shape[:2]
        x0, y0 = int(max(0, x - 0.5 * w)), int(max(0, y - 0.6 * h))
        x1, y1 = int(min(W, x + 1.5 * w)), int(min(H, y + 1.5 * h))
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return None
        wajah = img[int(max(0, y)):int(y + h), int(max(0, x)):int(x + w)]
        if wajah.size and cv2.Laplacian(cv2.cvtColor(wajah, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var() < 30:
            return None  # terlalu kabur
        s = 320 / max(crop.shape[:2])
        return cv2.resize(crop, None, fx=s, fy=s) if s < 1 else crop

    def bersih(self, hari):
        """Padam kumpulan wajah baru yang tidak dinamakan selepas beberapa hari."""
        had = time.time() - hari * 86400
        with self.kunci:
            for kid in [k for k, v in self.kumpulan.items() if v["akhir_lihat"] < had]:
                self.buang_kumpulan(kid)
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

    def label(self, kid, nama, keluarkan=()):
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
                gambar = [{"url": url(p), "rel": p.relative_to(ROOT).as_posix()} for p in senarai_gambar(d)]
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
                klip.append({"url": "/klip/" + urllib.parse.quote(f.name), "masa": masa,
                             "label": f.stem[16:].replace("+", ", ").replace("_", " ")})
        return {"baru": baru, "orang": orang, "log": log, "klip": klip,
                "saluran": self.notif.nama if self.notif else [],
                "whatsapp": self.notif.whatsapp.status()
                if self.notif and self.notif.whatsapp.aktif else None}

    def set_bingkai(self, img):
        self.bingkai = img

    def jpg_terkini(self):
        img = self.bingkai
        if img is None:
            return None
        s = 960 / img.shape[1]
        if s < 1:
            img = cv2.resize(img, None, fx=s, fy=s)
        return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()


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
                    self._strim()
                elif path.startswith("/klip/"):
                    self._klip(urllib.parse.unquote(path[len("/klip/"):]))
                else:
                    self._hantar(404, "text/plain", b"tiada")
            except ValueError as e:
                self._json({"ralat": str(e)}, 400)
            except (BrokenPipeError, ConnectionResetError):
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

        def _strim(self):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=bingkai")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                jpg = stor.jpg_terkini()
                if jpg:
                    self.wfile.write(b"--bingkai\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                time.sleep(0.25)

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
                elif url.path == "/api/buang-kumpulan":
                    stor.buang_kumpulan(d.get("id"))
                elif url.path == "/api/buang-gambar":
                    stor.buang_gambar(d.get("rel", ""))
                elif url.path == "/api/padam-orang":
                    stor.padam_orang(d.get("nama"))
                elif url.path == "/api/maklum":
                    stor.set_maklum(d.get("nama"), bool(d.get("hidup")))
                elif url.path == "/api/mesej":
                    stor.set_mesej(d.get("nama"), d.get("mesej", ""))
                elif url.path == "/api/uji-maklum":
                    if not stor.notif or not stor.notif.saluran:
                        raise ValueError("Notifikasi belum disetkan. Set WHATSAPP_KE (lihat README).")
                    ralat = stor.notif.hantar_segera("🔔 Ujian notifikasi dari CCTV Kenal Orang", stor.bingkai)
                    if ralat:
                        raise ValueError("Gagal: " + "; ".join(ralat))
                else:
                    return self._json({"ralat": "tiada"}, 404)
                self._json({"ok": True})
            except ValueError as e:
                self._json({"ralat": str(e)}, 400)

    srv = ThreadingHTTPServer(("0.0.0.0", port), H)
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

    def __init__(self, sumber, simpan_saat=90, audio=True):
        self.sumber, self.simpan, self.audio = sumber, simpan_saat, audio
        self.fail = Path(sumber).is_file()
        self.dir = KLIP_DIR / ".penimbal"
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.exe = ffmpeg_exe()
        self.proses, self.tamat = None, False
        self.kodek = None
        threading.Thread(target=self._loop, daemon=True).start()
        atexit.register(self.tutup)

    def _arahan(self):
        masuk = ["-rtsp_transport", "tcp"] if self.sumber.startswith("rtsp") else []
        if self.fail:
            masuk = ["-re"]  # fail video (ujian): main ikut masa sebenar
        audio = ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "64k"] if self.audio else ["-an"]
        return [self.exe, "-hide_banner", "-loglevel", "error", *masuk, "-i", self.sumber,
                "-map", "0:v:0", "-c:v", "copy", *audio,
                "-f", "segment", "-segment_time", "2", "-segment_format", "mpegts",
                "-reset_timestamps", "1", "-strftime", "1", str(self.dir / "%Y%m%d-%H%M%S.ts")]

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
        out = []
        for f in self.dir.glob("*.ts"):
            try:
                out.append((datetime.strptime(f.stem, "%Y%m%d-%H%M%S").timestamp(), f))
            except ValueError:
                pass
        return sorted(out)

    def _berjalan(self):
        return self.proses is not None and self.proses.poll() is None

    def klip(self, t_dari, t_hingga, laluan, tunggu=40):
        """Cantum potongan yang meliputi [t_dari, t_hingga] ke `laluan`. -> bait MP4 atau None"""
        had = time.time() + tunggu
        while time.time() < had:  # tunggu sehingga potongan yang meliputi t_hingga ditutup
            seg = self._senarai()
            if any(t > t_hingga for t, _ in seg) or not self._berjalan():
                break
            time.sleep(0.5)
        seg = self._senarai()
        if self._berjalan() and seg:
            mula_akhir = seg[-1][0]   # potongan terakhir masih ditulis
            seg = seg[:-1]
        else:
            mula_akhir = float("inf")
        pilih = []
        for i, (t, f) in enumerate(seg):
            t_seterus = seg[i + 1][0] if i + 1 < len(seg) else mula_akhir
            if t <= t_hingga and t_seterus > t_dari:
                pilih.append(f)
        if not pilih:
            print("[klip-hd] tiada rakaman untuk tempoh ini")
            return None
        senarai = laluan.with_suffix(".txt")
        senarai.write_text("".join(f"file '{f.as_posix()}'\n" for f in pilih), encoding="utf-8")
        if self.kodek is None:  # semak kodek kamera sekali
            r = subprocess.run([self.exe, "-hide_banner", "-i", str(pilih[0])], capture_output=True, text=True, encoding="utf-8", errors="replace")
            self.kodek = "hevc" if "Video: hevc" in r.stderr else "h264"
            if self.kodek == "hevc":
                print("[klip-hd] kamera guna H.265 - klip akan ditukar ke H.264 supaya boleh dimain di WhatsApp")
        video = ["-c:v", "copy"] if self.kodek == "h264" else \
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]
        r = subprocess.run([self.exe, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                            "-i", str(senarai), *video, "-c:a", "copy", "-bsf:a", "aac_adtstoasc",
                            "-movflags", "+faststart", str(laluan)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        senarai.unlink(missing_ok=True)
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


def cmd_pantau(a):
    enjin = Enjin()
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
        log.writerow(["masa", "nama", "skor", "kumpulan"])
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

    kali_akhir = {}  # kunci -> masa terakhir dilog (untuk cooldown)
    kali_maklum = {}  # kunci -> masa terakhir notifikasi dihantar
    guna_video = not a.tanpa_video and bool(ffmpeg_exe())
    perakam = None
    if guna_video:
        sumber_hd = a.sumber_hd or a.sumber
        boleh_hd = "://" in sumber_hd or Path(sumber_hd).is_file()
        if a.klip_mod == "hd" or (a.klip_mod == "auto" and boleh_hd):
            if not boleh_hd:
                sys.exit("--klip-mod hd perlukan kamera RTSP (atau --sumber-hd rtsp://...)")
            perakam = PerakamHD(sumber_hd, simpan_saat=a.klip_sebelum + a.klip_selepas + 90,
                                audio=not a.tanpa_audio)
    if not a.tanpa_video and not guna_video:
        print("Klip video: tidak aktif - ffmpeg tiada (pip install imageio-ffmpeg)")
    elif not guna_video:
        print("Klip video: dimatikan")
    else:
        mod = "HD asal kamera" + ("" if not a.tanpa_audio else ", tanpa bunyi") if perakam \
            else f"berlabel {a.klip_lebar}px"
        print(f"Klip video: {a.klip_sebelum:g}s sebelum + {a.klip_selepas:g}s selepas ({mod})")
    kam = Kamera(a.sumber, a.klip_sebelum, a.klip_lebar if guna_video and not perakam else 0)
    anotasi = deque(maxlen=600)  # kotak wajah terkini untuk dilukis dalam klip
    klip_semasa = None
    threads_klip = []

    def susun_teks(baris, masa_dinding, asing):
        t = "\n".join(baris) + f"\n🕒 {datetime.fromtimestamp(masa_dinding):%d/%m %I:%M %p}"
        return t + (f"\nNamakan di {pautan}" if asing and pautan else "")

    def hantar_klip(k):
        if perakam:
            time.sleep(1.5)  # beri masa orang lain yang sampai serentak digabung
        else:
            k.siap.wait(timeout=a.klip_selepas + 60)
        label = "+".join(dict.fromkeys(re.sub(r"[^\w-]+", "_", x) for x in k.label))[:80]
        laluan = KLIP_DIR / f"{datetime.fromtimestamp(k.masa_dinding):%Y%m%d-%H%M%S}_{label}.mp4"
        KLIP_DIR.mkdir(exist_ok=True)
        if perakam:
            video = perakam.klip(k.t_mula - a.klip_sebelum, k.t_tamat, laluan, tunggu=a.klip_selepas + 40)
        else:
            with kam.kunci_klip:
                bingkai = list(k.bingkai)
            video = buat_video(bingkai, list(anotasi), laluan)
        teks = susun_teks(k.baris, k.masa_dinding, k.asing)
        if k.baris:
            notif.hantar_segera(teks, k.img, video)
    penulis = None
    t_proses = t_bersih = 0.0
    print("Memantau... tekan Ctrl+C (atau 'q' dalam tetingkap) untuk berhenti.")
    try:
        while not kam.tamat:
            if a.fps and not kam.fail_video:
                tunggu = 1 / a.fps - (time.time() - t_proses)
                if tunggu > 0:
                    time.sleep(tunggu)
            img = kam.baca()
            if img is None:
                time.sleep(0.01)
                continue
            sekarang = t_proses = time.time()
            kotak = []
            if sekarang - t_bersih > 3600:
                stor.bersih(a.simpan_hari)
                t_bersih = sekarang

            for face in enjin.kesan(img):
                f = enjin.ciri(img, face)
                nama, skor, kid = stor.kenal(f)
                kumpulan_baru = False
                if nama is None:
                    kid, kumpulan_baru = stor.rekod_asing(img, face, f, kid, sekarang)
                    label = "TIDAK DIKENALI" + (f" #{kid[-4:]}" if kid else "")
                    kunci = f"asing:{kid}"
                else:
                    label, kunci = nama, nama
                x, y, w, h = face[:4].astype(int)
                warna = (0, 200, 0) if nama else (0, 0, 255)
                cv2.rectangle(img, (x, y), (x + w, y + h), warna, 2)
                cv2.putText(img, f"{label} {skor:.2f}", (x, max(0, y - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, warna, 2)
                kotak.append((x, y, w, h, label, warna))

                if sekarang - kali_akhir.get(kunci, 0) < a.cooldown:
                    continue
                kali_akhir[kunci] = sekarang
                masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                log.writerow([masa, nama or "TIDAK DIKENALI", f"{skor:.3f}", kid or ""])
                log_f.flush()
                print(f"{masa}  {label:<22} skor={skor:.2f}")
                if nama is None:
                    cv2.imwrite(str(TANGKAPAN / f"asing_{datetime.now():%Y%m%d_%H%M%S}.jpg"), img)
                if sekarang - kali_maklum.get(kunci, 0) < a.cooldown_maklum and not kumpulan_baru:
                    continue
                if nama is None and not a.tanpa_maklum_asing:
                    baris = "🆕 Orang baru tidak dikenali" if kumpulan_baru else "⚠️ Orang tidak dikenali"
                elif nama is not None and stor.maklum_hidup(nama):
                    baris = stor.mesej_untuk(nama)
                else:
                    continue
                kali_maklum[kunci] = sekarang
                if not guna_video:
                    notif.hantar(susun_teks([baris], sekarang, nama is None), img)
                    continue
                # gabungkan orang yang dikesan dalam 3 saat yang sama ke dalam satu klip
                if klip_semasa is None or klip_semasa.siap.is_set() or kam.masa - klip_semasa.t_mula > 3:
                    klip_semasa = Klip([], kam.masa, kam.masa + a.klip_selepas) if perakam \
                        else kam.mula_klip(a.klip_selepas)
                    klip_semasa.img = img
                    th = threading.Thread(target=hantar_klip, args=(klip_semasa,), daemon=True)
                    th.start()
                    threads_klip.append(th)
                klip_semasa.baris.append(baris)
                klip_semasa.label.append(nama or "TIDAK-DIKENALI")
                klip_semasa.asing |= nama is None

            if kotak:
                anotasi.append((kam.masa, img.shape[1], kotak))
            stor.set_bingkai(img)
            if a.rakam:
                if penulis is None:
                    penulis = cv2.VideoWriter(a.rakam, cv2.VideoWriter_fourcc(*"mp4v"), 15,
                                              (img.shape[1], img.shape[0]))
                penulis.write(img)
            if a.papar:
                cv2.imshow("CCTV kenal orang", img)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
        if kam.fail_video:
            kam.tutup()  # siapkan klip yang masih dirakam
            for th in threads_klip:
                th.join(timeout=120)
        if kam.fail_video and a.port and a.kekal:
            print("Video tamat. Page web masih berjalan - Ctrl+C untuk berhenti.")
            while True:
                time.sleep(1)
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
    m.add_argument("--port", type=int, default=8000, help="port page web (0 = tutup page web)")
    m.add_argument("--kata-laluan", help="kata laluan untuk page web (nama pengguna: apa-apa)")
    m.add_argument("--ambang", type=float, default=0.363,
                   help="had skor untuk dikira 'kenal' (tinggi = lebih ketat). Default 0.363")
    m.add_argument("--ambang-kumpul", type=float, default=0.45,
                   help="had skor untuk kumpulkan wajah baru sebagai orang yang sama. Default 0.45")
    m.add_argument("--fps", type=float, default=5, help="bingkai diproses sesaat (0 = semua). Default 5")
    m.add_argument("--cooldown", type=float, default=60,
                   help="saat sebelum orang yang sama dilog/dimaklum semula")
    m.add_argument("--maks-gambar", type=int, default=30, help="maks gambar disimpan bagi setiap wajah baru")
    m.add_argument("--selang-simpan", type=float, default=5, help="saat antara gambar disimpan bagi wajah sama")
    m.add_argument("--saiz-min", type=int, default=60, help="saiz wajah minimum (piksel) untuk disimpan")
    m.add_argument("--simpan-hari", type=float, default=14,
                   help="padam wajah baru yang tidak dinamakan selepas N hari. Default 14")
    m.add_argument("--papar", action="store_true", help="tunjuk tetingkap video")
    m.add_argument("--rakam", help="simpan video berlabel ke fail .mp4")
    m.add_argument("--cooldown-maklum", type=float, default=600,
                   help="saat sebelum notifikasi untuk orang yang sama dihantar semula. Default 600 (10 min)")
    m.add_argument("--tanpa-maklum-asing", action="store_true",
                   help="jangan hantar notifikasi untuk orang tidak dikenali")
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
