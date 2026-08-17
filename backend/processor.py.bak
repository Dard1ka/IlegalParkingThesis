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
"""

from __future__ import annotations
from pathlib import Path
from dataclasses import dataclass
from typing import List, Tuple, Dict, Optional
import math, time, asyncio, threading, uuid, os

import cv2
import numpy as np
from ultralytics import YOLO
import pygame
import edge_tts

from .shared import SharedState


# ══════════════════════════════════════════════════════════════
# CONFIG  (sama persis dengan demo3_tts.py)
# ══════════════════════════════════════════════════════════════
VIDEO_PATH          = "input4.mp4"
VEHICLE_MODEL_PATH  = "best.pt"
TRIANGLE_MODEL_PATH = "triangle.pt"

PARKING_CHECK_SECONDS   = 60
ILLEGAL_PARKING_SECONDS = 300

VEHICLE_IMGSZ        = 960
TRIANGLE_IMGSZ       = 640
VEHICLE_CONF         = 0.25
TRIANGLE_CONF        = 0.20
IOU                  = 0.50
EXPAND_MARGIN        = 0.18
ONLY_VEHICLE_CLASSES = ["car", "bus", "truck", "motorcycle"]
TRACKER_CONFIG       = "botsort.yaml"

OCCLUSION_TTL_SECONDS              = 80
RELINK_MAX_DISTANCE                = 350
RELINK_FOOT_DISTANCE               = 220
RELINK_IOU_THRESHOLD               = 0.01
HIDDEN_PARKED_LOCK_CENTER_DISTANCE = 200
HIDDEN_PARKED_LOCK_FOOT_DISTANCE   = 120

STATIONARY_DISTANCE_THRESHOLD = 22.0
STATIONARY_MIN_SECONDS        = 3
MOVING_RESET_SECONDS          = 4
REAPPEAR_GRACE_SECONDS        = 4

COLOR_CROP_TRIM_BOTTOM = 0.28
COLOR_CROP_TRIM_TOP    = 0.08
COLOR_CROP_TRIM_LEFT   = 0.08
COLOR_CROP_TRIM_RIGHT  = 0.08
HEURISTIC_SAMPLE_SIZE  = 96

ENABLE_TTS      = os.environ.get("ENABLE_TTS", "true").lower() not in ("false", "0", "no")
TTS_REPEAT_GAP  = 20
EDGE_TTS_VOICE  = "id-ID-GadisNeural"
EDGE_TTS_RATE   = "+0%"
EDGE_TTS_VOLUME = "+0%"
EDGE_TTS_PITCH  = "+0Hz"
TTS_TEMP_DIR    = "outputs/tts_temp"


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
# COLOR CLASSIFICATION  (sama persis)
# ══════════════════════════════════════════════════════════════

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
    if bgr_crop is None or bgr_crop.size == 0: return "unknown", 0.0
    h, w = bgr_crop.shape[:2]
    if h < 4 or w < 4: return "unknown", 0.0
    crop = cv2.resize(bgr_crop, (sample_size, sample_size), interpolation=cv2.INTER_AREA)
    hsv  = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    Hf   = hsv[:, :, 0].astype(np.int32).reshape(-1)
    Sf   = hsv[:, :, 1].astype(np.int32).reshape(-1)
    Vf   = hsv[:, :, 2].astype(np.int32).reshape(-1)
    valid = Vf > 25
    Hf, Sf, Vf = Hf[valid], Sf[valid], Vf[valid]
    if Hf.size == 0: return "unknown", 0.0
    counts = {k: 0 for k in
              ["black","white","gray","red","orange","yellow","brown","green","cyan","blue","purple","pink"]}
    black = Vf < 60
    white = (Sf < 35) & (Vf >= 200)
    gray  = (Sf < 35) & (Vf >= 60) & (Vf < 200)
    counts["black"] = int(np.sum(black))
    counts["white"] = int(np.sum(white))
    counts["gray"]  = int(np.sum(gray))
    chroma = ~(black | white | gray)
    Hc, Sc, Vc = Hf[chroma], Sf[chroma], Vf[chroma]
    if Hc.size:
        brown            = (Hc >= 10) & (Hc <= 25) & (Sc > 50) & (Vc < 160)
        counts["brown"]  = int(np.sum(brown))
        counts["red"]    = int(np.sum(((Hc <= 10) | (Hc >= 170)) & ~brown))
        counts["orange"] = int(np.sum((Hc >= 11) & (Hc <= 20) & ~brown))
        counts["yellow"] = int(np.sum((Hc >= 21) & (Hc <= 35) & ~brown))
        counts["green"]  = int(np.sum((Hc >= 36) & (Hc <= 85)))
        counts["cyan"]   = int(np.sum((Hc >= 86) & (Hc <= 100)))
        counts["blue"]   = int(np.sum((Hc >= 101) & (Hc <= 130)))
        counts["purple"] = int(np.sum((Hc >= 131) & (Hc <= 160)))
        counts["pink"]   = int(np.sum((Hc >= 161) & (Hc <= 169)))
    total = sum(counts.values())
    if total <= 0: return "unknown", 0.0
    best, cnt = max(counts.items(), key=lambda kv: kv[1])
    return best, float(cnt / total * 100)


# ══════════════════════════════════════════════════════════════
# TRACK STATE
# ══════════════════════════════════════════════════════════════

@dataclass
class ParkedRecord:
    logical_id:   int
    tracker_id:   Optional[int]
    cls_name:     str
    bbox:         Tuple[int, int, int, int]
    center:       Tuple[float, float]
    roi_idx:      int
    first_seen_time: int
    last_seen_time:  int
    hidden_since:    Optional[int]  = None
    stationary_since: Optional[int] = None
    parked_since:    Optional[int]  = None
    moving_since:    Optional[int]  = None
    reappeared_at:   Optional[int]  = None
    triangle_checked: bool = False
    triangle_found:   bool = False
    illegal_reported: bool = False
    last_alert_time:  int  = -9999
    color_name:       str  = "unknown"
    color_pct:        float = 0.0
    prev_logic_center: Optional[Tuple[float, float]] = None
    parked_bbox:       Optional[Tuple[int, int, int, int]] = None
    parked_center:     Optional[Tuple[float, float]] = None


# ══════════════════════════════════════════════════════════════
# TTS  (sama persis dengan demo3_tts.py)
# ══════════════════════════════════════════════════════════════

tts_busy = False
tts_lock = threading.Lock()

if ENABLE_TTS:
    Path(TTS_TEMP_DIR).mkdir(parents=True, exist_ok=True)
    try:
        pygame.mixer.init()
    except Exception as e:
        print(f"[TTS] pygame init gagal: {e}")

async def _edge_tts_save(text: str, out_mp3: str):
    c = edge_tts.Communicate(text=text, voice=EDGE_TTS_VOICE,
                              rate=EDGE_TTS_RATE, volume=EDGE_TTS_VOLUME, pitch=EDGE_TTS_PITCH)
    await c.save(out_mp3)

def _speak_worker(message: str):
    global tts_busy
    tmp = os.path.join(TTS_TEMP_DIR, f"tts_{uuid.uuid4().hex}.mp3")
    try:
        print(f"[TTS] Generating audio → {tmp}")

        # FIX: asyncio.run() di daemon thread saat FastAPI event loop running
        # bisa konflik. Gunakan new event loop eksplisit per-thread.
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_edge_tts_save(message, tmp))
        finally:
            loop.close()

        if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
            print(f"[TTS ERROR] File kosong/tidak terbuat: {tmp}")
            return

        # Pastikan pygame mixer init — retry kalau gagal
        if not pygame.mixer.get_init():
            try:
                pygame.mixer.init()
            except Exception as e:
                print(f"[TTS ERROR] pygame.mixer.init() gagal: {e}")
                return

        pygame.mixer.music.load(tmp)
        pygame.mixer.music.play()
        print(f"[TTS] ▶ Playing: {message[:60]}...")

        while pygame.mixer.music.get_busy():
            time.sleep(0.1)

        print(f"[TTS] ✓ Selesai.")

    except Exception as e:
        import traceback
        print(f"[TTS ERROR] {type(e).__name__}: {e}")
        traceback.print_exc()
    finally:
        try: pygame.mixer.music.unload()
        except: pass
        try:
            if os.path.exists(tmp): os.remove(tmp)
        except: pass
        with tts_lock:
            tts_busy = False

def speak_once(message: str):
    global tts_busy
    if not ENABLE_TTS: return
    with tts_lock:
        if tts_busy: return
        tts_busy = True
    threading.Thread(target=_speak_worker, args=(message,), daemon=True).start()


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

def make_warning_text(rec: ParkedRecord, frame_w: int) -> str:
    return (
        f"Mohon untuk {bahasa_label(rec.cls_name)} dengan warna {warna_label(rec.color_name)} "
        f"untuk tidak parkir di situ atau akan terkena denda karena bukan tempat parkir."
    )


# ══════════════════════════════════════════════════════════════
# RELINKING FUNCTIONS  (sama persis dengan demo3_tts.py)
# ══════════════════════════════════════════════════════════════

def recover_roi_from_nearby_hidden_record(center, cls_name, parked_records, logic_second):
    best_roi, best_dist = None, 1e9
    for _, rec in parked_records.items():
        if rec.cls_name != cls_name or rec.hidden_since is None: continue
        if logic_second - rec.hidden_since > OCCLUSION_TTL_SECONDS: continue
        d = euclidean(center, rec.center)
        if d < RELINK_MAX_DISTANCE and d < best_dist:
            best_dist, best_roi = d, rec.roi_idx
    return best_roi

def get_best_hidden_match(det_bbox, det_center, det_cls_name, det_roi_idx,
                          det_color, parked_records, logic_second, used_hidden_ids):
    det_foot = foot_point(det_bbox)

    def _eval(rec):
        if rec.parked_since is not None and rec.parked_bbox is not None:
            ref_bbox, ref_center = rec.parked_bbox, rec.parked_center or rec.center
        else:
            ref_bbox, ref_center = rec.bbox, rec.center
        return (ref_bbox, ref_center,
                euclidean(det_center, ref_center),
                euclidean(det_foot, foot_point(ref_bbox)),
                bbox_iou(det_bbox, ref_bbox))

    def _ok(rec, cd, fd, iou):
        if cd > RELINK_MAX_DISTANCE: return False
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
        if rec.color_name != "unknown":
            s += 200 if rec.color_name == det_color else -100
        return s

    # Pass 1: hanya record yang sudah parked
    best_id, best_s = None, -1e18
    for lid, rec in parked_records.items():
        if lid in used_hidden_ids or rec.hidden_since is None: continue
        if logic_second - rec.hidden_since > OCCLUSION_TTL_SECONDS: continue
        if rec.cls_name != det_cls_name: continue
        if det_roi_idx is not None and rec.roi_idx != det_roi_idx: continue
        if rec.parked_since is None: continue
        _, _, cd, fd, iou = _eval(rec)
        if not _ok(rec, cd, fd, iou): continue
        s = _score(rec, cd, fd, iou)
        if s > best_s: best_s, best_id = s, lid
    if best_id is not None: return best_id

    # Pass 2: record yang belum parked
    for lid, rec in parked_records.items():
        if lid in used_hidden_ids or rec.hidden_since is None: continue
        if logic_second - rec.hidden_since > OCCLUSION_TTL_SECONDS: continue
        if rec.cls_name != det_cls_name: continue
        if det_roi_idx is not None and rec.roi_idx != det_roi_idx: continue
        if rec.parked_since is not None: continue
        _, _, cd, fd, iou = _eval(rec)
        if not _ok(rec, cd, fd, iou): continue
        s = _score(rec, cd, fd, iou)
        if s > best_s: best_s, best_id = s, lid
    return best_id

def get_locked_hidden_parked_record(det_bbox, det_center, det_cls_name, det_roi_idx,
                                    det_color, parked_records, logic_second):
    det_foot = foot_point(det_bbox)
    best_id, best_s = None, 1e18
    for lid, rec in parked_records.items():
        if rec.hidden_since is None or rec.parked_since is None: continue
        if logic_second - rec.hidden_since > OCCLUSION_TTL_SECONDS: continue
        if rec.cls_name != det_cls_name or rec.roi_idx != det_roi_idx: continue
        ref_bbox   = rec.parked_bbox or rec.bbox
        ref_center = rec.parked_center or rec.center
        cd  = euclidean(det_center, ref_center)
        fd  = euclidean(det_foot, foot_point(ref_bbox))
        iou = bbox_iou(det_bbox, ref_bbox)
        if iou < 0.30: continue
        if cd <= HIDDEN_PARKED_LOCK_CENTER_DISTANCE or fd <= HIDDEN_PARKED_LOCK_FOOT_DISTANCE:
            s = cd + fd * 2 - iou * 500
            if s < best_s: best_s, best_id = s, lid
    return best_id


# ══════════════════════════════════════════════════════════════
# VIDEO PROCESSOR  (class utama)
# ══════════════════════════════════════════════════════════════

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

    # ── Entry point ────────────────────────────────────────────
    def run(self):
        self.shared.set_running(True)
        try:
            self._run_inner()
        except Exception as e:
            print(f"[PROC] Error fatal: {e}")
        finally:
            self.shared.set_running(False)
            print("[PROC] Processor berhenti.")

    def _open_source(self, source: dict):
        """Buka video file atau kamera berdasarkan config."""
        src_type = source.get("type", "video")
        if src_type == "camera":
            idx = int(source.get("index", 0))
            cap = cv2.VideoCapture(idx)
            print(f"[PROC] Membuka kamera index {idx}...")
        else:
            path = source.get("path", VIDEO_PATH)
            cap = cv2.VideoCapture(path)
            print(f"[PROC] Membuka video: {path}...")
        return cap

    def _run_inner(self):
        # 1. Load YOLO models
        print("[PROC] Memuat model YOLO...")
        vehicle_model  = YOLO(VEHICLE_MODEL_PATH)
        triangle_model = YOLO(TRIANGLE_MODEL_PATH)
        print("[PROC] Model dimuat.")

        # 2. Tampilkan layar tunggu sampai user konfigurasi sumber
        print("[PROC] Menunggu konfigurasi sumber dari frontend...")
        while not self._stop.is_set():
            if self.shared.has_source():
                break

            blank = np.zeros((480, 854, 3), dtype=np.uint8)
            cv2.putText(blank, "Menunggu konfigurasi sumber...",
                        (60, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (60, 60, 80), 2)
            cv2.putText(blank, "Buka dashboard → pilih Video atau Kamera",
                        (60, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (50, 50, 70), 2)
            self._push_frame(blank)
            time.sleep(0.5)

        if self._stop.is_set():
            return

        # 3. Buka sumber berdasarkan config
        source = self.shared.get_source()
        cap = self._open_source(source)
        if not cap.isOpened():
            print(f"[PROC] GAGAL membuka sumber: {source}")
            return

        fps          = cap.get(cv2.CAP_PROP_FPS) or 25.0
        W            = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        H            = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        is_camera    = source.get("type") == "camera"
        print(f"[PROC] Sumber terbuka: {W}×{H} @ {fps:.1f}fps")

        # 4. Baca frame pertama, simpan untuk ROI drawing di frontend
        ret, first_frame = cap.read()
        if not ret:
            cap.release()
            return

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
            # Manual: tunggu ROI dari frontend
            print("[PROC] Menunggu ROI dari frontend (/set_roi)...")
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

            while not self._stop.is_set():
                # Cek apakah ada source baru (user re-configure)
                new_src = self.shared.take_source()
                if new_src:
                    cap.release()
                    self._run_inner()
                    return

                roi_raw = self.shared.take_roi()
                if roi_raw:
                    roi_polygons = self._decode_roi(roi_raw, W, H)
                    n = sum(len(p) for p in roi_polygons)
                    print(f"[PROC] ROI diterima: {len(roi_polygons)} zona, {n} titik total")
                    break

                ret, placeholder = cap.read()
                if ret:
                    overlay = placeholder.copy()
                    cv2.putText(overlay, "Gambar zona larangan parkir di dashboard",
                                (30, H // 2 - 20), cv2.FONT_HERSHEY_SIMPLEX,
                                0.85, (0, 210, 230), 2, cv2.LINE_AA)
                    cv2.putText(overlay, "Klik titik-titik pada frame → Simpan Zona",
                                (30, H // 2 + 20), cv2.FONT_HERSHEY_SIMPLEX,
                                0.65, (150, 150, 150), 2, cv2.LINE_AA)
                    self._push_frame(overlay)
                else:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                time.sleep(0.12)

            if self._stop.is_set():
                cap.release()
                return

        # 6. Reset ke frame awal, baca frame pertama untuk loop
        if not is_camera:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, current_frame = cap.read()
        else:
            current_frame = first_frame
        if not ret:
            cap.release()
            return

        # 5. Inisialisasi state tracking
        parked_records:       Dict[int, ParkedRecord] = {}
        tracker_to_logical:   Dict[int, int]          = {}
        cached_triangle:      Dict                    = {}
        next_logical_id       = 1
        last_logic_second     = -1
        tick_second           = 0

        # 6. Loop utama — sama persis dengan run_video() di demo3_tts.py
        while not self._stop.is_set():

            # Cek apakah ada source baru dari frontend (user re-configure)
            new_src = self.shared.take_source()
            if new_src:
                cap.release()
                self._run_inner()
                return

            # Cek apakah ada update ROI dari frontend (mid-run)
            roi_raw = self.shared.take_roi()
            if roi_raw:
                roi_polygons = self._decode_roi(roi_raw, W, H)
                parked_records.clear()
                tracker_to_logical.clear()
                cached_triangle.clear()
                next_logical_id = 1
                print(f"[PROC] ROI diperbarui: {len(roi_polygons)} zona")

            frame        = current_frame.copy()
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
                        "cls_name": cls_name, "roi_idx": roi_idx, "color": "unknown",
                    })

            # ── Assignment: tracker_id → logical_id ───────────
            visible_logical_ids = set()
            used_hidden_ids     = set()

            for det in tracked_now:
                tid      = det["tracker_id"]
                bbox     = det["bbox"]
                center   = det["center"]
                cls_name = det["cls_name"]
                roi_idx  = det["roi_idx"]
                cur_col  = det["color"]
                logical_id = None

                if tid in tracker_to_logical:
                    cid = tracker_to_logical[tid]
                    if cid in parked_records:
                        crec, ok = parked_records[cid], True
                        if crec.parked_since is not None and crec.parked_bbox is not None:
                            if bbox_iou(bbox, crec.parked_bbox) < 0.30: ok = False
                        if ok:
                            c_dur = get_elapsed_seconds(crec, logic_second)
                            b_lid, b_iou, b_dur = None, 0.0, 0
                            for ol, orec in parked_records.items():
                                if (ol == cid or orec.parked_since is None or
                                        orec.parked_bbox is None or orec.hidden_since is None or
                                        orec.cls_name != cls_name or orec.roi_idx != roi_idx): continue
                                if logic_second - orec.hidden_since > OCCLUSION_TTL_SECONDS: continue
                                oi = bbox_iou(bbox, orec.parked_bbox)
                                od = get_elapsed_seconds(orec, logic_second)
                                if oi > b_iou: b_iou, b_lid, b_dur = oi, ol, od
                            if b_lid and b_iou >= 0.20 and b_dur > c_dur: ok = False
                        if ok: logical_id = cid

                if logical_id is None:
                    h = get_best_hidden_match(bbox, center, cls_name, roi_idx, cur_col,
                                              parked_records, logic_second, used_hidden_ids)
                    if h: logical_id = h; used_hidden_ids.add(h)

                if logical_id is None:
                    lk = get_locked_hidden_parked_record(bbox, center, cls_name, roi_idx, cur_col,
                                                          parked_records, logic_second)
                    if lk: logical_id = lk; used_hidden_ids.add(lk)

                if logical_id is None:
                    bvl, bvs = None, -1e18
                    for vl in visible_logical_ids:
                        if vl not in parked_records: continue
                        vr = parked_records[vl]
                        if vr.cls_name != cls_name or vr.roi_idx != roi_idx or vr.parked_since is None: continue
                        ref  = vr.parked_bbox or vr.bbox
                        iouvv = bbox_iou(bbox, ref)
                        if iouvv >= 0.30:
                            s = iouvv * 500 + get_elapsed_seconds(vr, logic_second) * 8
                            if s > bvs: bvs, bvl = s, vl
                    if bvl: logical_id = bvl

                if logical_id is None:
                    logical_id = next_logical_id
                    parked_records[logical_id] = ParkedRecord(
                        logical_id=logical_id, tracker_id=tid, cls_name=cls_name,
                        bbox=bbox, center=center, roi_idx=roi_idx, color_name=cur_col,
                        first_seen_time=logic_second, last_seen_time=logic_second)
                    next_logical_id += 1
                else:
                    rec = parked_records[logical_id]
                    was_hidden = rec.hidden_since is not None
                    if rec.tracker_id and rec.tracker_id in tracker_to_logical and rec.tracker_id != tid:
                        del tracker_to_logical[rec.tracker_id]
                    rec.tracker_id = tid; rec.cls_name = cls_name; rec.last_seen_time = logic_second
                    if rec.parked_since is not None and rec.parked_bbox is not None:
                        if bbox_iou(bbox, rec.parked_bbox) >= 0.35:
                            rec.bbox = bbox; rec.center = center
                            rec.roi_idx = roi_idx; rec.color_name = cur_col
                    else:
                        rec.bbox = bbox; rec.center = center
                        rec.roi_idx = roi_idx; rec.color_name = cur_col
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
                            hr.cls_name != vr.cls_name or hr.roi_idx != vr.roi_idx): continue
                    if logic_second - hr.hidden_since > OCCLUSION_TTL_SECONDS: continue
                    hd = get_elapsed_seconds(hr, logic_second)
                    if hd <= bhd: continue
                    href = hr.parked_bbox or hr.bbox
                    vref = vr.parked_bbox or vr.bbox
                    iouvv = bbox_iou(vref, href)
                    cd = euclidean(vr.parked_center or vr.center, hr.parked_center or hr.center)
                    if iouvv >= 0.20 or cd <= 150:
                        if hd > bhd: bhd, bhl = hd, hl
                if bhl: merge_pairs.append((vl, bhl))

            for victim, winner in merge_pairs:
                if victim not in parked_records or winner not in parked_records: continue
                vr, wr = parked_records[victim], parked_records[winner]
                wr.bbox = vr.bbox; wr.center = vr.center; wr.tracker_id = vr.tracker_id
                wr.last_seen_time = logic_second; wr.hidden_since = None
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
                for lid, rec in parked_records.items():
                    if rec.hidden_since is not None:
                        if logic_second - rec.hidden_since > OCCLUSION_TTL_SECONDS:
                            if rec.tracker_id and rec.tracker_id in tracker_to_logical:
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
                                    rec.triangle_checked = rec.triangle_found = rec.illegal_reported = False
                                    rec.color_name = "unknown"; rec.color_pct = 0.0
                                    rec.last_alert_time = -9999
                                    rec.parked_bbox = rec.parked_center = None
                                    cached_triangle.pop(lid, None)
                        rec.prev_logic_center = rec.center

                    if rec.stationary_since is not None and rec.parked_since is None:
                        if (logic_second - rec.stationary_since) >= STATIONARY_MIN_SECONDS:
                            rec.parked_since  = rec.stationary_since
                            rec.parked_bbox   = rec.bbox
                            rec.parked_center = rec.center

                    parked_duration = get_elapsed_seconds(rec, logic_second)

                    # Triangle check
                    if (rec.parked_since is not None and
                            parked_duration >= PARKING_CHECK_SECONDS and
                            not rec.triangle_checked and rec.hidden_since is None):
                        x1, y1, x2, y2 = rec.bbox
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

                    # TTS alert
                    if (rec.parked_since is not None and
                            parked_duration >= ILLEGAL_PARKING_SECONDS and not rec.triangle_found):
                        if rec.color_name == "unknown" and rec.hidden_since is None:
                            x1, y1, x2, y2 = rec.bbox
                            vc = crop_vehicle_body_for_color(frame[y1:y2, x1:x2])
                            rec.color_name, rec.color_pct = classify_vehicle_color_hsv(vc, HEURISTIC_SAMPLE_SIZE)
                        if (logic_second - rec.last_alert_time) >= TTS_REPEAT_GAP:
                            wt = make_warning_text(rec, W)
                            print(f"[ALERT {logic_second:04d}s] {wt}")
                            if ENABLE_TTS: speak_once(wt)
                            rec.last_alert_time = logic_second
                            rec.illegal_reported = True

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

            # DEBUG: log per tick supaya ketahuan apakah alerts ter-build
            n_records = len(parked_records)
            n_visible = sum(1 for r in parked_records.values() if r.hidden_since is None)
            if tick_second % 5 == 0 or n_visible > 0:
                print(f"[PROC t={tick_second:04d}] records={n_records} visible={n_visible} "
                      f"alerts_out={len(alerts)} stats={stats}")

            # ── Maju ke detik berikutnya ──────────────────────────
            tick_second += 1
            if is_camera:
                # Kamera: baca frame berikutnya langsung
                ret, current_frame = cap.read()
                if not ret:
                    print("[PROC] Kamera gagal baca frame.")
                    break
            else:
                # Video file: lompat ke frame target
                target_frame = int(round(tick_second * fps))
                if target_frame >= total_frames:
                    print("[PROC] Video selesai — loop dari awal.")
                    tick_second = 0
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    parked_records.clear(); tracker_to_logical.clear()
                    cached_triangle.clear(); next_logical_id = 1
                else:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)

                ret, current_frame = cap.read()
                if not ret:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    tick_second = 0
                    ret, current_frame = cap.read()
                    if not ret: break

        cap.release()
