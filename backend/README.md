# Backend — FastAPI + YOLOv8 + Edge-TTS

> **v1.0 Prototype** — Arsitektur dan API dapat berubah di versi mendatang.

Backend sistem deteksi parkir liar. Menjalankan inferensi YOLOv8, multi-object tracking (BotSORT), klasifikasi warna kendaraan, dan text-to-speech alert — semuanya di-expose via REST API dan WebSocket untuk dikonsumsi oleh frontend dashboard.

---

## Arsitektur Modul

```
backend/
├── __init__.py        # Package init (kosong)
├── main.py            # FastAPI app — endpoint, WebSocket, lifespan
├── processor.py       # VideoProcessor — inti pipeline deteksi
└── shared.py          # SharedState — bridge thread-safe antar modul
```

### Bagaimana Ketiga Modul Bekerja Bersama

```
                    ┌─────────────────────────┐
                    │       main.py            │
                    │   (FastAPI + Uvicorn)    │
                    │                         │
                    │  REST API endpoints     │
                    │  WebSocket broadcaster  │
                    │  MJPEG stream generator │
                    └───────────┬─────────────┘
                                │
                         read / write
                                │
                    ┌───────────▼─────────────┐
                    │      shared.py           │
                    │   (SharedState)          │
                    │                         │
                    │  Thread-safe state:     │
                    │  - frame JPEG terbaru   │
                    │  - daftar alert aktif   │
                    │  - konfigurasi source   │
                    │  - ROI polygons         │
                    │  - first frame          │
                    └───────────┬─────────────┘
                                │
                         read / write
                                │
                    ┌───────────▼─────────────┐
                    │     processor.py         │
                    │   (VideoProcessor)       │
                    │                         │
                    │  Background thread:     │
                    │  - YOLO inference       │
                    │  - BotSORT tracking     │
                    │  - Stationary analysis  │
                    │  - Triangle check       │
                    │  - Color classification │
                    │  - TTS alert playback   │
                    └─────────────────────────┘
```

- **`main.py`** berjalan di async event loop (Uvicorn). Menerima request HTTP dan mengelola koneksi WebSocket.
- **`processor.py`** berjalan di **daemon thread** terpisah (blocking OpenCV + YOLO). Memproses 1 frame per detik (1 fps logic tick).
- **`shared.py`** adalah jembatan thread-safe (menggunakan `threading.Lock`) yang memungkinkan kedua modul berkomunikasi tanpa race condition.

---

## Modul Detail

### `main.py` — FastAPI Application

Bertanggung jawab untuk:

- **Lifecycle management**: Menjalankan VideoProcessor di background thread saat startup, menghentikannya saat shutdown.
- **File upload**: Menerima video file dari frontend, menyimpan ke `uploads/`.
- **Konfigurasi**: Menerima pilihan sumber video (file/kamera) dan mode ROI (manual/auto).
- **MJPEG streaming**: Men-generate multipart JPEG stream dari SharedState.
- **WebSocket broadcasting**: Mengirim data alert + statistik ke semua client setiap 1 detik.
- **CORS**: Mengizinkan akses dari frontend di `localhost:5173`.

#### Endpoint Reference

| Method | Path | Fungsi |
|---|---|---|
| `POST` | `/upload` | Upload file video (MP4, AVI, MOV, MKV, WebM) |
| `POST` | `/configure` | Set sumber video + mode ROI |
| `GET` | `/first_frame` | Frame pertama sebagai JPEG (untuk drawing ROI) |
| `POST` | `/set_roi` | Terima koordinat polygon zona larangan parkir |
| `GET` | `/video_feed` | MJPEG stream (continuous) |
| `WS` | `/ws/alerts` | WebSocket — push alert + stats setiap 1 detik |
| `GET` | `/status` | Status processor, source, ROI, stats |
| `GET` | `/debug` | Snapshot lengkap state (troubleshooting) |
| `GET` | `/` | Health check |
| `GET` | `/docs` | Swagger UI (auto-generated) |

### `processor.py` — VideoProcessor

Inti dari sistem deteksi. Menjalankan pipeline berikut setiap 1 detik (1 tick = 1 logic second):

