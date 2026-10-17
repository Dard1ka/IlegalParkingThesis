"""
backend/processor.py
─────────────────────────────────────────────────────────────────
VideoProcessor — versi refactored dari demo3_tts.py.

Perubahan utama vs demo3_tts.py:
  1. ROI tidak lagi dari window interaktif OpenCV, melainkan dari
     SharedState yang di-set frontend via POST /set_roi.
  2. Frame tidak lagi ditampilkan cv2.imshow(), melainkan di-encode
     sebagai JPEG dan ditulis ke SharedState untuk MJPEG stream.
  3. cv2.waitKey() diganti threading.Event (bisa dihentikan dari luar).
  4. Setelah setiap tick, daftar alert ditulis ke SharedState sehingga
     WebSocket bisa meneruskannya ke frontend secara real-time.
  5. Video di-loop otomatis ketika mencapai akhir.
  6. Model dimuat sekali per proses. Pergantian sumber ditangani loop
     pengawas (bukan rekursi), dan kegagalan sumber tidak mematikan
     thread: statusnya dilaporkan lewat SharedState ("proc").
"""

from __future__ import annotations
from collections import OrderedDict
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Tuple, Dict, Optional
import math, time, asyncio, threading, os, hashlib, re, textwrap, traceback

import cv2
import numpy as np
from ultralytics import YOLO

from .shared import SharedState


# ══════════════════════════════════════════════════════════════
# CONFIG  (logika & ambang sama persis dengan demo3_tts.py)
#
# Nilai bertanda [ENV] bisa diatur lewat environment variable. Dibaca
# sekali saat import; nilai tidak valid → default + satu baris peringatan.
# ══════════════════════════════════════════════════════════════
BACKEND_DIR = Path(__file__).resolve().parent


