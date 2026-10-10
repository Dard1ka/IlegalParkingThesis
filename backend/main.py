"""
backend/main.py
─────────────────────────────────────────────────────────────────
FastAPI application.

Endpoints:
  POST /upload        → Upload file video, simpan ke disk
  POST /configure     → Set sumber (video/camera) + mode ROI
  GET  /first_frame   → Ambil frame pertama sebagai JPEG (untuk drawing ROI)
  POST /set_roi       → Terima koordinat multi-polygon ROI dari frontend
  GET  /video_feed    → MJPEG stream (satu part tiap ada frame baru)
  WS   /ws/alerts     → WebSocket: push JSON {alerts, stats, proc} setiap 1 detik
  GET  /status        → Info status processor (termasuk "proc")
  GET  /debug         → Snapshot state untuk troubleshooting
"""

import asyncio
import json
import os
import threading
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import Optional, List

from .shared import SharedState
from .processor import VideoProcessor, print_effective_config


# ══════════════════════════════════════════════════════════════
# Setup upload directory
# ══════════════════════════════════════════════════════════════
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


# ══════════════════════════════════════════════════════════════
# CORS origins  (env PARKING_CORS_ORIGINS, dipisah koma)
# ══════════════════════════════════════════════════════════════
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",   # vite dev / container frontend
    "http://localhost:4173", "http://127.0.0.1:4173",   # vite preview
]


def _cors_origins() -> List[str]:
    """Dibaca sekali saat import; nilai tidak valid → default + satu baris peringatan."""
    raw = os.environ.get("PARKING_CORS_ORIGINS", "").strip()
    if not raw:
        return list(DEFAULT_CORS_ORIGINS)
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    if not origins or any(o != "*" and not o.startswith(("http://", "https://")) for o in origins):
        print(f"[CONFIG] PARKING_CORS_ORIGINS={raw!r} tidak valid "
              f"(contoh: http://192.168.1.10:5173), pakai default.")
        return list(DEFAULT_CORS_ORIGINS)
    return origins


CORS_ORIGINS = _cors_origins()


# ══════════════════════════════════════════════════════════════
# Singleton state & processor
# ══════════════════════════════════════════════════════════════
shared    = SharedState()
processor = VideoProcessor(shared)

_ws_clients: set[WebSocket] = set()


# ══════════════════════════════════════════════════════════════
# Background: kirim alert ke semua WebSocket clients setiap 1 detik
# ══════════════════════════════════════════════════════════════
def _json_safe(obj):
    """Konversi numpy scalar → Python scalar supaya json.dumps tidak crash."""
    if isinstance(obj, (np.integer,)):      return int(obj)
    if isinstance(obj, (np.floating,)):     return float(obj)
    if isinstance(obj, (np.bool_,)):        return bool(obj)
    if isinstance(obj, np.ndarray):         return obj.tolist()
    raise TypeError(f"Not JSON serializable: {type(obj)}")


def _ws_payload() -> str:
    """Isi SETIAP pesan WebSocket: alert + statistik + status processor."""
    return json.dumps(
        {"alerts": shared.get_alerts(), "stats": shared.get_stats(), "proc": shared.get_proc()},
        default=_json_safe,
    )


async def _ws_broadcaster():
    print("[WS] Broadcaster loop aktif (interval 1s).")
    while True:
        try:
            await asyncio.sleep(1)

            if not _ws_clients:
                continue

            try:
                payload = _ws_payload()
            except Exception as e:
                print(f"[WS ERROR] json.dumps gagal: {e}")
                continue

            dead = set()
            for ws in list(_ws_clients):
                try:
                    await ws.send_text(payload)
                except Exception as e:
                    print(f"[WS] Client mati saat send: {e}")
                    dead.add(ws)
            _ws_clients.difference_update(dead)

        except asyncio.CancelledError:
            print("[WS] Broadcaster di-cancel.")
            raise
        except Exception as e:
            import traceback
            print(f"[WS ERROR] Broadcaster exception: {type(e).__name__}: {e}")
            traceback.print_exc()
            # Lanjut loop, jangan sampai thread mati