```
1. Baca frame dari video/kamera
2. Jalankan YOLO vehicle tracking (car, bus, truck, motorcycle)
3. Filter deteksi yang berada di dalam ROI
4. Assignment: tracker_id → logical_id (dengan re-linking untuk occlusion)
5. Analisis stasioner (apakah kendaraan diam > 3 detik?)
6. Jika diam > 60 detik → cek segitiga pengaman (YOLO kedua)
7. Jika diam > 300 detik tanpa segitiga → VIOLATION + TTS alert
8. Encode frame hasil annotasi ke JPEG → push ke SharedState
9. Build daftar alert → push ke SharedState
```

**Fitur utama di processor:**

| Fitur | Deskripsi |
|---|---|
| Re-linking | Ketika tracker kehilangan ID, sistem mencocokkan deteksi baru ke record lama berdasarkan IoU, jarak, durasi parkir, dan warna |
| Occlusion TTL | Kendaraan tersembunyi tetap dilacak hingga 80 detik |
| Color classification | HSV-based, 12 kategori warna, tanpa ML tambahan |
| TTS | Edge-TTS (`id-ID-GadisNeural`), non-blocking via thread terpisah |
| Auto-loop video | Video file otomatis loop dari awal saat selesai |
| Live reconfigure | Frontend bisa mengganti source/ROI tanpa restart processor |

### `shared.py` — SharedState

State container thread-safe dengan `threading.Lock`. Menyimpan:

| State | Tipe | Penjelasan |
|---|---|---|
| `_frame_jpeg` | `bytes` | Frame JPEG terbaru untuk MJPEG stream |
| `_first_frame_jpeg` | `bytes` | Frame pertama untuk ROI drawing |
| `_alerts` | `List[Dict]` | Daftar alert aktif (visible vehicles only) |
| `_stats` | `Dict` | Statistik agregat (total, warning, violation, safe) |
| `_roi_pending` | `List[List]` | ROI yang belum diambil processor |
| `_source_config` | `Dict` | Konfigurasi sumber video aktif |
| `_source_pending` | `Dict` | Konfigurasi sumber baru (belum diambil processor) |
| `_roi_mode` | `str` | `"manual"` atau `"auto"` |
| `_running` | `bool` | Apakah processor sedang aktif |

Pola komunikasi menggunakan **take pattern**: processor memanggil `take_roi()` / `take_source()` yang mengembalikan nilai pending lalu me-reset ke `None`, memastikan setiap perubahan hanya diproses sekali.

---

## Cara Menjalankan

### Standalone (tanpa Docker)

```bash
# Dari root project
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Dengan hot-reload (development)
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

### Dengan Docker

```bash
cd docker
docker compose up --build backend
```

### Environment Variables

| Variable | Default | Deskripsi |
|---|---|---|
| `ENABLE_TTS` | `true` | Aktifkan/matikan TTS audio alert |
| `SDL_AUDIODRIVER` | `dummy` (Docker) | Audio driver untuk pygame (`dummy`, `alsa`, `pulse`) |

---

## Konfigurasi Deteksi

Parameter utama di bagian atas `processor.py`:

```python
PARKING_CHECK_SECONDS   = 60    # Detik sebelum status WARNING
ILLEGAL_PARKING_SECONDS = 300   # Detik sebelum status VIOLATION
VEHICLE_CONF            = 0.25  # Confidence threshold deteksi kendaraan
TRIANGLE_CONF           = 0.20  # Confidence threshold deteksi segitiga
OCCLUSION_TTL_SECONDS   = 80    # Maks detik kendaraan tersembunyi tetap dilacak
TTS_REPEAT_GAP          = 20    # Interval pengulangan TTS alert (detik)
```

---

## Alert Status Flow

```
Kendaraan masuk ROI
  │
  ├─ 0–3 detik      → Cek stasioner (filter noise)
  ├─ 3–60 detik      → MONITORING (kotak kuning)
  ├─ 60–300 detik    → WARNING (kotak oranye) + cek segitiga
  │     └─ Segitiga ditemukan → SAFE (kotak hijau)
  └─ >300 detik      → VIOLATION (kotak merah) + TTS alert
        (tanpa segitiga)
```