def _env_int(name: str, default: int) -> int:
    """Bilangan bulat >= 1 dari environment."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value < 1:
        print(f"[CONFIG] {name}={raw!r} tidak valid (harus bilangan bulat >= 1), pakai default {default}.")
        return default
    return value


def _env_imgsz(name: str, default: int) -> int:
    """Ukuran input YOLO, dibulatkan ke atas ke kelipatan 32 (stride model)."""
    value   = _env_int(name, default)
    rounded = ((value + 31) // 32) * 32
    if rounded != value:
        print(f"[CONFIG] {name}={value} dibulatkan ke atas menjadi {rounded} (harus kelipatan 32).")
    return rounded


def _env_model(name: str, default: str) -> str:
    """
    Path model: file .pt, atau hasil export-nya — file .onnx (dijalankan
    ONNX Runtime) atau folder (mis. best_openvino_model).
    """
    raw = os.environ.get(name, "").strip()
    if raw and not Path(raw).exists():
        print(f"[CONFIG] {name}={raw!r} tidak ditemukan, pakai default {default!r}.")
        return default
    return raw or default


def _env_tracker() -> str:
    """
    Konfigurasi tracker untuk model.track(). Default "botsort.yaml" bawaan
    Ultralytics (BoT-SORT dengan GMC), sama seperti kode semula. Pilihan lain:
      • "bytetrack.yaml" — bawaan Ultralytics;
      • "botsort_static.yaml" — file bawaan backend (BoT-SORT tanpa GMC).
        Opt-in: lebih ringan, tetapi hasil tracking bisa berbeda (lihat
        komentar di file itu). Nama ini selalu mengarah ke
        backend/botsort_static.yaml, dari folder mana pun backend dijalankan;
      • path ke file YAML sendiri (.yaml / .yml).
    """
    default = "botsort.yaml"
    raw = os.environ.get("PARKING_TRACKER", "").strip()
    if not raw or raw in (default, "bytetrack.yaml"):
        return raw or default
    path = BACKEND_DIR / raw if raw == "botsort_static.yaml" else Path(raw)
    if path.suffix.lower() in (".yaml", ".yml") and path.is_file():
        return str(path.resolve())      # absolut: tidak bergantung pada folder kerja
    print(f"[CONFIG] PARKING_TRACKER={raw!r} tidak ditemukan atau bukan file YAML, "
          f"pakai default {default!r}.")
    return default


VEHICLE_MODEL_PATH  = _env_model("PARKING_VEHICLE_MODEL",  "best.pt")      # [ENV]
TRIANGLE_MODEL_PATH = _env_model("PARKING_TRIANGLE_MODEL", "triangle.pt")  # [ENV]

PARKING_CHECK_SECONDS   = 60
ILLEGAL_PARKING_SECONDS = 300

VEHICLE_IMGSZ        = _env_imgsz("PARKING_VEHICLE_IMGSZ",  960)           # [ENV]
TRIANGLE_IMGSZ       = _env_imgsz("PARKING_TRIANGLE_IMGSZ", 640)           # [ENV]
VEHICLE_CONF         = 0.25
TRIANGLE_CONF        = 0.20
IOU                  = 0.50
EXPAND_MARGIN        = 0.18
ONLY_VEHICLE_CLASSES = ["car", "bus", "truck", "motorcycle"]
TRACKER_CONFIG       = _env_tracker()                                      # [ENV] PARKING_TRACKER

# [ENV] KHUSUS FILE VIDEO: jumlah detik video yang dilewati per tick.
# 1 = perilaku asli (satu frame dianalisis per detik video). Nilai lebih besar
# meringankan CPU dengan mengorbankan ketelitian waktu. Kamera tidak terpengaruh.
TICK_STEP            = _env_int("PARKING_TICK_STEP", 1)

OCCLUSION_TTL_SECONDS              = 80
RELINK_MAX_DISTANCE                = 350
RELINK_FOOT_DISTANCE               = 220
RELINK_IOU_THRESHOLD               = 0.01
HIDDEN_PARKED_LOCK_CENTER_DISTANCE = 200
HIDDEN_PARKED_LOCK_FOOT_DISTANCE   = 120

# ── Penjaga LID ganda, kotak loncat, dan record hantu ─────────
# Hanya logika record: output YOLO, tracker, ambang 60/300 detik, dan cara
# menghitung durasi parkir tidak berubah.
FOUR_WHEEL_CLASSES       = ("car", "truck", "bus")  # kelas yang sering tertukar pada kendaraan yang sama
DEDUPE_IOU               = 0.70  # dua kotak (beda kelas) bertumpuk segini dalam satu tick = satu kendaraan
                                 # (NMS per kelas IoU 0,50 → kotak sekelas tidak pernah setinggi ini)
CROSS_CLASS_IOU          = 0.60  # car/truck/bus boleh dicocokkan lintas kelas bila IoU kotaknya >= ini
                                 # (kotak ganda / kelas tertukar terukur 0,95-1,00)
PARKED_MAX_OUTSIDE       = 0.30  # bagian kotak deteksi yang boleh berada di luar kotak parkir record ...
PARKED_MIN_OUTSIDE_AREA  = 1500  # ... dan luas di luar itu (piksel) baru dihitung meluber
GHOST_TTL_SECONDS        = 20    # record belum parkir / baru parkir sebentar dibuang setelah tersembunyi segini
GHOST_MIN_PARKED_SECONDS = 20    # record yang sudah parkir >= ini saat menghilang tetap OCCLUSION_TTL_SECONDS

STATIONARY_DISTANCE_THRESHOLD = 22.0
STATIONARY_MIN_SECONDS        = 3
MOVING_RESET_SECONDS          = 4
REAPPEAR_GRACE_SECONDS        = 4

# Warna kendaraan. Pita bodi = bagian kotak yang dinilai: 30% atas (kaca depan/belakang,
# atap) dan 30% bawah (ban, bayangan, aspal) dibuang, juga 15% kiri dan kanan (latar /
# pohon di pinggir kotak).
COLOR_CROP_TRIM_BOTTOM = 0.30
COLOR_CROP_TRIM_TOP    = 0.30
COLOR_CROP_TRIM_LEFT   = 0.15
COLOR_CROP_TRIM_RIGHT  = 0.15
HEURISTIC_SAMPLE_SIZE  = 96
COLOR_DARK_V           = 25     # crop yang SEMUA pikselnya V <= ini = "unknown" (gelap total, mis.
                                # kamera malam), sama dengan versi lama
COLOR_CHROMA_MIN_S     = 60     # piksel "berwarna": saturasi HSV (OpenCV, 0-255) minimal ini ...
COLOR_CHROMA_MIN_V     = 50     # ... dan tidak terlalu gelap (hue piksel gelap tidak bermakna)
COLOR_CHROMA_MIN_FRAC  = 0.25   # satu rentang hue harus menutup >= 25% pita bodi; lampu rem,
                                # pelat, dan daun di pinggir kotak tidak cukup luas
COLOR_WHITE_V60        = 170    # putih: persentil-60 kecerahan piksel akromatik >= ini
COLOR_BLACK_V50        = 80     # hitam: median kecerahan piksel akromatik < ini; di antaranya abu-abu
COLOR_VOTE_SAMPLES     = 5      # warna record parkir = mayoritas 5 suara pertama sejak mulai parkir
                                # (satu suara per tick terlihat: file video step 2 -> durasi 4-12 s,
                                # kamera / step 1 -> durasi 3-7 s)
COLOR_SAMPLE_MIN_IOU   = 0.60   # suara ke-2 dst. dilewati bila kotak bergeser / melebar dari parked_bbox

# strip(): "set ENABLE_TTS=false && uvicorn ..." di cmd menyimpan "false " (dengan spasi)
ENABLE_TTS      = os.environ.get("ENABLE_TTS", "true").strip().lower() not in ("false", "0", "no")
TTS_REPEAT_GAP  = 20
EDGE_TTS_VOICE  = "id-ID-GadisNeural"
EDGE_TTS_RATE   = "+0%"
EDGE_TTS_VOLUME = "+0%"
EDGE_TTS_PITCH  = "+0Hz"
TTS_TEMP_DIR    = "outputs/tts_temp"
TTS_QUEUE_SIZE  = 3        # pesan yang boleh antre (di luar yang sedang diputar)
TTS_CACHE_MAX   = 128      # file audio (satu per kalimat) yang disimpan di TTS_TEMP_DIR, juga
                           # antar restart (satu kalimat bisa menyebut beberapa pelanggar sekaligus)
TTS_BACKOFF_MIN = 30.0     # detik jeda setelah sintesis / pemutaran gagal ...
TTS_BACKOFF_MAX = 300.0    # ... digandakan tiap gagal lagi, sampai batas ini
TTS_CLOSE_WAIT  = 2.0      # detik menunggu thread TTS selesai saat processor berhenti
TTS_BYTE_RATE   = 6000     # byte per detik audio: edge-tts selalu mengirim MP3 48 kbit/s CBR
TTS_END_SLACK   = 1.0      # detik: audio utuh boleh lebih pendek segini dari akhir ucapan menurut
                           # metadata edge-tts (terukur 0,03-0,05); lebih pendek lagi = terpotong

# ── Penjadwalan loop (bukan logika deteksi) ───────────────────
SOURCE_POLL_SECONDS    = 0.2    # jeda cek /configure saat belum ada sumber
ROI_POLL_SECONDS       = 0.12   # jeda cek /set_roi saat menunggu zona
UPLOAD_POLL_SECONDS    = 0.2    # jeda cek selesainya unggahan saat tick file video ditunda
GRAB_MAX_SKIP          = 60     # lompatan frame di atas ini pakai seek, bukan grab() berurutan
                                # (terukur: 60 grab ≈ biaya satu seek; di atas itu seek lebih murah)
GRAB_TIME_TOLERANCE    = 0.45   # satuan frame: selisih terbesar yang diterima antara nomor frame hasil
                                # hitungan grab() dan nomor menurut stempel waktunya; lebih dari ini →
                                # sumber itu kembali memakai seek (lihat _read_video_frame).
                                # Seek OpenCV membulatkan stempel waktu ke nomor frame terdekat, jadi
                                # hasilnya baru berbeda dari hitungan mulai selisih 0,5 (terukur pada
                                # klip VFR: paling kecil 0,504). File CFR terukur ≤ 0,04; MKV yang
                                # videonya mulai ~21-23 ms setelah audio punya selisih tetap 0,2-0,5.
CAMERA_READ_RETRIES    = 5      # baca ulang sebelum perangkat kamera dibuka ulang
CAMERA_REOPEN_ATTEMPTS = 3      # buka ulang perangkat sebelum menyerah
CAMERA_RETRY_WAIT      = 0.5    # detik antar percobaan (hanya saat kamera gagal dibuka / dibaca)


def print_effective_config() -> None:
    """Cetak konfigurasi efektif sekali saat startup (dipanggil main.py sebelum thread processor
    dimulai, supaya barisnya tidak bercampur dengan keluaran thread lain)."""
    print(f"[CONFIG] Model kendaraan : {VEHICLE_MODEL_PATH} (imgsz {VEHICLE_IMGSZ})")
    print(f"[CONFIG] Model segitiga  : {TRIANGLE_MODEL_PATH} (imgsz {TRIANGLE_IMGSZ})")
    print(f"[CONFIG] Tracker         : {TRACKER_CONFIG}")
    print(f"[CONFIG] Tick step       : {TICK_STEP} detik video per tick (khusus file video)")
    print(f"[CONFIG] TTS             : {'aktif' if ENABLE_TTS else 'nonaktif'}")


# ══════════════════════════════════════════════════════════════
# HELPER FUNCTIONS  (copy dari demo3_tts.py — pure functions)
# ══════════════════════════════════════════════════════════════

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def box_center(xyxy):
    x1, y1, x2, y2 = xyxy
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

def foot_point(xyxy):
    x1, y1, x2, y2 = xyxy
    return ((x1 + x2) / 2.0, float(y2))

def point_inside_poly(point_xy, poly_points):
    poly = np.array(poly_points, dtype=np.int32)
    return cv2.pointPolygonTest(poly, (float(point_xy[0]), float(point_xy[1])), False) >= 0

def get_anchor_points(xyxy):
    x1, y1, x2, y2 = map(float, xyxy)
    cx = (x1 + x2) / 2.0
    return [
        ((x1 + x2) / 2.0, (y1 + y2) / 2.0),
        (cx, max(y1, y2 - 2)),
        (min(x2, x1 + 2), max(y1, y2 - 2)),
        (max(x1, x2 - 2), max(y1, y2 - 2)),
    ]

def find_roi_index_for_box(xyxy, roi_list):
    anchors   = get_anchor_points(xyxy)
    best_roi  = None
    best_hits = 0
    for idx, roi in enumerate(roi_list):
        hits = sum(1 for pt in anchors if point_inside_poly(pt, roi))
        if hits > best_hits:
            best_hits, best_roi = hits, idx
    return best_roi if best_hits >= 1 else None

def expand_xyxy(xyxy, img_w, img_h, margin):
    x1, y1, x2, y2 = map(float, xyxy)
    bw, bh = x2 - x1, y2 - y1
    dx, dy = bw * margin, bh * margin
    return (
        clamp(int(x1 - dx), 0, img_w - 1),
        clamp(int(y1 - dy), 0, img_h - 1),
        clamp(int(x2 + dx), 0, img_w - 1),
        clamp(int(y2 + dy), 0, img_h - 1),
    )

def euclidean(p1, p2):
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)

def bbox_iou(boxA, boxB):
    ax1, ay1, ax2, ay2 = map(float, boxA)
    bx1, by1, bx2, by2 = map(float, boxB)
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    aA    = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    aB    = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = aA + aB - inter
    return inter / union if union > 0 else 0.0

def spills_outside(det_xyxy, ref_xyxy) -> bool:
    """
    True bila kotak det banyak meluber keluar kotak ref (kotak parkir record):
    bagian di luar ref > PARKED_MAX_OUTSIDE dari luas det DAN > PARKED_MIN_OUTSIDE_AREA
    piksel. Kotak yang menyusut di dalam ref (tertutup sebagian) tidak pernah
    meluber; kotak kecil (motor jauh) yang bergeser beberapa piksel tertahan
    oleh syarat luas minimum.
    """
    ax1, ay1, ax2, ay2 = map(float, det_xyxy)
    bx1, by1, bx2, by2 = map(float, ref_xyxy)
    inter = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    area  = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    out   = area - inter
    return out > PARKED_MAX_OUTSIDE * area and out > PARKED_MIN_OUTSIDE_AREA


# ── Drawing helpers ────────────────────────────────────────────
def draw_all_rois(img, roi_list):
    for idx, roi in enumerate(roi_list):
        poly = np.array([roi], dtype=np.int32)
        cv2.polylines(img, poly, True, (255, 255, 0), 2)
        x0, y0 = roi[0]
        cv2.putText(img, f"ROI {idx + 1} - No Parking Zone",
                    (x0, max(20, y0 - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2, cv2.LINE_AA)

def draw_box(img, xyxy, label, color, thickness=2):
    x1, y1, x2, y2 = map(int, xyxy)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, thickness)
    if label:
        ty = y1 - 8 if y1 - 8 >= 25 else min(img.shape[0] - 10, y2 + 20)
        cv2.putText(img, label, (x1, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.52, color, 2, cv2.LINE_AA)

def draw_dashed_box(img, xyxy, color, thickness=2, dash_len=12):
    x1, y1, x2, y2 = map(int, xyxy)
    def dash(p1, p2):
        dist = int(math.hypot(p2[0] - p1[0], p2[1] - p1[1]))
        if not dist: return
        for i in range(0, dist, dash_len * 2):
            a, b = i / dist, min(i + dash_len, dist) / dist
            cv2.line(img,
                     (int(p1[0] + (p2[0] - p1[0]) * a), int(p1[1] + (p2[1] - p1[1]) * a)),
                     (int(p1[0] + (p2[0] - p1[0]) * b), int(p1[1] + (p2[1] - p1[1]) * b)),
                     color, thickness)
    dash((x1,y1),(x2,y1)); dash((x2,y1),(x2,y2))
    dash((x2,y2),(x1,y2)); dash((x1,y2),(x1,y1))


# ══════════════════════════════════════════════════════════════
# COLOR CLASSIFICATION
#
# Versi lama memilih pemenang dari 12 kelas per piksel dengan ambang V
# mutlak (hitam < 60, putih >= 200). Bodi putih di bawah bayangan pohon
# (V 150-230) terbelah ke "white" dan "gray", sehingga kaca, ban, dan
# bayangan (~30% crop) bisa menang: van putih input4 tercatat "Black".
# Mobil hitam yang memantulkan langit (V 60-100) jatuh ke "gray".
# Kosakata (12 warna + "unknown") tidak berubah: warna_label, kalimat
# TTS, dan COLOR_LABEL di frontend tetap berlaku.
# ══════════════════════════════════════════════════════════════

# Rentang hue OpenCV (0-179) per warna kromatik, sama dengan versi lama
HUE_BINS = (("red", 0, 10), ("orange", 11, 20), ("yellow", 21, 35), ("green", 36, 85),
            ("cyan", 86, 100), ("blue", 101, 130), ("purple", 131, 160), ("pink", 161, 169),
            ("red", 170, 179))

def crop_vehicle_body_for_color(bgr_crop):
    if bgr_crop is None or bgr_crop.size == 0: return bgr_crop
    h, w = bgr_crop.shape[:2]
    if h < 10 or w < 10: return bgr_crop
    t = clamp(int(h * COLOR_CROP_TRIM_TOP),           0,   h - 1)
    b = clamp(int(h * (1 - COLOR_CROP_TRIM_BOTTOM)),  t+1, h)
    l = clamp(int(w * COLOR_CROP_TRIM_LEFT),           0,   w - 1)
    r = clamp(int(w * (1 - COLOR_CROP_TRIM_RIGHT)),    l+1, w)
    return bgr_crop[t:b, l:r]

def classify_vehicle_color_hsv(bgr_crop, sample_size=96):
    """
    Warna dari pita bodi (hasil crop_vehicle_body_for_color). Return (nama, persen).
      0. Crop kosong / < 4 px / gelap total (semua V <= COLOR_DARK_V): "unknown",
         sama dengan versi lama.
      1. Kromatik: piksel S >= COLOR_CHROMA_MIN_S dan V >= COLOR_CHROMA_MIN_V
         dikelompokkan per rentang hue. Bila kelompok terbesar menutup
         >= COLOR_CHROMA_MIN_FRAC dari SELURUH pita, itulah warnanya.
      2. Selain itu akromatik, diputuskan dari sebaran kecerahan piksel
         akromatik (bukan suara per piksel):
           putih   : persentil-60 V >= COLOR_WHITE_V60
           hitam   : median V < COLOR_BLACK_V50
           abu-abu : sisanya (termasuk silver)
    """
    if bgr_crop is None or bgr_crop.size == 0: return "unknown", 0.0
    h, w = bgr_crop.shape[:2]
    if h < 4 or w < 4: return "unknown", 0.0
    crop = cv2.resize(bgr_crop, (sample_size, sample_size), interpolation=cv2.INTER_AREA)
    hsv  = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.int32)
    H, S, V = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    n = H.size
    if not np.any(V > COLOR_DARK_V): return "unknown", 0.0

    chroma = (S >= COLOR_CHROMA_MIN_S) & (V >= COLOR_CHROMA_MIN_V)
    best, cnt = "unknown", 0
    if chroma.any():
        Hc, Vc = H[chroma], V[chroma]
        brown  = (Hc >= 10) & (Hc <= 25) & (Vc < 160)
        counts = {"brown": int(np.sum(brown))}
        for name, lo, hi in HUE_BINS:
            counts[name] = counts.get(name, 0) + int(np.sum((Hc >= lo) & (Hc <= hi) & ~brown))
        best, cnt = max(counts.items(), key=lambda kv: kv[1])
        if cnt >= COLOR_CHROMA_MIN_FRAC * n:
            return best, float(cnt / n * 100)

    Va = V[~chroma]
    if Va.size == 0:                    # semua piksel berwarna tetapi tanpa satu hue dominan
        return best, float(cnt / n * 100)
    v50, v60 = np.percentile(Va, (50, 60))
    if v60 >= COLOR_WHITE_V60: return "white", float(np.mean(Va >= COLOR_WHITE_V60) * 100)
    if v50 <  COLOR_BLACK_V50: return "black", float(np.mean(Va <  COLOR_BLACK_V50) * 100)
    return "gray", float(Va.size / n * 100)


# ══════════════════════════════════════════════════════════════
# TRACK STATE
# ══════════════════════════════════════════════════════════════

@dataclass
class ParkedRecord:
    tracker_id:   Optional[int]
    cls_name:     str
    bbox:         Tuple[int, int, int, int]
    center:       Tuple[float, float]
    roi_idx:      int
    hidden_since:    Optional[int]  = None
    stationary_since: Optional[int] = None
    parked_since:    Optional[int]  = None
    moving_since:    Optional[int]  = None
    reappeared_at:   Optional[int]  = None
    triangle_checked: bool = False
    triangle_found:   bool = False
    illegal_seen:     bool = False   # sudah pernah terlihat berstatus ILEGAL sejak mulai parkir
                                     # (hanya dipakai skor relink, lihat get_best_hidden_match)
    last_alert_time:  int  = -9999
    color_name:       str  = "unknown"
    color_votes:      Dict[str, int] = field(default_factory=dict)   # suara warna sejak reset terakhir
    prev_logic_center: Optional[Tuple[float, float]] = None
    parked_bbox:       Optional[Tuple[int, int, int, int]] = None
    parked_center:     Optional[Tuple[float, float]] = None
    cls_votes:         Dict[str, int] = field(default_factory=dict)   # kelas → berapa kali terdeteksi


def vote_vehicle_color(rec: ParkedRecord, frame: np.ndarray) -> None:
    """
    Satu suara warna dari frame ini untuk record yang TERLIHAT (dipanggil loop
    "Draw: visible" sekali per tick). Suara dikosongkan bersama color_name saat
    record dibuat, mulai parkir, atau di-reset karena bergerak, jadi
    "color_votes kosong" selalu sama dengan "color_name == unknown".
      • Belum parkir: cukup satu suara (seperti dulu: warna langsung tampil).
      • Parkir: COLOR_VOTE_SAMPLES suara, lalu warna tetap. Suara pertama selalu
        diambil (di tick transisi kotak = parked_bbox); suara berikutnya dilewati
        bila kotak bergeser / melebar (IoU dengan parked_bbox < COLOR_SAMPLE_MIN_IOU),
        mis. kotak yang menempel ke kendaraan lewat.
    Tick yang kotak record-nya TIDAK mengikuti deteksi (deteksi meluber keluar / bergeser
    dari kotak parkir) sudah disaring pemanggil, lihat color_skip_ids di _run_inner.
    rec.color_name = mayoritas sementara; seri -> label yang lebih dulu mendapat
    suara (urutan dict). Warna tidak dipakai logika waktu / status.
    """
    limit = COLOR_VOTE_SAMPLES if rec.parked_since is not None else 1
    if sum(rec.color_votes.values()) >= limit:
        return
    if (rec.color_votes and rec.parked_bbox is not None and
            bbox_iou(rec.bbox, rec.parked_bbox) < COLOR_SAMPLE_MIN_IOU):
        return
    x1, y1, x2, y2 = rec.bbox
    crop = frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    name, _ = classify_vehicle_color_hsv(crop_vehicle_body_for_color(crop), HEURISTIC_SAMPLE_SIZE)
    if name == "unknown":
        return      # crop terlalu kecil / gelap total: dicoba lagi tick berikutnya (seperti dulu)
    rec.color_votes[name] = rec.color_votes.get(name, 0) + 1
    rec.color_name = max(rec.color_votes.items(), key=lambda kv: kv[1])[0]


# ══════════════════════════════════════════════════════════════
# TTS  — satu thread pekerja + antrean kecil + cache audio per kalimat
# ══════════════════════════════════════════════════════════════

def _remove_file(path) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


TTS_FILE_RE = re.compile(r"tts_[0-9a-f]{16}\.mp3")     # nama file buatan _tts_audio_path()


def _tts_audio_path(message: str) -> str:
    """
    Path MP3 untuk sebuah kalimat. Nama file = hash kalimat + pengaturan suara,
    jadi selalu sama di setiap proses: audio yang sudah jadi bisa dipakai lagi
    setelah restart, dan tidak terpakai lagi bila pengaturan suara diubah.
    """
    key = "|".join((message, EDGE_TTS_VOICE, EDGE_TTS_RATE, EDGE_TTS_VOLUME, EDGE_TTS_PITCH))
    return os.path.join(TTS_TEMP_DIR, f"tts_{hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]}.mp3")


class TTSSpeaker:
    """
    Menyuarakan peringatan lewat SATU thread pekerja berumur panjang.

      • Satu kalimat bisa menyebut beberapa pelanggar sekaligus. Antrean kecil
        (TTS_QUEUE_SIZE); pesan yang menyebut kendaraan yang sama diganti pesan
        terbaru, supaya suara tidak tertinggal jauh dari video.
      • submit() mengembalikan True hanya bila pesan diterima untuk
        disuarakan; baru saat itu pemanggil memajukan last_alert_time.
      • Audio disimpan per kalimat di TTS_TEMP_DIR dan tetap dipakai setelah
        backend di-restart, jadi kalimat yang sama tidak disintesis ulang
        lewat jaringan. Isi folder dibatasi TTS_CACHE_MAX file; yang paling
        lama tidak dipakai dibuang lebih dulu. Unduhan yang terpotong tidak
        pernah disimpan, dan file yang tidak bisa dimuat dibuang.
      • Jaringan / perangkat audio gagal → jeda (backoff) + satu baris
        peringatan, tanpa traceback. Pesan yang masih antre dan pasti gagal
        ikut dibuang, jadi satu gangguan tidak melipatgandakan jedanya.
      • Thread baru dibuat saat submit() pertama; pygame dan edge_tts baru
        di-import di thread itu (lazy), jadi tidak dimuat bila tidak ada alert.
      • close() (processor berhenti) menghentikan suara dan mengakhiri thread.

    Hanya dibuat bila ENABLE_TTS aktif.
    """

    def __init__(self):
        self._cv = threading.Condition()
        self._queue: List[Tuple[frozenset, str]] = []          # (logical id yang disebut, kalimat)
        self._speaking: Optional[Tuple[frozenset, str]] = None # yang sedang disuarakan
        self._abort       = False                              # minta suara yang berjalan dihentikan
        self._closed      = False                              # close() sudah dipanggil
        self._cache: OrderedDict[str, None] = OrderedDict()    # path MP3 yang sudah jadi; yang paling
                                                               # lama tidak dipakai ada di depan
        self._backoff     = 0.0                                # lama jeda saat ini (detik)
        self._retry_after = 0.0                                # time.monotonic() akhir jeda
        self._audio_down  = False                              # yang gagal perangkat audio, bukan jaringan
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None # event loop milik thread pekerja

        # Audio yang sudah jadi dari proses sebelumnya dipakai lagi (urut dari yang
        # paling lama). Yang dibuang hanya sisa yang bukan audio jadi (unduhan
        # terpotong .part, file sementara versi lama), file kosong, dan
        # kelebihan di atas TTS_CACHE_MAX.
        try:
            Path(TTS_TEMP_DIR).mkdir(parents=True, exist_ok=True)
            finished = []
            for leftover in Path(TTS_TEMP_DIR).glob("tts_*"):
                info = leftover.stat()
                if TTS_FILE_RE.fullmatch(leftover.name) and info.st_size > 0:
                    finished.append((info.st_mtime, leftover.name))
                else:
                    _remove_file(leftover)
            for _, name in sorted(finished):
                self._remember(os.path.join(TTS_TEMP_DIR, name))
        except OSError as e:
            print(f"[TTS] Folder {TTS_TEMP_DIR} tidak bisa disiapkan: {e}")

    # ── Dipanggil dari thread processor ───────────────────────
    def submit(self, logical_ids, message: str) -> bool:
        """
        True bila pesan diterima untuk disuarakan. `logical_ids` = kendaraan yang
        disebut di kalimat (satu kalimat bisa menyebut beberapa pelanggar).
        Pesan antrean yang menyebut salah satu kendaraan yang sama diganti
        pesan ini (daftar pelanggar terbaru), jadi tidak ada kalimat basi.
        """
        lids = frozenset(logical_ids)
        with self._cv:
            if self._closed:
                return False
            if self._speaking is not None and self._speaking[1] == message:
                return False                                   # kalimat yang sama sedang disuarakan
            if self._on_hold(message):
                return False                                   # baru saja gagal → tunggu jedanya habis
            self._queue = [item for item in self._queue if not (item[0] & lids)]
            if len(self._queue) >= TTS_QUEUE_SIZE:
                return False                                   # penuh → dicoba lagi tick berikutnya
            self._queue.append((lids, message))
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, daemon=True, name="TTSSpeaker")
                self._thread.start()
            self._cv.notify()
            return True

    def cancel(self, logical_id: int) -> None:
        """Kendaraan sudah pergi: pesan antrean yang menyebutnya sudah basi."""
        with self._cv:
            self._queue = [item for item in self._queue if logical_id not in item[0]]

    def clear(self) -> None:
        """Sumber / zona berganti atau video diulang: logical id mulai dari 1 lagi."""
        with self._cv:
            self._queue.clear()
            self._abort = True

    def close(self) -> None:
        """Processor berhenti: hentikan suara yang berjalan dan akhiri thread pekerja."""
        with self._cv:
            self._closed = True
            self._queue.clear()
            self._abort = True
            self._cv.notify()
            thread = self._thread
        if thread is not None:
            thread.join(TTS_CLOSE_WAIT)     # sintesis lewat jaringan tidak bisa dipotong → tidak ditunggu lama

    def _on_hold(self, message: str) -> bool:
        """
        (self._cv harus terkunci) Jeda setelah kegagalan masih berjalan DAN
        kalimat ini pasti gagal lagi: perangkat audio bermasalah, atau audionya
        belum ada di cache sehingga perlu jaringan.
        """
        return (time.monotonic() < self._retry_after
                and (self._audio_down or _tts_audio_path(message) not in self._cache))

    def _remember(self, path: str) -> None:
        """
        Catat `path` sebagai audio yang baru saja dipakai, lalu hapus file yang
        paling lama tidak dipakai bila jumlahnya melebihi TTS_CACHE_MAX.
        """
        with self._cv:
            self._cache[path] = None
            self._cache.move_to_end(path)
            evicted = [self._cache.popitem(last=False)[0]
                       for _ in range(len(self._cache) - TTS_CACHE_MAX)]
        for old in evicted:
            _remove_file(old)

    def _forget(self, path: str) -> None:
        """File audio tidak bisa dimuat (rusak): buang, supaya kalimatnya disintesis ulang."""
        with self._cv:
            self._cache.pop(path, None)
        _remove_file(path)

    # ── Thread pekerja ────────────────────────────────────────
    def _run(self):
        # asyncio.run() di thread ini bisa konflik dengan event loop FastAPI,
        # jadi pakai event loop sendiri — satu untuk seumur thread.
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        while True:
            with self._cv:
                while not self._queue and not self._closed:
                    self._cv.wait()
                if self._closed:
                    break
                logical_ids, message = self._queue.pop(0)
                self._speaking, self._abort = (logical_ids, message), False
            audio_stage = False
            try:
                path, from_network = self._audio_for(message)
                audio_stage = True
                self._play(path)
                with self._cv:
                    # Jeda dicabut hanya bila penyebabnya terbukti sudah pulih: audio
                    # dari cache yang berhasil diputar belum membuktikan jaringan normal.
                    if from_network or self._audio_down:
                        self._backoff, self._retry_after = 0.0, 0.0
                    self._audio_down = False
            except Exception as e:
                self._note_failure(e, audio_stage)
            finally:
                with self._cv:
                    self._speaking = None
        self._loop.close()      # close(): thread selesai, event loop-nya ikut dilepas

    def _audio_for(self, message: str) -> Tuple[str, bool]:
        """
        (path MP3, baru_disintesis) untuk kalimat ini: file yang sudah jadi
        dipakai lagi (termasuk peninggalan proses sebelumnya), selain itu
        disintesis sekali lewat jaringan lalu disimpan.
        """
        path = _tts_audio_path(message)
        if os.path.exists(path):
            self._remember(path)
            return path, False

        import edge_tts                                        # lazy import
        part = path + ".part"
        communicate = edge_tts.Communicate(text=message, voice=EDGE_TTS_VOICE, rate=EDGE_TTS_RATE,
                                           volume=EDGE_TTS_VOLUME, pitch=EDGE_TTS_PITCH)
        try:
            speech_end = self._loop.run_until_complete(self._download(communicate, part))
            seconds    = os.path.getsize(part) / TTS_BYTE_RATE
            if seconds == 0:
                raise RuntimeError("audio kosong")
            # Koneksi yang putus di tengah unduhan TIDAK dilaporkan edge-tts sebagai
            # error: stream berakhir biasa dengan audio sebagian. Dikenali dari
            # metadatanya: belum sampai (terukur kadang baru dikirim setelah 43-66%
            # audio), atau audionya lebih pendek daripada akhir ucapan.
            if speech_end is None or seconds < speech_end - TTS_END_SLACK:
                raise RuntimeError(f"audio terpotong (baru {seconds:.1f} detik)")
            with open(part, "rb+") as f:
                os.fsync(f.fileno())      # isinya sudah di disk sebelum dijadikan cache yang awet:
                                          # listrik padam tidak meninggalkan file audio rusak
            os.replace(part, path)        # atomik: file .part tidak pernah terbaca sebagai cache
        finally:
            _remove_file(part)

        self._remember(path)
        return path, True

    @staticmethod
    async def _download(communicate, part: str) -> Optional[float]:
        """
        Tulis audio dari edge-tts ke `part`. Return detik akhir ucapan menurut
        metadata (WordBoundary / SentenceBoundary) yang ikut dikirim, atau None
        bila tidak ada metadata yang sampai.
        """
        speech_end = None
        with open(part, "wb") as f:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif "offset" in chunk and "duration" in chunk:    # satuan 100 nanodetik
                    speech_end = max(speech_end or 0.0, (chunk["offset"] + chunk["duration"]) / 1e7)
        return speech_end

    def _play(self, path: str) -> None:
        import pygame                                          # lazy import
        if not pygame.mixer.get_init():
            pygame.mixer.init()
        music = pygame.mixer.music
        loaded = False
        try:
            music.load(path)
            loaded = True
            if not self._abort:
                music.play()
            while music.get_busy():
                if self._abort:                                # clear(): hentikan suara sumber lama
                    music.stop()
                    break
                time.sleep(0.1)
        finally:
            try:
                music.unload()                                 # lepas kunci file (Windows)
            except Exception:
                pass
            if not loaded:
                self._forget(path)                             # file rusak jangan tinggal di cache

    def _note_failure(self, exc: Exception, audio_stage: bool) -> None:
        """Offline / perangkat audio bermasalah: satu baris peringatan + jeda, tanpa traceback."""
        with self._cv:
            self._backoff     = min(TTS_BACKOFF_MAX, max(TTS_BACKOFF_MIN, self._backoff * 2))
            self._retry_after = time.monotonic() + self._backoff
            self._audio_down  = audio_stage
            # Pesan yang sudah antre dan pasti gagal ikut dibuang: satu gangguan =
            # satu baris peringatan + satu jeda, bukan jeda yang berlipat per pesan.
            # Loop tick mengajukannya lagi setelah TTS_REPEAT_GAP.
            self._queue = [item for item in self._queue if not self._on_hold(item[1])]
            wait = self._backoff
        what   = "Pemutaran audio" if audio_stage else "Sintesis suara"
        reason = " ".join(str(exc).split())[:120]
        print(f"[TTS] {what} gagal ({type(exc).__name__}: {reason}), coba lagi dalam {wait:.0f} detik.")


# ══════════════════════════════════════════════════════════════
# LABEL / STATUS HELPERS  (sama persis)
# ══════════════════════════════════════════════════════════════

def bahasa_label(cls_name: str) -> str:
    return {"car":"mobil","truck":"truk","bus":"bus","motorcycle":"motor"}.get(cls_name.lower(), cls_name)

def warna_label(color_name: str) -> str:
    return {
        "black":"hitam","white":"putih","gray":"abu-abu","red":"merah",
        "orange":"oranye","yellow":"kuning","brown":"cokelat","green":"hijau",
        "cyan":"biru muda","blue":"biru","purple":"ungu","pink":"pink",
        "unknown":"warna tidak diketahui",
    }.get(color_name.lower(), color_name)

def get_elapsed_seconds(rec: ParkedRecord, logic_second: int) -> int:
    if rec.parked_since is None: return 0
    return max(0, logic_second - rec.parked_since)

def hidden_ttl_seconds(rec: ParkedRecord) -> int:
    """
    (rec harus tersembunyi) Lama record dipertahankan dan boleh di-relink.
    Record yang belum parkir, atau baru parkir < GHOST_MIN_PARKED_SECONDS saat
    menghilang (kendaraan yang hanya berhenti sebentar lalu pergi), dibuang
    setelah GHOST_TTL_SECONDS. Record yang sudah lama parkir tetap
    OCCLUSION_TTL_SECONDS dengan durasi penuh, seperti semula.
    """
    if rec.parked_since is None or rec.hidden_since - rec.parked_since < GHOST_MIN_PARKED_SECONDS:
        return GHOST_TTL_SECONDS
    return OCCLUSION_TTL_SECONDS

def choose_status(rec: ParkedRecord, logic_second: int):
    if rec.parked_since is None: return (255, 200, 0), "monitoring"
    d = get_elapsed_seconds(rec, logic_second)
    if d >= ILLEGAL_PARKING_SECONDS and not rec.triangle_found: return (0, 0, 255), "ILEGAL PARKING"
    if d >= PARKING_CHECK_SECONDS:
        if rec.triangle_found: return (0, 255, 0), "aman / mogok"
        return (0, 255, 255), "warning"
    return (255, 200, 0), "monitoring"

def get_required_moving_reset_seconds(rec: ParkedRecord, logic_second: int) -> int:
    if rec.parked_since is None: return MOVING_RESET_SECONDS
    d = get_elapsed_seconds(rec, logic_second)
    if d >= ILLEGAL_PARKING_SECONDS: return 12
    if d >= PARKING_CHECK_SECONDS:   return 10
    return MOVING_RESET_SECONDS

ANGKA_KATA = {2: "dua", 3: "tiga", 4: "empat", 5: "lima", 6: "enam", 7: "tujuh", 8: "delapan",
              9: "sembilan", 10: "sepuluh"}


def describe_vehicle(rec: ParkedRecord) -> str:
    """'mobil berwarna hitam'; warna belum diketahui -> jenisnya saja ('mobil')."""
    jenis = bahasa_label(rec.cls_name)
    if rec.color_name and rec.color_name.lower() != "unknown":
        return f"{jenis} berwarna {warna_label(rec.color_name)}"
    return jenis


def make_warning_text(recs: List[ParkedRecord]) -> str:
    """
    SATU kalimat untuk semua kendaraan yang sedang melanggar, urut sesuai urutan
    `recs`. Deskripsi yang sama digabung dengan jumlahnya:
      1 -> "Mohon untuk mobil berwarna hitam untuk tidak parkir di situ ..."
      2 -> "Mohon untuk mobil berwarna hitam dan truk berwarna biru untuk ..."
      3+ -> "Mohon untuk dua mobil berwarna hitam, truk berwarna biru, dan motor berwarna merah untuk ..."
    """
    counts: "OrderedDict[str, int]" = OrderedDict()
    for rec in recs:
        d = describe_vehicle(rec)
        counts[d] = counts.get(d, 0) + 1
    parts = [d if n == 1 else f"{ANGKA_KATA.get(n, str(n))} {d}" for d, n in counts.items()]
    if len(parts) == 1:
        daftar = parts[0]
    elif len(parts) == 2:
        daftar = f"{parts[0]} dan {parts[1]}"
    else:
        daftar = ", ".join(parts[:-1]) + f", dan {parts[-1]}"
    return (f"Mohon untuk {daftar} untuk tidak parkir di situ atau akan terkena denda "
            f"karena bukan tempat parkir.")


# ══════════════════════════════════════════════════════════════
# RELINKING FUNCTIONS  (sama persis dengan demo3_tts.py, kecuali suku
# warna pada skor. Di sana warna deteksi selalu "unknown", jadi suku
# itu tidak pernah mencocokkan warna: efek nyatanya hanya penalti -100
# untuk record yang warnanya sudah terisi, dan warna baru diisi saat
# kendaraan terlihat berstatus ILEGAL. Efek itu dipertahankan lewat
# rec.illegal_seen, supaya hasil relink tidak berubah)
# ══════════════════════════════════════════════════════════════

def class_compatible(rec_cls: str, det_cls: str, iou: float) -> bool:
    """
    Bolehkah deteksi kelas det_cls dicocokkan ke record berlabel rec_cls?
    Kelas sama → boleh (perilaku semula). car/truck/bus sering tertukar pada
    kendaraan yang sama (Innova car↔truck, L300 truck↔bus↔car; IoU 0,95-1,00),
    jadi boleh lintas kelas asal kotaknya hampir sama (IoU >= CROSS_CLASS_IOU).
    Motor tidak pernah dicocokkan dengan kendaraan roda empat.
    """
    if rec_cls == det_cls:
        return True
    return (rec_cls in FOUR_WHEEL_CLASSES and det_cls in FOUR_WHEEL_CLASSES
            and iou >= CROSS_CLASS_IOU)

def dedupe_tracked_boxes(tracked_now, tracker_to_logical, parked_records, logic_second):
    """
    NMS YOLO dihitung per kelas, jadi satu kendaraan bisa keluar dua kali dalam
    satu frame dengan kelas berbeda (L300 truck + bus/car, Innova car + truck) dan
    kedua kotak bisa mendapat id tracker sendiri → LID ganda. Kotak yang bertumpuk
    IoU >= DEDUPE_IOU dianggap satu kendaraan. Yang dipakai: kotak yang id
    tracker-nya sudah terhubung ke record (durasi terlama, lalu LID terlama), lalu
    confidence, lalu luas. Urutan semula dipertahankan. Hanya daftar milik logika
    ini yang disaring: output YOLO dan state tracker tidak berubah.
    """
    if len(tracked_now) < 2:
        return tracked_now

    def _priority(det):
        x1, y1, x2, y2 = det["bbox"]
        area = (x2 - x1) * (y2 - y1)
        lid  = tracker_to_logical.get(det["tracker_id"])
        rec  = parked_records.get(lid) if lid is not None else None
        if rec is None:
            return (0, 0, 0, det["conf"], area)
        return (1, get_elapsed_seconds(rec, logic_second), -lid, det["conf"], area)

    kept = []
    for det in sorted(tracked_now, key=_priority, reverse=True):
        if all(bbox_iou(det["bbox"], k["bbox"]) < DEDUPE_IOU for k in kept):
            kept.append(det)
    return [det for det in tracked_now if any(det is k for k in kept)]

def get_best_hidden_match(det_bbox, det_center, det_cls_name, det_roi_idx,
                          parked_records, logic_second, used_hidden_ids):
    det_foot = foot_point(det_bbox)

    def _eval(rec):
        if rec.parked_since is not None and rec.parked_bbox is not None:
            ref_bbox, ref_center = rec.parked_bbox, rec.parked_center or rec.center
        else:
            ref_bbox, ref_center = rec.bbox, rec.center
        return (euclidean(det_center, ref_center),
                euclidean(det_foot, foot_point(ref_bbox)),
                bbox_iou(det_bbox, ref_bbox))

    def _ok(rec, cd, fd, iou):
        if cd > RELINK_MAX_DISTANCE: return False
        if not class_compatible(rec.cls_name, det_cls_name, iou): return False
        if rec.hidden_since == logic_second:
            # Baru hilang di tick ini (masih terlihat tick lalu): hanya ID switch
            # di tempat yang sama, jadi kotaknya harus bertumpuk dengan kotak record.
            return iou >= 0.30
        if rec.parked_since is not None:
            return iou >= 0.30 or (cd <= 120 and fd <= 140)
        return not (iou < RELINK_IOU_THRESHOLD
                    and cd > RELINK_MAX_DISTANCE * 0.65
                    and fd > RELINK_FOOT_DISTANCE * 0.65)

    def _score(rec, cd, fd, iou):
        s = iou * 500 - cd * 1.2 - fd * 2.2
        d = get_elapsed_seconds(rec, logic_second)
        s += (600 if d >= ILLEGAL_PARKING_SECONDS else
              450 if d >= PARKING_CHECK_SECONDS else
              300 if rec.parked_since else 0)
        s += d * 8.0
        if rec.illegal_seen and rec.color_name != "unknown":     # "warnanya sudah terisi"
            s -= 100
        return s

    # Pass 1: hanya record yang sudah parked
    best_id, best_s = None, -1e18
    for lid, rec in parked_records.items():
        if lid in used_hidden_ids or rec.hidden_since is None: continue
        if logic_second - rec.hidden_since > hidden_ttl_seconds(rec): continue
        if det_roi_idx is not None and rec.roi_idx != det_roi_idx: continue
        if rec.parked_since is None: continue
        cd, fd, iou = _eval(rec)
        if not _ok(rec, cd, fd, iou): continue
        s = _score(rec, cd, fd, iou)
        if s > best_s: best_s, best_id = s, lid
    if best_id is not None: return best_id

    # Pass 2: record yang belum parked
    for lid, rec in parked_records.items():
        if lid in used_hidden_ids or rec.hidden_since is None: continue
        if logic_second - rec.hidden_since > hidden_ttl_seconds(rec): continue
        if det_roi_idx is not None and rec.roi_idx != det_roi_idx: continue
        if rec.parked_since is not None: continue
        cd, fd, iou = _eval(rec)
        if not _ok(rec, cd, fd, iou): continue
        s = _score(rec, cd, fd, iou)
        if s > best_s: best_s, best_id = s, lid
    return best_id

def get_locked_hidden_parked_record(det_bbox, det_center, det_cls_name, det_roi_idx,
                                    parked_records, logic_second, used_hidden_ids):
    det_foot = foot_point(det_bbox)
    best_id, best_s = None, 1e18
    for lid, rec in parked_records.items():
        if lid in used_hidden_ids: continue
        if rec.hidden_since is None or rec.parked_since is None: continue
        if logic_second - rec.hidden_since > hidden_ttl_seconds(rec): continue
        if rec.roi_idx != det_roi_idx: continue
        ref_bbox   = rec.parked_bbox or rec.bbox
        ref_center = rec.parked_center or rec.center
        cd  = euclidean(det_center, ref_center)
        fd  = euclidean(det_foot, foot_point(ref_bbox))
        iou = bbox_iou(det_bbox, ref_bbox)
        if iou < 0.30: continue
        if not class_compatible(rec.cls_name, det_cls_name, iou): continue
        if cd <= HIDDEN_PARKED_LOCK_CENTER_DISTANCE or fd <= HIDDEN_PARKED_LOCK_FOOT_DISTANCE:
            s = cd + fd * 2 - iou * 500
            if s < best_s: best_s, best_id = s, lid
    return best_id


# ══════════════════════════════════════════════════════════════
# VIDEO PROCESSOR  (class utama)
# ══════════════════════════════════════════════════════════════

class SourceError(RuntimeError):
    """Sumber tidak bisa dipakai (gagal dibuka / dibaca). Pesannya tampil di dashboard."""


def _short_error(exc: BaseException) -> str:
    """Pesan error satu baris untuk status "proc" dan frame placeholder."""
    text = " ".join(str(exc).split())
    if not isinstance(exc, SourceError):
        text = f"{type(exc).__name__}: {text}" if text else type(exc).__name__
    return text[:240]


class VideoProcessor:
    """
    Jalankan processor.run() di background thread.

        shared = SharedState()
        proc   = VideoProcessor(shared)
        t = threading.Thread(target=proc.run, daemon=True)
        t.start()

    Hentikan dengan proc.stop().
    """

    def __init__(self, shared: SharedState):
        self.shared  = shared
        self._stop   = threading.Event()
        self._tts: Optional[TTSSpeaker] = None   # dibuat di run() bila ENABLE_TTS

    def stop(self):
        self._stop.set()

    # ── Konversi ROI dari frontend → pixel polygon ─────────────
    def _decode_roi(self, rois_raw: list, W: int, H: int) -> List[List[Tuple[int, int]]]:
        """
        Frontend mengirim list of polygons:
          [[[x,y], ...], [[x,y], ...], ...]
        di mana x,y ∈ [0,1] relatif terhadap ukuran canvas.
        Kita konversi ke piksel sesuai dimensi video asli.
        """
        result = []
        for polygon_raw in rois_raw:
            polygon = [(int(p[0] * W), int(p[1] * H)) for p in polygon_raw]
            if len(polygon) >= 3:
                result.append(polygon)
        return result if result else []

    def _make_auto_roi(self, W: int, H: int) -> List[List[Tuple[int, int]]]:
        """Mode auto: gunakan seluruh frame sebagai satu ROI."""
        margin = 4
        return [[(margin, margin), (W - margin, margin),
                 (W - margin, H - margin), (margin, H - margin)]]

    # ── Konversi parked_records → list dict untuk JSON ─────────
    def _to_status_str(self, rec: ParkedRecord, logic_second: int) -> str:
        d = get_elapsed_seconds(rec, logic_second)
        if d >= ILLEGAL_PARKING_SECONDS and not rec.triangle_found: return "violation"
        if d >= PARKING_CHECK_SECONDS:
            return "safe" if rec.triangle_found else "warning"
        return "monitoring"

    def _build_alerts(self, parked_records: Dict, logic_second: int) -> List[Dict]:
        """Buat list alert yang bisa di-serialize ke JSON untuk WebSocket."""
        alerts = []
        for lid, rec in parked_records.items():
            if rec.hidden_since is not None:
                continue  # tampilkan hanya kendaraan yang terlihat
            alerts.append({
                "id":       lid,
                "lid":      f"LID-{lid:02d}",
                "type":     rec.cls_name,
                "color":    rec.color_name.capitalize() if rec.color_name != "unknown" else "Unknown",
                "zone":     rec.roi_idx + 1,
                "duration": get_elapsed_seconds(rec, logic_second),
                "status":   self._to_status_str(rec, logic_second),
                "triangle": rec.triangle_found,
            })
        return alerts

    # ── Push frame ke SharedState sebagai JPEG ─────────────────
    def _push_frame(self, frame: np.ndarray):
        ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
        if ok:
            self.shared.set_frame(buf.tobytes())

    def _push_text_frame(self, title: str, lines: List[str],
                         title_color=(60, 60, 80), text_color=(50, 50, 70)):
        """Frame status tanpa video (menunggu sumber / processor berhenti)."""
        blank = np.zeros((480, 854, 3), dtype=np.uint8)
        cv2.putText(blank, title, (60, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.9, title_color, 2)
        for i, line in enumerate(lines):
            cv2.putText(blank, line, (60, 260 + 30 * i),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, text_color, 2)
        self._push_frame(blank)

    def _push_hint_frame(self, frame: np.ndarray, title: str, subtitle: str = ""):
        """Frame diam dari sumber + teks petunjuk (menunggu zona / mulai deteksi)."""
        overlay = frame.copy()      # frame aslinya masih dianalisis di tick pertama
        mid = overlay.shape[0] // 2
        cv2.putText(overlay, title, (30, mid - 20), cv2.FONT_HERSHEY_SIMPLEX,
                    0.85, (0, 210, 230), 2, cv2.LINE_AA)
        if subtitle:
            cv2.putText(overlay, subtitle, (30, mid + 20), cv2.FONT_HERSHEY_SIMPLEX,
                        0.65, (150, 150, 150), 2, cv2.LINE_AA)
        self._push_frame(overlay)

    # ── Kegagalan: dilaporkan, thread tetap hidup ──────────────
    def _fail(self, message: str):
        """
        Status "error" + alert dikosongkan + frame placeholder berisi alasannya.
        Setelah ini processor menunggu /configure berikutnya; sumber yang gagal
        tidak dicoba ulang sendiri.
        """
        self.shared.set_proc_state("error", message)
        self.shared.clear_alerts()
        self._push_text_frame(
            "Processor berhenti",
            textwrap.wrap(message, 58)[:4] + ["Konfigurasi ulang sumber dari dashboard."],
            title_color=(70, 70, 235), text_color=(190, 190, 190))
        print(f"[PROC] Processor berhenti: {message}")

    @staticmethod
    def _describe_source(source: dict) -> str:
        if source.get("type") == "camera":
            return f"kamera index {source.get('index', 0)}"
        return str(source.get("path"))

    @staticmethod
    def _reset_tracker(vehicle_model):
        """
        Kosongkan state BoT-SORT (track, ID, frame GMC) tanpa `predictor = None`:
        cara itu membuat Ultralytics mendaftarkan callback tracker sekali lagi,
        sehingga tracker.update() jalan dua kali per frame.
        """
        predictor = getattr(vehicle_model, "predictor", None)   # None sebelum .track() pertama
        for tracker in getattr(predictor, "trackers", None) or []:
            tracker.reset()

    @staticmethod
    def _tracker_ready(vehicle_model) -> bool:
        """True bila .track() sudah pernah selesai menyiapkan tracker di objek model ini."""
        return hasattr(getattr(vehicle_model, "predictor", None), "trackers")

    # ── Entry point ────────────────────────────────────────────
    def run(self):
        self.shared.set_running(True)
        fatal = None
        try:
            if ENABLE_TTS:
                self._tts = TTSSpeaker()
            self._run_supervisor()
        except Exception as e:
            fatal = _short_error(e)
            print(f"[PROC] Error fatal: {e}")
            traceback.print_exc()
        finally:
            if self._tts is not None:
                self._tts.close()
            self.shared.set_running(False)
            self.shared.set_proc_state("stopped", fatal)
            print("[PROC] Processor berhenti.")

    def _load_models(self):
        """Muat kedua model YOLO. Return (vehicle_model, triangle_model), atau None bila gagal."""
        self.shared.set_proc_state("loading_models")
        print("[PROC] Memuat model YOLO...")
        try:
            # task="detect": model hasil export (mis. folder OpenVINO) tidak bisa
            # ditebak task-nya dari nama file. Untuk .pt argumen ini tidak
            # berpengaruh, task tetap dibaca dari checkpoint.
            vehicle_model  = YOLO(VEHICLE_MODEL_PATH,  task="detect")
            triangle_model = YOLO(TRIANGLE_MODEL_PATH, task="detect")
        except Exception as e:
            traceback.print_exc()
            self._fail(f"Model YOLO gagal dimuat: {_short_error(e)}")
            return None
        print("[PROC] Model dimuat.")
        return vehicle_model, triangle_model

    def _run_supervisor(self):
        """
        Loop pengawas: model dimuat SEKALI per proses, lalu sumber diproses satu
        per satu. Sumber baru atau sumber yang gagal mengembalikan kendali ke
        loop ini (tanpa rekursi), jadi tidak ada kegagalan sumber yang mematikan
        thread.
        """
        # 1. Load YOLO models
        models = self._load_models()

        # 2. Tampilkan layar tunggu sampai user konfigurasi sumber
        if models is not None:
            self.shared.set_proc_state("waiting_source")
            self._push_text_frame("Menunggu konfigurasi sumber...",
                                  ["Buka dashboard → pilih Video atau Kamera"])
            print("[PROC] Menunggu konfigurasi sumber dari frontend...")

        source = None
        while not self._stop.is_set():
            # Hanya sumber yang BARU dikirim /configure yang diambil (take_source),
            # jadi sumber yang gagal tidak dibuka ulang terus-menerus.
            if source is None:
                source = self.shared.take_source()
            if source is None:
                self._stop.wait(SOURCE_POLL_SECONDS)
                continue

            current, source = source, None
            if models is None:                  # model gagal dimuat sebelumnya → coba lagi
                models = self._load_models()
                if models is None:
                    continue
                self.shared.set_proc_state("opening_source")

            try:
                # 3. Proses sumber ini sampai ada sumber baru (dikembalikan) atau stop()
                source = self._run_source(current, *models)
            except Exception as e:
                if not isinstance(e, SourceError):   # sumber gagal = kejadian biasa: cukup satu baris
                    traceback.print_exc()
                self._fail(_short_error(e))
                # .track() pertama gagal sebelum tracker selesai disiapkan: callback
                # tracker sudah terdaftar di objek model ini, dan Ultralytics akan
                # mendaftarkannya SEKALI LAGI pada .track() berikutnya (tracker.update()
                # jalan dua kali per frame). Buang objeknya supaya /configure berikutnya
                # memuat model baru. Sumber yang gagal (SourceError) tidak menyentuh model.
                if not isinstance(e, SourceError) and not self._tracker_ready(models[0]):
                    models = None

    def _open_source(self, source: dict):
        """Buka video file atau kamera berdasarkan config."""
        src_type = source.get("type", "video")
        if src_type == "camera":
            idx = int(source.get("index", 0))
            cap = cv2.VideoCapture(idx)
            print(f"[PROC] Membuka kamera index {idx}...")
        else:
            path = source["path"]
            cap = cv2.VideoCapture(path)
            print(f"[PROC] Membuka video: {path}...")
        return cap

    def _run_source(self, source: dict, vehicle_model, triangle_model) -> Optional[dict]:
        """
        Proses satu sumber. Return sumber baru bila ada /configure baru, None bila
        stop(). Kegagalan dilempar sebagai exception ke loop pengawas; capture
        selalu dilepas.
        """
        self._reset_tracker(vehicle_model)      # ID / track sumber sebelumnya tidak boleh terbawa
        if self._tts is not None:
            self._tts.clear()
        cap = self._open_source(source)
        try:
            return self._run_inner(cap, source, vehicle_model, triangle_model)
        finally:
            cap.release()

    def _retry_camera_open(self, cap, source: dict) -> bool:
        """
        Kamera tidak terbuka. Webcam USB (terutama di Windows) kadang menolak
        dibuka lagi sesaat setelah dilepas, misalnya saat kamera yang sama
        dikonfigurasi ulang. Coba buka lagi beberapa kali dengan jeda pendek
        yang tetap menghormati stop(). Return False bila stop() atau ada sumber
        baru; selain itu True (terbuka atau tidak, diperiksa pemanggil).
        """
        idx = int(source.get("index", 0))
        for attempt in range(1, CAMERA_REOPEN_ATTEMPTS + 1):
            if self._stop.wait(CAMERA_RETRY_WAIT) or self.shared.has_source_pending():
                return False
            print(f"[PROC] Kamera index {idx} belum terbuka, mencoba lagi "
                  f"(percobaan {attempt}/{CAMERA_REOPEN_ATTEMPTS})...")
            cap.open(idx)                       # parameter sama dengan cv2.VideoCapture(idx)
            if cap.isOpened():
                break
        return True

    def _recover_camera(self, cap, source: dict) -> Optional[np.ndarray]:
        """
        cap.read() kamera gagal: baca ulang beberapa kali, lalu buka ulang
        perangkatnya beberapa kali, dengan jeda pendek yang tetap menghormati
        stop(). Return frame bila pulih; None bila stop() atau ada sumber baru;
        SourceError bila tetap gagal.
        """
        idx = int(source.get("index", 0))
        print("[PROC] Kamera gagal baca frame, mencoba ulang...")
        for attempt in range(CAMERA_REOPEN_ATTEMPTS + 1):
            if attempt:
                print(f"[PROC] Membuka ulang kamera index {idx} "
                      f"(percobaan {attempt}/{CAMERA_REOPEN_ATTEMPTS})...")
                cap.release()
                cap.open(idx)                   # parameter sama dengan cv2.VideoCapture(idx)
            for _ in range(CAMERA_READ_RETRIES):
                if self._stop.wait(CAMERA_RETRY_WAIT) or self.shared.has_source_pending():
                    return None
                if cap.isOpened():
                    ret, frame = cap.read()
                    if ret:
                        print("[PROC] Kamera pulih.")
                        return frame
        raise SourceError(f"Kamera index {idx} berhenti mengirim frame "
                          f"(sudah {CAMERA_REOPEN_ATTEMPTS}x dibuka ulang)")

    @staticmethod
    def _grab_base(cap, fps: float) -> Optional[int]:
        """
        Dipanggil tepat setelah frame PERTAMA file video dibaca: nomor frame itu
        menurut stempel waktunya, dibulatkan seperti OpenCV. Hampir selalu 0;
        bisa 1-2 bila video mulai sedikit setelah audionya. Menjadi patokan
        _read_video_frame; None = stempelnya terlalu dekat ke batas pembulatan,
        jadi frame selalu diambil dengan cap.set().
        """
        stamp = cap.get(cv2.CAP_PROP_POS_MSEC) * fps / 1000.0
        base  = int(stamp + 0.5) if math.isfinite(stamp) else 0
        if abs(stamp - base) <= GRAB_TIME_TOLERANCE:
            return base
        print(f"[PROC] Stempel waktu frame pertama video ({stamp:.2f} frame) di batas pembulatan: "
              f"frame diambil dengan seek seperti semula.")
        return None

    @staticmethod
    def _read_video_frame(cap, pos: int, target: int, fps: float, base: Optional[int]):
        """
        Baca frame nomor `target` dari file video; `pos` = nomor frame yang akan
        dikembalikan read() berikutnya, `base` dari _grab_base(). Return
        (ret, frame, base); base None = sumber ini selalu memakai cap.set().

        Cara semula: cap.set() ke frame target, lalu read(). cap.set()
        mengosongkan decoder dan mengulang dari keyframe, jadi lompatan pendek
        ke depan dilewati dengan grab() berurutan (decode saja), yang lebih
        murah.

        Menghitung grab() hanya memilih frame yang sama dengan cap.set() bila
        frame rate file itu konstan, karena cap.set() mencari berdasarkan WAKTU:
        ia mundur ke keyframe, menomori keyframe itu dari stempel waktunya
        (dibulatkan), lalu maju sampai nomor target. Maka stempel waktu SETIAP
        frame yang dilewati dicocokkan dengan nomor hitungannya; selama semuanya
        cocok, kedua cara memilih frame yang sama. Begitu ada yang meleset
        lebih dari GRAB_TIME_TOLERANCE (file VFR), frame target dibaca ulang
        dengan cap.set() dan base menjadi None. Lompatan jauh atau mundur juga
        membuat base None, sebab frame yang terlompati tidak ikut diperiksa.
        """
        if base is not None and 0 <= target - pos <= GRAB_MAX_SKIP:
            for number in range(pos, target + 1):
                if not cap.grab():
                    break       # habis sebelum frame target → dipastikan dengan cap.set() di bawah
                stamp = cap.get(cv2.CAP_PROP_POS_MSEC) * fps / 1000.0 - base
                if not abs(stamp - number) <= GRAB_TIME_TOLERANCE:
                    print(f"[PROC] Stempel waktu frame ke-{number} tidak cocok dengan nomornya "
                          f"({stamp:.2f}; video VFR?): frame diambil dengan seek seperti semula.")
                    base = None
                    break
            else:
                return (*cap.retrieve(), base)      # grab() terakhir + retrieve() = read()
        else:
            base = None

        cap.set(cv2.CAP_PROP_POS_FRAMES, target)
        ret, frame = cap.read()
        # grab() gagal tetapi cap.set() menemukan frame-nya: hitungan dan waktu tidak sejalan
        return ret, frame, None if ret else base

    def _run_inner(self, cap, source: dict, vehicle_model, triangle_model) -> Optional[dict]:
        """Satu sumber: frame pertama → ROI → loop tick. Nilai kembali sama dengan _run_source."""
        is_camera = source.get("type") == "camera"
        if is_camera and not cap.isOpened() and not self._retry_camera_open(cap, source):
            return None             # stop(), atau sumber baru (diambil loop pengawas)
        if not cap.isOpened():
            raise SourceError(f"Sumber tidak bisa dibuka: {self._describe_source(source)}")

        fps          = cap.get(cv2.CAP_PROP_FPS)
        if not (math.isfinite(fps) and fps > 0):
            fps = 25.0
        W            = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        H            = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        print(f"[PROC] Sumber terbuka: {W}×{H} @ {fps:.1f}fps")

        # 4. Baca frame pertama, simpan untuk ROI drawing di frontend
        ret, first_frame = cap.read()
        if not ret and is_camera:
            first_frame = self._recover_camera(cap, source)
            if first_frame is None:
                return None         # stop(), atau sumber baru (diambil loop pengawas)
        elif not ret:
            raise SourceError(f"Frame pertama tidak bisa dibaca: {self._describe_source(source)}")
        if W <= 0 or H <= 0:        # backend tidak melaporkan ukuran → pakai ukuran frame nyata
            H, W = first_frame.shape[:2]

        ok, buf = cv2.imencode('.jpg', first_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok:
            self.shared.set_first_frame(buf.tobytes())
            print("[PROC] Frame pertama tersimpan untuk ROI drawing.")

        # 5. Tentukan ROI berdasarkan mode
        roi_mode     = self.shared.get_roi_mode()
        roi_polygons: List[List[Tuple[int, int]]] = []

        if roi_mode == "auto":
            roi_polygons = self._make_auto_roi(W, H)
            print(f"[PROC] Auto-ROI: seluruh frame ({W}×{H})")
        else:
            # Manual: tunggu ROI dari frontend. Cukup SATU frame diam yang di-push;
            # video tidak di-decode dan di-encode berulang selama menunggu.
            print("[PROC] Menunggu ROI dari frontend (/set_roi)...")
            self.shared.set_proc_state("waiting_roi")
            self._push_hint_frame(first_frame, "Gambar zona larangan parkir di dashboard",
                                  "Klik titik-titik pada frame → Simpan Zona")

            while not self._stop.is_set():
                # Cek apakah ada source baru (user re-configure)
                new_src = self.shared.take_source()
                if new_src:
                    return new_src

                roi_raw = self.shared.take_roi()
                if roi_raw:
                    roi_polygons = self._decode_roi(roi_raw, W, H)
                    n = sum(len(p) for p in roi_polygons)
                    print(f"[PROC] ROI diterima: {len(roi_polygons)} zona, {n} titik total")
                    break

                if is_camera:
                    cap.grab()      # kuras buffer driver supaya frame berikutnya tidak basi
                self._stop.wait(ROI_POLL_SECONDS)

            if self._stop.is_set():
                return None

        # 6. Tick pertama memakai frame pertama yang sudah dibaca (file video:
        #    frame 0, jadi tidak perlu seek + decode ulang ke awal)
        current_frame = first_frame
        frame_pos     = 1       # file video: nomor frame yang dibaca read() berikutnya
        # file video: patokan memilih frame dengan menghitung grab() (lihat _read_video_frame)
        grab_base     = None if is_camera else self._grab_base(cap, fps)
        self._push_hint_frame(first_frame, "Memulai deteksi...")
        self.shared.set_proc_state("running")

        # 5. Inisialisasi state tracking
        parked_records:       Dict[int, ParkedRecord] = {}
        tracker_to_logical:   Dict[int, int]          = {}
        cached_triangle:      Dict                    = {}
        next_logical_id       = 1
        last_logic_second     = -1
        tick_second           = 0
        ticks_done            = 0                       # untuk status "proc"
        tick_started          = time.perf_counter()     # hanya untuk tick_ms, bukan logika

        # 6. Loop utama — sama persis dengan run_video() di demo3_tts.py
        while not self._stop.is_set():

            # Cek apakah ada source baru dari frontend (user re-configure)
            new_src = self.shared.take_source()
            if new_src:
                return new_src

            # Cek apakah ada update ROI dari frontend (mid-run)
            roi_raw = self.shared.take_roi()
            if roi_raw:
                roi_polygons = self._decode_roi(roi_raw, W, H)
                parked_records.clear()
                tracker_to_logical.clear()
                cached_triangle.clear()
                next_logical_id = 1
                if self._tts is not None:
                    self._tts.clear()
                print(f"[PROC] ROI diperbarui: {len(roi_polygons)} zona")

            # Video baru sedang diunggah (PUT /upload/stream): tick FILE VIDEO
            # ditunda supaya CPU dipakai unggahan. Hanya menunda: frame, urutan,
            # dan detik video tiap tick tetap sama, jadi hasil deteksi tidak
            # berubah. Kamera tidak ditunda (cara hitung waktu kamera tetap).
            if not is_camera and self.shared.upload_active():
                self.shared.set_proc_state("paused")
                print("[PROC] Deteksi ditunda selama video baru diunggah...")
                paused_at = time.perf_counter()
                while (self.shared.upload_active() and not self._stop.is_set()
                       and not self.shared.has_source_pending()):
                    self._stop.wait(UPLOAD_POLL_SECONDS)
                self.shared.set_proc_state("running")
                print("[PROC] Unggahan selesai, deteksi dilanjutkan.")
                tick_started += time.perf_counter() - paused_at   # lama jeda tidak masuk tick_ms
                continue                            # cek ulang sumber / ROI baru dulu

            frame        = current_frame    # hanya dibaca; semua gambar ditulis ke vis
            vis          = frame.copy()
            logic_second = tick_second
            video_second = tick_second

            draw_all_rois(vis, roi_polygons)

            # ── YOLO vehicle tracking ──────────────────────────
            results = vehicle_model.track(
                source=frame, imgsz=VEHICLE_IMGSZ, conf=VEHICLE_CONF,
                iou=IOU, persist=True, tracker=TRACKER_CONFIG, verbose=False,
            )
            tracked_now = []
            boxes = results[0].boxes
            names = results[0].names
            if boxes is not None and len(boxes) > 0:
                xyxy_arr = boxes.xyxy.cpu().numpy().astype(int)
                cls_arr  = boxes.cls.cpu().numpy().astype(int)
                id_arr   = boxes.id.cpu().numpy().astype(int) if boxes.id is not None else None
                conf_arr = boxes.conf.cpu().numpy()
                for i in range(len(boxes)):
                    tid = int(id_arr[i]) if id_arr is not None else None
                    if tid is None: continue
                    cls_name = str(names.get(int(cls_arr[i]), int(cls_arr[i]))).lower()
                    if cls_name not in ONLY_VEHICLE_CLASSES: continue
                    xyxy    = tuple(xyxy_arr[i].tolist())
                    cx, cy  = box_center(xyxy)
                    roi_idx = find_roi_index_for_box(xyxy, roi_polygons)
                    if roi_idx is None: continue
                    tracked_now.append({
                        "tracker_id": tid, "bbox": xyxy, "center": (cx, cy),
                        "cls_name": cls_name, "roi_idx": roi_idx, "conf": float(conf_arr[i]),
                    })
            tracked_now = dedupe_tracked_boxes(tracked_now, tracker_to_logical,
                                               parked_records, logic_second)

            # ── Assignment: tracker_id → logical_id ───────────
            visible_logical_ids = set()
            used_hidden_ids     = set()
            color_skip_ids      = set()     # record terlihat yang kotaknya tidak mengikuti deteksi
                                            # tick ini (meluber / bergeser): tanpa suara warna

            # Tahap 1: deteksi yang id tracker-nya sudah terhubung ke record
            # (pemeriksaan sama dengan semula, kelas car/truck/bus boleh tertukar).
            claims: Dict[int, int] = {}     # logical id → indeks deteksi yang memakainya
            held = set()                    # indeks deteksi yang diabaikan pada tick ini
            for i, det in enumerate(tracked_now):
                tid, bbox = det["tracker_id"], det["bbox"]
                cls_name, roi_idx = det["cls_name"], det["roi_idx"]
                cid = tracker_to_logical.get(tid)
                if cid is None or cid not in parked_records:
                    continue
                crec, ok = parked_records[cid], True
                if crec.parked_since is not None and crec.parked_bbox is not None:
                    if bbox_iou(bbox, crec.parked_bbox) < 0.30: ok = False
                if ok:
                    c_dur = get_elapsed_seconds(crec, logic_second)
                    b_lid, b_iou, b_dur = None, 0.0, 0
                    for ol, orec in parked_records.items():
                        if (ol == cid or ol in claims or orec.parked_since is None or
                                orec.parked_bbox is None or orec.hidden_since is None or
                                orec.roi_idx != roi_idx): continue
                        if logic_second - orec.hidden_since > hidden_ttl_seconds(orec): continue
                        oi = bbox_iou(bbox, orec.parked_bbox)
                        if not class_compatible(orec.cls_name, cls_name, oi): continue
                        od = get_elapsed_seconds(orec, logic_second)
                        if oi > b_iou: b_iou, b_lid, b_dur = oi, ol, od
                    if b_lid and b_iou >= 0.20 and b_dur > c_dur: ok = False
                if not ok:
                    continue
                if cid in claims:
                    # Dua id tracker menunjuk record yang sama: id utama record yang
                    # dipakai, yang lain diabaikan tick ini (id-nya tetap terhubung).
                    if tid != crec.tracker_id:
                        held.add(i)
                        continue
                    held.add(claims[cid])
                claims[cid] = i
            pre_assigned = {i: cid for cid, i in claims.items()}
            visible_logical_ids.update(claims)
            used_hidden_ids.update(claims)

            # Record yang terlihat di tick sebelumnya tetapi tidak diklaim di tahap 1
            # ditandai tersembunyi MULAI tick ini, supaya di tahap 2 deteksi dengan id
            # tracker baru (ID switch, kelas berganti) bisa di-relink ke record itu
            # pada tick ini juga. Dulu baru bisa tick berikutnya, dan kotak kedua dari
            # kendaraan parkir hanya dikenali bila id-nya kebetulan diproses lebih dulu
            # (urutan confidence YOLO) → LID ganda (sedan input1, L300 input4).
            for lid, rec in parked_records.items():
                if lid not in visible_logical_ids and rec.hidden_since is None:
                    rec.hidden_since = logic_second

            # Tahap 2: pasang deteksi tahap 1, relink / record baru untuk sisanya.
            for i, det in enumerate(tracked_now):
                if i in held:
                    continue
                tid      = det["tracker_id"]
                bbox     = det["bbox"]
                center   = det["center"]
                cls_name = det["cls_name"]
                roi_idx  = det["roi_idx"]
                logical_id = pre_assigned.get(i)

                if logical_id is None:
                    h = get_best_hidden_match(bbox, center, cls_name, roi_idx,
                                              parked_records, logic_second, used_hidden_ids)
                    if h: logical_id = h; used_hidden_ids.add(h)

                if logical_id is None:
                    lk = get_locked_hidden_parked_record(bbox, center, cls_name, roi_idx,
                                                          parked_records, logic_second, used_hidden_ids)
                    if lk: logical_id = lk; used_hidden_ids.add(lk)

                if logical_id is None:
                    bvl, bvs = None, -1e18
                    for vl in visible_logical_ids:
                        if vl not in parked_records: continue
                        vr = parked_records[vl]
                        if vr.roi_idx != roi_idx or vr.parked_since is None: continue
                        ref  = vr.parked_bbox or vr.bbox
                        iouvv = bbox_iou(bbox, ref)
                        if (iouvv >= 0.30 and class_compatible(vr.cls_name, cls_name, iouvv)
                                and not spills_outside(bbox, ref)):
                            s = iouvv * 500 + get_elapsed_seconds(vr, logic_second) * 8
                            if s > bvs: bvs, bvl = s, vl
                    if bvl:
                        # Kotak kedua dari kendaraan parkir yang sudah terlihat (kotak
                        # sebagian sedan input1, kotak kelas lain L300): diabaikan; kotak
                        # dan id tracker record itu tidak diganti.
                        continue

                if logical_id is None:
                    logical_id = next_logical_id
                    parked_records[logical_id] = ParkedRecord(
                        tracker_id=tid, cls_name=cls_name,
                        bbox=bbox, center=center, roi_idx=roi_idx,
                        cls_votes={cls_name: 1})
                    next_logical_id += 1
                else:
                    rec = parked_records[logical_id]
                    # hidden_since == logic_second: baru ditandai di atas (record terlihat
                    # di tick sebelumnya, hanya id tracker-nya berganti) → bukan "muncul lagi".
                    was_hidden = rec.hidden_since is not None and rec.hidden_since < logic_second
                    if (rec.tracker_id is not None and rec.tracker_id != tid
                            and tracker_to_logical.get(rec.tracker_id) == logical_id):
                        del tracker_to_logical[rec.tracker_id]
                    rec.tracker_id = tid
                    # Warna record TIDAK ditimpa di sini (dulu selalu kembali ke
                    # "unknown" tiap tick, sehingga klasifikasi warna berulang terus).
                    if rec.parked_since is not None and rec.parked_bbox is not None:
                        # Kotak record parkir hanya mengikuti deteksi yang tetap di dalam
                        # kotak parkirnya. Deteksi yang meluber keluar (kendaraan lewat yang
                        # membawa id tracker-nya: Brio input2, MPV/motor input4, Brio merah
                        # input3) tetap dihitung sebagai record ini, tetapi kotak, pusat,
                        # dan kelasnya tidak ikut pindah, dan tick ini tidak memberi suara
                        # warna (kotak lama bisa tertutup kendaraan lewat itu).
                        box_ok = (bbox_iou(bbox, rec.parked_bbox) >= 0.35
                                  and not spills_outside(bbox, rec.parked_bbox))
                        if box_ok:
                            rec.bbox = bbox; rec.center = center
                            rec.roi_idx = roi_idx
                    else:
                        box_ok = True
                        rec.bbox = bbox; rec.center = center
                        rec.roi_idx = roi_idx
                    if box_ok:
                        # Label jenis = kelas yang paling sering terdeteksi (seri → label
                        # lama), supaya tidak berganti car/truck/bus setiap tick.
                        rec.cls_votes[cls_name] = rec.cls_votes.get(cls_name, 0) + 1
                        if rec.cls_votes[cls_name] > rec.cls_votes.get(rec.cls_name, 0):
                            rec.cls_name = cls_name
                    else:
                        color_skip_ids.add(logical_id)
                    if was_hidden:
                        rec.reappeared_at = logic_second
                        rec.prev_logic_center = rec.center
                        rec.moving_since = None
                    rec.hidden_since = None

                tracker_to_logical[tid] = logical_id
                visible_logical_ids.add(logical_id)

            tracker_to_logical = {t: l for t, l in tracker_to_logical.items() if l in parked_records}
            for lid, rec in parked_records.items():
                if lid not in visible_logical_ids and rec.hidden_since is None:
                    rec.hidden_since = logic_second

            # ── Consolidation merge ────────────────────────────
            merge_pairs = []
            for vl in list(visible_logical_ids):
                if vl not in parked_records: continue
                vr = parked_records[vl]
                if vr.parked_since is None: continue
                vd = get_elapsed_seconds(vr, logic_second)
                bhl, bhd = None, vd
                for hl, hr in parked_records.items():
                    if (hl == vl or hr.hidden_since is None or hr.parked_since is None or
                            hr.roi_idx != vr.roi_idx): continue
                    if logic_second - hr.hidden_since > hidden_ttl_seconds(hr): continue
                    hd = get_elapsed_seconds(hr, logic_second)
                    if hd <= bhd: continue
                    href = hr.parked_bbox or hr.bbox
                    vref = vr.parked_bbox or vr.bbox
                    iouvv = bbox_iou(vref, href)
                    if not class_compatible(hr.cls_name, vr.cls_name, iouvv): continue
                    # Kendaraan lain yang parkir di sebelah / di depan record lama (kotak
                    # parkirnya sebagian besar di luar kotak record lama) tidak boleh
                    # mewarisi waktu record itu lewat merge (dulu cukup pusat <= 150 px).
                    if spills_outside(vref, href): continue
                    cd = euclidean(vr.parked_center or vr.center, hr.parked_center or hr.center)
                    if iouvv >= 0.20 or cd <= 150:
                        if hd > bhd: bhd, bhl = hd, hl
                if bhl: merge_pairs.append((vl, bhl))

            for victim, winner in merge_pairs:
                if victim not in parked_records or winner not in parked_records: continue
                vr, wr = parked_records[victim], parked_records[winner]
                if not spills_outside(vr.bbox, wr.parked_bbox or wr.bbox):
                    wr.bbox = vr.bbox; wr.center = vr.center    # kotak tidak loncat lewat merge
                    if victim in color_skip_ids:
                        color_skip_ids.add(winner)      # kotak victim sendiri tidak dari deteksi tick ini
                else:
                    color_skip_ids.add(winner)          # kotak winner tidak diperbarui: tanpa suara warna
                wr.tracker_id = vr.tracker_id
                wr.hidden_since = None
                wr.reappeared_at = logic_second
                wr.prev_logic_center = wr.parked_center or wr.center
                wr.moving_since = None
                if vr.tracker_id: tracker_to_logical[vr.tracker_id] = winner
                visible_logical_ids.discard(victim)
                visible_logical_ids.add(winner)
                cached_triangle.pop(victim, None)
                del parked_records[victim]
                for t in [t for t, l in tracker_to_logical.items() if l == victim]:
                    del tracker_to_logical[t]

            # ── Analisis per detik ─────────────────────────────
            if logic_second != last_logic_second:
                to_delete = []
                violators = []      # (lid, rec) yang sedang melanggar dan terlihat tick ini
                for lid, rec in parked_records.items():
                    if rec.hidden_since is not None:
                        if logic_second - rec.hidden_since > hidden_ttl_seconds(rec):
                            if tracker_to_logical.get(rec.tracker_id) == lid:   # id bisa sudah dipakai record lain
                                del tracker_to_logical[rec.tracker_id]
                            cached_triangle.pop(lid, None)
                            to_delete.append(lid)
                        continue

                    if rec.prev_logic_center is None:
                        rec.prev_logic_center = rec.center

                    skip = (rec.reappeared_at is not None and
                            (logic_second - rec.reappeared_at) <= REAPPEAR_GRACE_SECONDS)
                    move_dist = euclidean(rec.center, rec.prev_logic_center)

                    if skip:
                        rec.prev_logic_center = rec.center
                        rec.moving_since = None
                        if rec.stationary_since is None:
                            rec.stationary_since = logic_second
                    else:
                        if move_dist <= STATIONARY_DISTANCE_THRESHOLD:
                            if rec.stationary_since is None:
                                rec.stationary_since = logic_second
                            rec.moving_since = None
                        else:
                            if rec.moving_since is None:
                                rec.moving_since = logic_second
                            rec.stationary_since = None
                            if rec.parked_since is not None:
                                md = logic_second - rec.moving_since
                                rr = get_required_moving_reset_seconds(rec, logic_second)
                                if md >= rr * 1.5:
                                    rec.parked_since = rec.stationary_since = rec.moving_since = None
                                    rec.triangle_checked = rec.triangle_found = rec.illegal_seen = False
                                    rec.color_name = "unknown"
                                    rec.color_votes.clear()
                                    rec.last_alert_time = -9999
                                    rec.parked_bbox = rec.parked_center = None
                                    cached_triangle.pop(lid, None)
                                    if self._tts is not None:
                                        self._tts.cancel(lid)   # pesan yang masih antre sudah basi
                        rec.prev_logic_center = rec.center

                    if rec.stationary_since is not None and rec.parked_since is None:
                        if (logic_second - rec.stationary_since) >= STATIONARY_MIN_SECONDS:
                            rec.parked_since  = rec.stationary_since
                            rec.parked_bbox   = rec.bbox
                            rec.parked_center = rec.center
                            # Warna diulang dari nol saat kendaraan mulai diam: suara saat masih
                            # bergerak / terpotong tepi frame dibuang, lalu COLOR_VOTE_SAMPLES
                            # tick terlihat pertama sejak parkir menentukan warnanya (suara
                            # pertama diambil loop "Draw: visible" pada tick ini juga).
                            rec.color_name    = "unknown"
                            rec.color_votes.clear()

                    parked_duration = get_elapsed_seconds(rec, logic_second)

                    # Triangle check  (record hidden sudah di-`continue` di awal loop)
                    if (rec.parked_since is not None and
                            parked_duration >= PARKING_CHECK_SECONDS and
                            not rec.triangle_checked):
                        # Potongan diambil dari kotak saat mulai parkir (tetap), bukan kotak deteksi
                        # tick ini: kotak sesaat bisa bergeser beberapa piksel dan model segitiga
                        # (ambang 0,20) bisa salah menembak lampu belakang kendaraan
                        x1, y1, x2, y2 = rec.parked_bbox or rec.bbox
                        ex1, ey1, ex2, ey2 = expand_xyxy((x1, y1, x2, y2), W, H, EXPAND_MARGIN)
                        crop = frame[ey1:ey2, ex1:ex2]
                        tri_data = []
                        if crop.size > 0:
                            tr = triangle_model.predict(source=crop, imgsz=TRIANGLE_IMGSZ,
                                                        conf=TRIANGLE_CONF, iou=IOU, verbose=False)
                            tb = tr[0].boxes; tn = tr[0].names
                            rec.triangle_found = (tb is not None and len(tb) > 0)
                            if tb and len(tb) > 0:
                                for j in range(len(tb)):
                                    tx1, ty1, tx2, ty2 = tb.xyxy[j].cpu().numpy().astype(int).tolist()
                                    tri_data.append((
                                        (ex1+tx1, ey1+ty1, ex1+tx2, ey1+ty2),
                                        str(tn.get(int(tb.cls[j].item()), int(tb.cls[j].item()))),
                                        float(tb.conf[j].item()),
                                    ))
                        cached_triangle[lid] = tri_data
                        rec.triangle_checked = True

                    # TTS alert: semua pelanggar yang terlihat dikumpulkan dulu (record
                    # hidden sudah di-`continue` di awal loop), disuarakan setelah loop ini
                    if (rec.parked_since is not None and
                            parked_duration >= ILLEGAL_PARKING_SECONDS and not rec.triangle_found):
                        rec.illegal_seen = True
                        violators.append((lid, rec))

                # Satu kalimat untuk SEMUA pelanggar yang terlihat, diucapkan bila ada
                # satu saja yang sudah TTS_REPEAT_GAP detik tidak disebut (pelanggar
                # baru = langsung). Urutan: yang paling dulu parkir disebut lebih dulu.
                # last_alert_time semua yang disebut hanya maju (dan baris [ALERT] hanya
                # tercetak) bila pesan benar-benar diterima untuk disuarakan; yang ditolak
                # (masih diputar, TTS sedang gagal) dicoba lagi tick berikutnya.
                # Dengan ENABLE_TTS=false alert hanya dicatat di log, seperti semula.
                if any((logic_second - rec.last_alert_time) >= TTS_REPEAT_GAP for _, rec in violators):
                    violators.sort(key=lambda v: (v[1].parked_since, v[0]))
                    wt = make_warning_text([rec for _, rec in violators])
                    lids = frozenset(lid for lid, _ in violators)
                    if self._tts is None or self._tts.submit(lids, wt):
                        print(f"[ALERT {logic_second:04d}s] {wt}")
                        for _, rec in violators:
                            rec.last_alert_time = logic_second

                for lid in to_delete:
                    del parked_records[lid]
                last_logic_second = logic_second

            # ── Draw: ghost (occluded) ─────────────────────────
            for lid, rec in parked_records.items():
                if rec.hidden_since is None: continue
                pd = get_elapsed_seconds(rec, logic_second)
                _, st = choose_status(rec, logic_second)
                draw_dashed_box(vis, rec.bbox, (120, 120, 120), 2)
                x1, y1, x2, y2 = rec.bbox
                cv2.putText(vis, f"LID{lid}|{rec.cls_name}|{pd}s|{st}|hidden {logic_second-rec.hidden_since}s",
                            (x1, min(H - 10, y2 + 18)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.42, (120, 120, 120), 1, cv2.LINE_AA)

            # ── Draw: visible ──────────────────────────────────
            for lid, rec in parked_records.items():
                if rec.hidden_since is not None: continue
                # Warna: satu suara per tick sampai cukup (lihat vote_vehicle_color);
                # suara pertama langsung mengisi warna, jadi label tampil sejak tick ini.
                # Record yang kotaknya tidak mengikuti deteksi tick ini (color_skip_ids:
                # deteksi meluber keluar / bergeser dari kotak parkir) tidak memberi suara.
                if lid not in color_skip_ids:
                    vote_vehicle_color(rec, frame)
                pd = get_elapsed_seconds(rec, logic_second)
                bc, st = choose_status(rec, logic_second)
                lbl = f"LID{lid}|ROI{rec.roi_idx+1}|{rec.cls_name}|{pd}s|{st}"
                if rec.color_name != "unknown": lbl += f"|{rec.color_name}"
                draw_box(vis, rec.bbox, lbl, bc, 2)

            for lid, tdata in cached_triangle.items():
                for (gx1, gy1, gx2, gy2), tn, tc in tdata:
                    cv2.rectangle(vis, (gx1, gy1), (gx2, gy2), (0, 255, 0), 2)
                    cv2.putText(vis, f"{tn} {tc:.2f}", (gx1, max(20, gy1-8)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 0), 1, cv2.LINE_AA)

            cv2.putText(vis, f"Video: {video_second}s", (20, 35),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)

            # ── Tulis ke SharedState ───────────────────────────
            self._push_frame(vis)
            alerts = self._build_alerts(parked_records, logic_second)
            stats = {
                "total":     len(alerts),
                "warning":   sum(1 for a in alerts if a["status"] == "warning"),
                "violation": sum(1 for a in alerts if a["status"] == "violation"),
                "safe":      sum(1 for a in alerts if a["status"] == "safe"),
            }
            self.shared.set_alerts(alerts, stats)

            # Status "proc": jumlah tick selesai + lama tick ini (jam nyata, antar publikasi)
            ticks_done += 1
            now = time.perf_counter()
            self.shared.set_proc_tick(ticks_done, round((now - tick_started) * 1000.0, 1))
            tick_started = now

            # ── Maju ke detik berikutnya ──────────────────────────
            if is_camera:
                # Kamera: 1 tick = 1 frame yang diproses; baca frame berikutnya langsung
                tick_second += 1
                ret, current_frame = cap.read()
                if not ret:
                    current_frame = self._recover_camera(cap, source)
                    if current_frame is None:
                        return None     # stop(), atau sumber baru (diambil loop pengawas)
            else:
                # Video file: maju TICK_STEP detik video, ambil frame target
                tick_second += TICK_STEP
                target_frame = int(round(tick_second * fps))
                ret = False
                # total_frames <= 0: jumlah frame tidak diketahui → akhir video
                # dikenali dari read() yang gagal
                if total_frames <= 0 or target_frame < total_frames:
                    ret, current_frame, grab_base = self._read_video_frame(
                        cap, frame_pos, target_frame, fps, grab_base)
                    frame_pos = target_frame + 1

                if not ret:
                    # Akhir video, atau frame target tidak terbaca: ulang dari awal.
                    # Satu jalur untuk keduanya, supaya state SELALU ikut dikosongkan
                    # saat tick_second kembali ke 0.
                    print("[PROC] Video selesai — loop dari awal.")
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ret, current_frame = cap.read()
                    if not ret:
                        raise SourceError(
                            f"Video tidak bisa dibaca ulang dari awal: {self._describe_source(source)}")
                    frame_pos         = 1
                    tick_second       = 0
                    last_logic_second = -1
                    parked_records.clear(); tracker_to_logical.clear()
                    cached_triangle.clear(); next_logical_id = 1
                    # State tracker sengaja TIDAK di-reset di sini (sama seperti semula):
                    # pemetaan tracker_to_logical sudah dikosongkan, ID tracker lanjut naik.
                    if self._tts is not None:
                        self._tts.clear()

        return None     # stop()
