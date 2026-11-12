"""
backend/main.py
─────────────────────────────────────────────────────────────────
FastAPI application.

Endpoints:
  GET  /upload/check  → Cari video yang sama di uploads/ (tanpa unggah ulang)
  PUT  /upload/stream → Upload file video (isi body = isi file), langsung ke disk
  POST /upload        → Upload file video (multipart, cara lama), simpan ke disk
  POST /configure     → Set sumber (video/camera/rtsp) + mode ROI
  GET  /first_frame   → Ambil frame pertama sebagai JPEG (untuk drawing ROI)
  POST /set_roi       → Terima koordinat multi-polygon ROI dari frontend
  GET  /video_feed    → MJPEG stream (satu part tiap ada frame baru)
  WS   /ws/alerts     → WebSocket: push JSON {alerts, stats, proc} setiap 1 detik
  GET  /status        → Info status processor (termasuk "proc")
  GET  /debug         → Snapshot state untuk troubleshooting
"""

import asyncio
import hashlib
import json
import os
import re
import threading
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import cv2
import numpy as np
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from starlette.requests import ClientDisconnect
from typing import Optional, List

from .shared import SharedState
from urllib.parse import urlsplit

from .processor import VideoProcessor, print_effective_config, mask_url, public_source


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
    _remove_stale_parts()
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
    # Beri waktu tick yang sedang berjalan selesai, supaya state sesi kamera tersimpan rapi
    await asyncio.to_thread(proc_thread.join, 5)
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
# Upload video: aturan bersama
# ══════════════════════════════════════════════════════════════
# - File di uploads/ tidak pernah ditimpa. Nama yang sudah dipakai video lain
#   menjadi "nama-2.mp4", "nama-3.mp4", ... (file lama bisa saja sedang dibaca
#   processor sebagai sumber aktif).
# - Video yang isinya sama dengan file yang sudah ada di uploads/ tidak
#   disimpan dua kali. Kesamaan dicek dari ukuran + "sidik" video: SHA-256 atas
#   tiga potongan 1 MiB (awal, tengah, akhir). Rumus yang sama dipakai
#   dashboard (videoSample di SetupWizard.jsx) sebelum mengunggah.
ALLOWED_VIDEO_EXTS   = {".mp4", ".avi", ".mov", ".mkv", ".webm"}
SAMPLE_BYTES         = 1024 * 1024        # panjang tiap potongan sidik video
UPLOAD_WRITE_BYTES   = 4 * 1024 * 1024    # data unggahan ditulis ke disk per 4 MiB
UPLOAD_CHUNK_TIMEOUT = 60                 # detik tanpa data → unggahan dianggap putus
_WINDOWS_RESERVED    = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                        *(f"LPT{i}" for i in range(1, 10))}

_upload_name_lock = threading.Lock()      # pilih nama + rename tidak boleh balapan
_sample_cache: dict = {}                  # (path, size, mtime_ns) → sidik
# Unggahan yang sedang ditulis: uploads/.<32 hex>.part (titik di depan: dilewati
# find_same_video). Hanya nama PERSIS seperti ini yang pernah dihapus otomatis.
_PART_RE = re.compile(r"\.[0-9a-f]{32}\.part")


def _new_part_path() -> Path:
    return UPLOAD_DIR / f".{uuid.uuid4().hex}.part"


def _remove_stale_parts() -> None:
    """
    Saat startup: buang sisa unggahan yang terputus karena backend dimatikan
    paksa (mis. jendelanya ditutup) sehingga `finally` tidak sempat jalan.
    start_minipc.bat tidak menjalankan backend kedua, jadi tidak ada .part
    yang sedang ditulis saat ini.
    """
    for p in UPLOAD_DIR.glob(".*.part"):
        if not _PART_RE.fullmatch(p.name):
            continue
        try:
            p.unlink()
            print(f"[API] Sisa unggahan terputus dihapus: {p.name}")
        except OSError as e:
            print(f"[API] Sisa unggahan {p.name} tidak bisa dihapus: {e}")


