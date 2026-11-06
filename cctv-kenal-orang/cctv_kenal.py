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
            self.tetapan = json.loads(TETAPAN.read_text())
        except (OSError, ValueError):
            self.tetapan = {}
        self.tetapan.setdefault("senyap", [])  # orang berdaftar yang TIDAK hantar notifikasi
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

    # ---- notifikasi bagi setiap orang
    def maklum_hidup(self, nama):
        return nama not in self.tetapan["senyap"]

    def set_maklum(self, nama, hidup):
        nama = self.semak_nama(nama)
        with self.kunci:
            senyap = set(self.tetapan["senyap"])
            senyap.discard(nama) if hidup else senyap.add(nama)
            self.tetapan["senyap"] = sorted(senyap)
            TETAPAN.write_text(json.dumps(self.tetapan, indent=2, ensure_ascii=False))

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
        url = lambda p: "/fail/" + urllib.parse.quote(str(p.relative_to(ROOT)))
        with self.kunci:
            baru = []
            for kid, k in sorted(self.kumpulan.items(), key=lambda kv: -kv[1]["akhir_lihat"]):
                min_ = np.mean(np.stack(k["ciri"]), axis=0)
                cad, skor = self.padan_orang(min_ / (np.linalg.norm(min_) + 1e-9))
                baru.append({
                    "id": kid, "pendek": kid[-4:],
                    "gambar": [{"url": url(p), "fail": p.name, "rel": str(p.relative_to(ROOT))} for p in k["fail"]],
                    "akhir": datetime.fromtimestamp(k["akhir_lihat"]).strftime("%d/%m %H:%M"),
                    "cadangan": cad if cad and skor >= self.ambang - 0.08 else None,
                })
            orang = []
            for d in sorted(p for p in ORANG.iterdir() if p.is_dir()):
                gambar = [{"url": url(p), "rel": str(p.relative_to(ROOT))} for p in senarai_gambar(d)]
                orang.append({"nama": d.name, "gambar": gambar, "maklum": self.maklum_hidup(d.name)})
        log = []
        if self.log_path and self.log_path.exists():
            with open(self.log_path, newline="") as fh:
                log = list(csv.reader(fh))[1:][-200:][::-1]
        return {"baru": baru, "orang": orang, "log": log,
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
                else:
                    self._hantar(404, "text/plain", b"tiada")
            except ValueError as e:
                self._json({"ralat": str(e)}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass

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


def _post_multipart(url, medan, nama_fail_medan, jpg):
    b = uuid.uuid4().hex
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                    for k, v in medan.items())
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"{nama_fail_medan}\"; filename=\"cctv.jpg\"\r\n"
             f"Content-Type: image/jpeg\r\n\r\n").encode() + jpg + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url, body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return urllib.request.urlopen(req, timeout=30).read()


def _post_json(url, obj):
    req = urllib.request.Request(url, json.dumps(obj).encode(), {"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=30).read()


class Telegram:
    nama = "Telegram"

    def __init__(self):
        self.token = os.environ.get("TELEGRAM_TOKEN")
        self.chat = os.environ.get("TELEGRAM_CHAT_ID")
        self.aktif = bool(self.token and self.chat)

    def hantar(self, teks, img):
        url = f"https://api.telegram.org/bot{self.token}/"
        if img is None:
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

    def hantar(self, teks, img):
        badan = {"ke": self.ke, "teks": teks,
                 "gambar": base64.b64encode(_jpg(img)).decode() if img is not None else None}
        try:
            _post_json(self.url + "/hantar", badan)
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

    def hantar_segera(self, teks, img=None):
        """Hantar ke semua saluran sekarang. -> senarai ralat"""
        ralat = []
        for s in self.saluran:
            try:
                s.hantar(teks, img)
            except Exception as e:
                print(f"[{s.nama}] gagal: {e}")
                ralat.append(f"{s.nama}: {e}")
        return ralat

    def hantar(self, teks, img=None):
        if self.saluran:
            threading.Thread(target=self.hantar_segera, args=(teks, img), daemon=True).start()


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
    log_f = open(log_path, "a", newline="")
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
    kam = Kamera(a.sumber)
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

                if sekarang - kali_akhir.get(kunci, 0) < a.cooldown:
                    continue
                kali_akhir[kunci] = sekarang
                masa = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                masa_pendek = datetime.now().strftime("%d/%m %I:%M %p")
                log.writerow([masa, nama or "TIDAK DIKENALI", f"{skor:.3f}", kid or ""])
                log_f.flush()
                print(f"{masa}  {label:<22} skor={skor:.2f}")
                if nama is None:
                    cv2.imwrite(str(TANGKAPAN / f"asing_{datetime.now():%Y%m%d_%H%M%S}.jpg"), img)
                if sekarang - kali_maklum.get(kunci, 0) < a.cooldown_maklum and not kumpulan_baru:
                    continue
                if nama is None and not a.tanpa_maklum_asing:
                    teks = ("🆕 Orang baru tidak dikenali" if kumpulan_baru else "⚠️ Orang tidak dikenali")
                    teks += f"\n🕒 {masa_pendek}" + (f"\nNamakan di {pautan}" if pautan else "")
                elif nama is not None and stor.maklum_hidup(nama):
                    teks = f"✅ {nama} dikesan di kamera\n🕒 {masa_pendek}"
                else:
                    continue
                kali_maklum[kunci] = sekarang
                notif.hantar(teks, img)

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
    m.add_argument("--kekal", action="store_true", help=argparse.SUPPRESS)  # untuk ujian dengan fail video
    m.set_defaults(fn=cmd_pantau)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
