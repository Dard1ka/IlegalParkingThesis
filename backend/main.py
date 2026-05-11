"""
backend/main.py
─────────────────────────────────────────────────────────────────
FastAPI application.

Endpoints:
  POST /upload        → Upload file video, simpan ke disk
  POST /configure     → Set sumber (video/camera) + mode ROI
  GET  /first_frame   → Ambil frame pertama sebagai JPEG (untuk drawing ROI)
  POST /set_roi       → Terima koordinat multi-polygon ROI dari frontend
  GET  /video_feed    → MJPEG stream
  WS   /ws/alerts     → WebSocket: push JSON alert setiap 1 detik
  GET  /status        → Info status processor
"""

import asyncio
import json
import threading
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import Optional, List

from .shared import SharedState
from .processor import VideoProcessor


# ══════════════════════════════════════════════════════════════
# Setup upload directory
# ══════════════════════════════════════════════════════════════
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


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
    import numpy as np
    if isinstance(obj, (np.integer,)):      return int(obj)
    if isinstance(obj, (np.floating,)):     return float(obj)
    if isinstance(obj, (np.bool_,)):        return bool(obj)
    if isinstance(obj, np.ndarray):         return obj.tolist()
    raise TypeError(f"Not JSON serializable: {type(obj)}")


async def _ws_broadcaster():
    tick = 0
    print("[WS] Broadcaster loop aktif (interval 1s).")
    while True:
        try:
            await asyncio.sleep(1)
            tick += 1

            alerts = shared.get_alerts()
            stats  = shared.get_stats()

            # Log periodik supaya ketahuan broadcaster masih hidup
            if tick % 5 == 0 or alerts:
                print(f"[WS t={tick:04d}] clients={len(_ws_clients)} "
                      f"alerts={len(alerts)} stats={stats}")

            if not _ws_clients:
                continue

            try:
                payload = json.dumps({"alerts": alerts, "stats": stats}, default=_json_safe)
            except Exception as e:
                print(f"[WS ERROR] json.dumps gagal: {e}; sample alert={alerts[:1]}")
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
    proc_thread = threading.Thread(target=processor.run, daemon=True, name="VideoProcessor")
    proc_thread.start()
    print("[API] VideoProcessor thread dimulai.")

    broadcaster_task = asyncio.create_task(_ws_broadcaster())
    print("[API] WebSocket broadcaster dimulai.")

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
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Upload video file
# ══════════════════════════════════════════════════════════════
@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    """
    Upload file video dari frontend.
    Simpan ke folder uploads/ dan kembalikan path-nya.
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

    shared.set_source(source)
    shared.set_roi_mode(payload.roi_mode)

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
async def _mjpeg_generator():
    BOUNDARY = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
    TAIL     = b"\r\n"

    import cv2
    import numpy as np
    blank = np.zeros((480, 854, 3), dtype=np.uint8)
    cv2.putText(blank, "Menghubungkan ke processor...",
                (60, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (60, 60, 80), 2)
    _, buf = cv2.imencode('.jpg', blank)
    placeholder_bytes = buf.tobytes()

    while True:
        frame = shared.get_frame()
        if frame is None:
            frame = placeholder_bytes
        yield BOUNDARY + frame + TAIL
        await asyncio.sleep(0.04)


@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        _mjpeg_generator(),
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

    initial = json.dumps(
        {"alerts": shared.get_alerts(), "stats": shared.get_stats()},
        default=_json_safe,
    )
    await websocket.send_text(initial)

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
    }


@app.get("/")
async def root():
    return {"message": "Smart Parking API v2 aktif", "docs": "/docs"}