def _is_local_client(request: Request) -> bool:
    """Browser di komputer ini sendiri (loopback, atau IP klien = IP server)."""
    client = request.client.host if request.client else ""
    server = (request.scope.get("server") or ("",))[0]
    return client in ("127.0.0.1", "::1") or (bool(client) and client == server)


def _sample_ranges(size: int) -> List[tuple]:
    if size <= 3 * SAMPLE_BYTES:
        return [(0, size)]
    mid = size // 2 - SAMPLE_BYTES // 2
    return [(0, SAMPLE_BYTES), (mid, mid + SAMPLE_BYTES), (size - SAMPLE_BYTES, size)]


def video_sample(path: Path, size: int) -> str:
    """Sidik video (hex). Hanya membaca paling banyak 3 MiB."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for start, end in _sample_ranges(size):
            f.seek(start)
            h.update(f.read(end - start))
    return h.hexdigest()


def find_same_video(size: int, sample: str) -> Optional[Path]:
    """Video di uploads/ dengan ukuran + sidik yang sama, atau None."""
    for p in sorted(UPLOAD_DIR.iterdir()):
        if p.name.startswith(".") or p.suffix.lower() not in ALLOWED_VIDEO_EXTS:
            continue
        try:
            st = p.stat()
            if not p.is_file() or st.st_size != size:
                continue
            key = (p.name, st.st_size, st.st_mtime_ns)
            if key not in _sample_cache:
                _sample_cache[key] = video_sample(p, st.st_size)
            if _sample_cache[key] == sample:
                return p
        except OSError:
            continue        # file sedang dipakai / hilang: lewati saja
    return None


def safe_upload_name(raw: str) -> str:
    """Nama file saja (tanpa folder), aman untuk Windows. "" bila tidak bisa dipakai."""
    name = Path(str(raw).replace("\\", "/")).name
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip().rstrip(". ")
    if not name or name.startswith("."):
        return ""
    if name.split(".")[0].upper() in _WINDOWS_RESERVED:
        name = f"_{name}"
    return name


def _claim_upload_path(src: Path, name: str) -> Path:
    """Pindahkan src ke uploads/<name> (atau nama-2, nama-3, ... bila sudah dipakai)."""
    stem, ext = os.path.splitext(name)
    with _upload_name_lock:
        for n in range(1, 10000):
            dest = UPLOAD_DIR / (name if n == 1 else f"{stem}-{n}{ext}")
            if dest.exists():
                continue
            try:
                os.rename(src, dest)     # di Windows gagal bila dest ada → coba nama berikutnya
                return dest
            except FileExistsError:
                continue
    raise OSError(f"Tidak ada nama bebas untuk {name}")


def _upload_result(dest: Path, reused: bool) -> dict:
    return {"status": "ok", "path": str(dest), "filename": dest.name, "reused": reused}


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Cek video yang sudah ada (sebelum upload)
# ══════════════════════════════════════════════════════════════
@app.get("/upload/check")
def upload_check(size: int = Query(..., ge=0), sample: str = Query(..., min_length=64, max_length=64)):
    """
    Dashboard mengirim ukuran + sidik video yang dipilih user. Bila video yang
    sama sudah ada di uploads/, path-nya dikembalikan dan dashboard langsung
    memakainya tanpa mengunggah ulang.
    """
    found = find_same_video(size, sample.lower())
    if found is None:
        return {"status": "ok", "found": False}
    print(f"[API] Video sudah ada, tidak diunggah ulang: {found}")
    return {**_upload_result(found, True), "found": True}


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Upload video file (body = isi file)
# ══════════════════════════════════════════════════════════════
@app.put("/upload/stream")
async def upload_stream(request: Request, filename: str = Query(...)):
    """
    Isi file dikirim apa adanya sebagai body (bukan multipart) dan langsung
    ditulis ke uploads/: tanpa file sementara di %TEMP% dan tanpa salinan
    kedua, jadi setelah progres 100 % file sudah tersimpan.

    Selama unggahan dari browser DI KOMPUTER INI berjalan, processor menunda
    tick sumber file video (state "paused") supaya CPU dipakai unggahan; lihat
    VideoProcessor._run_inner. Unggahan dari perangkat lain di jaringan tidak
    menunda deteksi: kecepatannya dibatasi jaringan, bukan CPU, dan bisa lama.
    Unggahan yang putus atau tidak lengkap dibuang.
    """
    name = safe_upload_name(filename)
    ext  = Path(name).suffix.lower()
    if not name or ext not in ALLOWED_VIDEO_EXTS:
        return {"status": "error", "message": f"Format tidak didukung: {ext or filename}"}
    try:
        expected = int(request.headers.get("content-length", ""))
    except ValueError:
        expected = None

    part = _new_part_path()
    received = 0
    pause = _is_local_client(request)
    if pause:
        shared.begin_upload()
    try:
        f = await anyio.to_thread.run_sync(part.open, "wb")
        try:
            pending: List[bytes] = []
            pending_bytes = 0
            chunks = request.stream().__aiter__()
            while True:
                try:
                    # anyio.fail_after, bukan asyncio.wait_for: di Python 3.11.0
                    # wait_for bisa menelan pembatalan task (mis. saat shutdown)
                    with anyio.fail_after(UPLOAD_CHUNK_TIMEOUT):
                        chunk = await chunks.__anext__()
                except StopAsyncIteration:
                    break
                if not chunk:
                    continue
                received += len(chunk)
                pending.append(chunk)
                pending_bytes += len(chunk)
                if pending_bytes >= UPLOAD_WRITE_BYTES:
                    await anyio.to_thread.run_sync(f.write, b"".join(pending))
                    pending, pending_bytes = [], 0
            if pending:
                await anyio.to_thread.run_sync(f.write, b"".join(pending))
        finally:
            await anyio.to_thread.run_sync(f.close)

        if received == 0 or (expected is not None and received != expected):
            return {"status": "error", "message": f"Unggahan tidak lengkap ({received} dari {expected} byte)"}

        sample = await anyio.to_thread.run_sync(video_sample, part, received)
        same = await anyio.to_thread.run_sync(find_same_video, received, sample)
        if same is not None:
            print(f"[API] Video yang sama sudah ada, unggahan dibuang: {same}")
            return _upload_result(same, True)
        dest = await anyio.to_thread.run_sync(_claim_upload_path, part, name)
        print(f"[API] Video diupload: {dest} ({received // 1024} KB)")
        return _upload_result(dest, False)
    except (ClientDisconnect, TimeoutError):
        print(f"[API] Unggahan {name} putus setelah {received // 1024} KB, dibuang.")
        return {"status": "error", "message": "Unggahan terputus"}
    except OSError as e:
        # Disk penuh, file dikunci antivirus, dll. Dijawab JSON (bukan 500
        # polos tanpa header CORS) supaya dashboard menampilkan sebab aslinya.
        print(f"[API] Unggahan {name} gagal disimpan: {e}")
        return {"status": "error", "message": f"Video tidak bisa disimpan di server: {e.strerror or e}"}
    finally:
        if pause:
            shared.end_upload()
        try:
            part.unlink(missing_ok=True)    # sisa unggahan gagal / duplikat
        except OSError as e:
            print(f"[API] File sementara {part} tidak bisa dihapus: {e}")


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Upload video file (multipart, cara lama)
# ══════════════════════════════════════════════════════════════
@app.post("/upload")
def upload_video(file: UploadFile = File(...)):
    """
    Upload file video lewat multipart/form-data (cara lama; dashboard sekarang
    memakai GET /upload/check + PUT /upload/stream). Starlette menampung body
    ke file sementara dulu, lalu isinya disalin ke uploads/.

    Sengaja `def` biasa (bukan async): FastAPI menjalankannya di threadpool,
    jadi penyalinan file besar tidak menahan event loop (stream + WebSocket).
    """
    name = safe_upload_name(file.filename or "")
    ext = Path(name).suffix.lower()
    if not name or ext not in ALLOWED_VIDEO_EXTS:
        return {"status": "error", "message": f"Format tidak didukung: {ext or file.filename}"}

    part = _new_part_path()
    try:
        with part.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        size = part.stat().st_size
        same = find_same_video(size, video_sample(part, size))
        if same is not None:
            print(f"[API] Video yang sama sudah ada, unggahan dibuang: {same}")
            return _upload_result(same, True)
        dest = _claim_upload_path(part, name)
    except OSError as e:
        print(f"[API] Unggahan {name} gagal disimpan: {e}")
        return {"status": "error", "message": f"Video tidak bisa disimpan di server: {e.strerror or e}"}
    finally:
        try:
            part.unlink(missing_ok=True)
        except OSError as e:
            print(f"[API] File sementara {part} tidak bisa dihapus: {e}")

    print(f"[API] Video diupload: {dest} ({dest.stat().st_size // 1024} KB)")
    return _upload_result(dest, False)


# ══════════════════════════════════════════════════════════════
# ENDPOINT: Configure sumber + mode ROI
# ══════════════════════════════════════════════════════════════
class ConfigurePayload(BaseModel):
    source_type: str          # "video" | "camera" | "rtsp"
    path: Optional[str] = None
    camera_index: Optional[int] = 0
    url: Optional[str] = None # rtsp: rtsp://user:password@ip:554/Streaming/Channels/101
    roi_mode: str = "manual"  # "manual" | "auto"


def _rtsp_url_error(url: str) -> Optional[str]:
    """Pesan galat bila alamat kamera IP jelas salah; None bila boleh dicoba dibuka."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port                      # port bukan angka → ValueError
    except ValueError:
        return "Alamat kamera IP tidak valid."
    if parts.scheme.lower() not in ("rtsp", "rtsps"):
        return "Alamat kamera IP harus diawali rtsp://"
    if not host:
        return "Alamat kamera IP belum berisi IP kamera."
    return None


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
    elif payload.source_type == "rtsp":
        url = (payload.url or "").strip()
        if not url:
            return {"status": "error", "message": "url diperlukan untuk mode kamera IP."}
        message = _rtsp_url_error(url)
        if message:
            return {"status": "error", "message": message}
        source = {"type": "rtsp", "url": url}
    else:
        return {"status": "error", "message": f"source_type tidak valid: {payload.source_type}"}

    # Sumber + mode ROI disimpan sekaligus; data sumber lama ikut dikosongkan
    shared.set_source(source, payload.roi_mode)

    # Password kamera IP tidak pernah dicetak / dikirim balik
    print(f"[API] Konfigurasi: source={public_source(source)}, roi_mode={payload.roi_mode}")
    return {"status": "ok", "source": public_source(source), "roi_mode": payload.roi_mode}


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
    source = public_source(shared.get_source())
    return {
        "running":        shared.is_running(),
        "source":         source,
        "roi_mode":       shared.get_roi_mode(),
        "has_first_frame": shared.get_first_frame() is not None,
        "stats":          shared.get_stats(),
        "alerts":         shared.get_alerts(),
        "proc":           shared.get_proc(),
        "session":        shared.get_session(),   # sesi kamera (log + screenshot), None bila tidak ada
    }


@app.get("/debug")
async def debug_state():
    """Snapshot state untuk troubleshooting event log kosong."""
    return {
        "running":          shared.is_running(),
        "source":           public_source(shared.get_source()),
        "roi_mode":         shared.get_roi_mode(),
        "has_first_frame":  shared.get_first_frame() is not None,
        "roi_pending":      shared.has_roi_pending(),
        "ws_clients":       len(_ws_clients),
        "alerts_count":     len(shared.get_alerts()),
        "alerts":           shared.get_alerts(),
        "stats":            shared.get_stats(),
        "proc":             shared.get_proc(),
        "session":          shared.get_session(),
    }


@app.get("/")
async def root():
    return {"message": "Smart Parking API v2 aktif", "docs": "/docs"}