# ══════════════════════════════════════════════════════════════
# Lifespan
# ══════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Konfigurasi efektif dicetak sekali, SEBELUM thread processor mulai menulis log
    print_effective_config()
    print(f"[CONFIG] CORS origins    : {', '.join(CORS_ORIGINS)}")
    broadcaster_task = asyncio.create_task(_ws_broadcaster())
    print("[API] WebSocket broadcaster dimulai.")
    await asyncio.sleep(0)      # beri giliran: broadcaster mencetak baris awalnya lebih dulu

    # Thread dimulai paling akhir: log startup di atas tidak tercampur dengan log processor
    proc_thread = threading.Thread(target=processor.run, daemon=True, name="VideoProcessor")
    print("[API] VideoProcessor thread dimulai.")
    proc_thread.start()

    yield

    processor.stop()
    broadcaster_task.cancel()
    print("[API] Shutdown selesai.")


# ══════════════════════════════════════════════════════════════
# FastAPI app
# ══════════════════════════════════════════════════════════════
app = FastAPI(title="Smart Parking API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Upload video file
# ══════════════════════════════════════════════════════════════
@app.post("/upload")
def upload_video(file: UploadFile = File(...)):
    """
    Upload file video dari frontend.
    Simpan ke folder uploads/ dan kembalikan path-nya.

    Sengaja `def` biasa (bukan async): FastAPI menjalankannya di threadpool,
    jadi penyalinan file besar tidak menahan event loop (stream + WebSocket).
    """
    allowed_exts = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_exts:
        return {"status": "error", "message": f"Format tidak didukung: {ext}"}

    dest = UPLOAD_DIR / file.filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    print(f"[API] Video diupload: {dest} ({dest.stat().st_size // 1024} KB)")
    return {"status": "ok", "path": str(dest), "filename": file.filename}


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Configure sumber + mode ROI
# ══════════════════════════════════════════════════════════════
class ConfigurePayload(BaseModel):
    source_type: str          # "video" | "camera"
    path: Optional[str] = None
    camera_index: Optional[int] = 0
    roi_mode: str = "manual"  # "manual" | "auto"


@app.post("/configure")
async def configure(payload: ConfigurePayload):
    """
    Set sumber video dan mode ROI.
    Harus dipanggil sebelum processor mulai deteksi.
    """
    if payload.source_type == "video":
        if not payload.path:
            return {"status": "error", "message": "path diperlukan untuk mode video."}
        p = Path(payload.path)
        if not p.exists():
            return {"status": "error", "message": f"File tidak ditemukan: {payload.path}"}
        source = {"type": "video", "path": str(p)}
    elif payload.source_type == "camera":
        source = {"type": "camera", "index": payload.camera_index or 0}
    else:
        return {"status": "error", "message": f"source_type tidak valid: {payload.source_type}"}

    # Sumber + mode ROI disimpan sekaligus; data sumber lama ikut dikosongkan
    shared.set_source(source, payload.roi_mode)

    print(f"[API] Konfigurasi: source={source}, roi_mode={payload.roi_mode}")
    return {"status": "ok", "source": source, "roi_mode": payload.roi_mode}


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Ambil frame pertama (untuk drawing ROI di frontend)
# ══════════════════════════════════════════════════════════════
@app.get("/first_frame")
async def get_first_frame():
    """
    Kembalikan frame pertama sebagai JPEG.
    Hanya tersedia setelah /configure dipanggil dan processor membuka video.
    Setelah /configure baru, jawabannya 204 sampai frame pertama sumber BARU
    tersimpan (tidak pernah frame milik sumber sebelumnya).
    """
    frame = shared.get_first_frame()
    if frame is None:
        return Response(status_code=204)   # No Content — belum siap

    return Response(content=frame, media_type="image/jpeg")


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Set ROI (multi-polygon)
# ══════════════════════════════════════════════════════════════
class ROIPayload(BaseModel):
    rois: List[List[List[float]]]  # [[[x,y],...], [[x,y],...]]


@app.post("/set_roi")
async def set_roi(payload: ROIPayload):
    """
    Terima daftar polygon ROI dari frontend.
    Tiap polygon = list of [x_norm, y_norm] (0..1).
    """
    if not payload.rois or all(len(p) < 3 for p in payload.rois):
        return {"status": "error", "message": "Minimal 1 polygon dengan 3 titik."}

    valid_rois = [p for p in payload.rois if len(p) >= 3]
    shared.set_roi(valid_rois)

    total_pts = sum(len(p) for p in valid_rois)
    print(f"[API] ROI diterima: {len(valid_rois)} zona, {total_pts} titik total")
    return {"status": "ok", "zones": len(valid_rois), "points": total_pts}


# ══════════════════════════════════════════════════════════════
# ENDPOINT: MJPEG stream
# ══════════════════════════════════════════════════════════════
STREAM_POLL_SECONDS = 0.05   # jeda cek frame baru saat tidak ada yang berubah


def _make_placeholder_jpeg() -> bytes:
    blank = np.zeros((480, 854, 3), dtype=np.uint8)
    cv2.putText(blank, "Menghubungkan ke processor...",
                (60, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (60, 60, 80), 2)
    _, buf = cv2.imencode('.jpg', blank)
    return buf.tobytes()


# Dibuat sekali (bukan per koneksi); objeknya selalu sama, jadi hanya terkirim sekali
PLACEHOLDER_JPEG = _make_placeholder_jpeg()


# Boundary + header sebuah part. Dikirim LEBIH DULU daripada JPEG-nya, yaitu
# langsung di belakang frame sebelumnya (lihat _mjpeg_generator).
MJPEG_PART_HEADER = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"


async def _mjpeg_generator(request: Request):
    """
    Satu part dikirim HANYA saat frame berganti. set_frame() selalu menyimpan
    objek bytes baru, jadi cukup membandingkan identitas objeknya.

    Susunan stream: diawali boundary + header part pertama, lalu tiap frame
    baru dikirim sebagai JPEG + CRLF + boundary + header part BERIKUTNYA.
    Chrome / Edge baru menggambar sebuah part setelah HEADER part berikutnya
    selesai dibaca (boundary penutup saja belum cukup, dan Content-Length per
    part tidak dipakainya). Kalau header itu baru dikirim bersama frame
    berikutnya, gambar selalu tertinggal satu tick dan frame yang hanya dikirim
    sekali (mis. "Processor berhenti") tidak pernah tampil.

    Karena header dikirim sebelum ukuran frame berikutnya diketahui, part tidak
    memakai Content-Length; browser memisahkan part dari boundary-nya.
    """
    yield MJPEG_PART_HEADER
    last_sent = None       # lokal per koneksi: klien baru langsung menerima frame terakhir
    idle_polls = 0
    while True:
        frame = shared.get_frame() or PLACEHOLDER_JPEG
        if frame is last_sent:
            # Tidak ada frame baru. Kira-kira sedetik sekali pastikan klien masih
            # tersambung, supaya generator berhenti walau tidak ada yang dikirim.
            idle_polls += 1
            if idle_polls % 20 == 0 and await request.is_disconnected():
                break
            await asyncio.sleep(STREAM_POLL_SECONDS)
            continue
        last_sent = frame
        yield frame + b"\r\n" + MJPEG_PART_HEADER


@app.get("/video_feed")
async def video_feed(request: Request):
    return StreamingResponse(
        _mjpeg_generator(request),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ══════════════════════════════════════════════════════════════
# ENDPOINT: WebSocket alerts
# ══════════════════════════════════════════════════════════════
@app.websocket("/ws/alerts")
async def ws_alerts(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.add(websocket)
    print(f"[API] WebSocket klien tersambung. Total: {len(_ws_clients)}")

    await websocket.send_text(_ws_payload())

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(websocket)
        print(f"[API] WebSocket klien disconnect. Sisa: {len(_ws_clients)}")


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Status
# ══════════════════════════════════════════════════════════════
@app.get("/status")
async def get_status():
    source = shared.get_source()
    return {
        "running":        shared.is_running(),
        "source":         source,
        "roi_mode":       shared.get_roi_mode(),
        "has_first_frame": shared.get_first_frame() is not None,
        "stats":          shared.get_stats(),
        "alerts":         shared.get_alerts(),
        "proc":           shared.get_proc(),
    }


@app.get("/debug")
async def debug_state():
    """Snapshot state untuk troubleshooting event log kosong."""
    return {
        "running":          shared.is_running(),
        "source":           shared.get_source(),
        "roi_mode":         shared.get_roi_mode(),
        "has_first_frame":  shared.get_first_frame() is not None,
        "roi_pending":      shared.has_roi_pending(),
        "ws_clients":       len(_ws_clients),
        "alerts_count":     len(shared.get_alerts()),
        "alerts":           shared.get_alerts(),
        "stats":            shared.get_stats(),
        "proc":             shared.get_proc(),
    }


@app.get("/")
async def root():
    return {"message": "Smart Parking API v2 aktif", "docs": "/docs"}
