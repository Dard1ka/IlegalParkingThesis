# Backend — FastAPI + YOLO11 (Ultralytics) + Edge-TTS

> **v1.0 Prototype** — Arsitektur dan API dapat berubah di versi mendatang.

Backend sistem deteksi parkir liar. Menjalankan inferensi YOLO lewat Ultralytics (model kendaraan `best.pt` adalah YOLO11m), multi-object tracking (BotSORT), klasifikasi warna kendaraan, dan text-to-speech alert — semuanya di-expose via REST API dan WebSocket untuk dikonsumsi oleh frontend dashboard.

---

## Arsitektur Modul

```
backend/
├── __init__.py          # Package init (kosong)
├── main.py              # FastAPI app — endpoint, WebSocket, lifespan
├── processor.py         # VideoProcessor — inti pipeline deteksi
├── shared.py            # SharedState — bridge thread-safe antar modul
└── botsort_static.yaml  # Tracker opsional (BoT-SORT tanpa GMC) — hanya dipakai kalau PARKING_TRACKER=botsort_static.yaml
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
- **`processor.py`** berjalan di **daemon thread** terpisah (blocking OpenCV + YOLO). Untuk file video, satu tick memproses satu frame per detik video (jaraknya bisa diatur lewat `PARKING_TICK_STEP`); untuk kamera, satu tick = satu frame yang diproses.
- **`shared.py`** adalah jembatan thread-safe (menggunakan `threading.Lock`) yang memungkinkan kedua modul berkomunikasi tanpa race condition.

---

## Modul Detail

### `main.py` — FastAPI Application

Bertanggung jawab untuk:

- **Lifecycle management**: Menjalankan VideoProcessor di background thread saat startup, menghentikannya saat shutdown.
- **File upload**: Menerima video file dari frontend, menyimpan ke `uploads/`.
- **Konfigurasi**: Menerima pilihan sumber video (file/kamera) dan mode ROI (manual/auto).
- **MJPEG streaming**: Men-generate multipart JPEG stream dari SharedState.
- **WebSocket broadcasting**: Mengirim data alert + statistik + status processor (`proc`) ke semua client setiap 1 detik.
- **CORS**: Daftar origin frontend yang diizinkan diatur lewat `PARKING_CORS_ORIGINS` (default: `localhost`/`127.0.0.1` port 5173 dan 4173).

#### Endpoint Reference

| Method | Path | Fungsi |
|---|---|---|
| `POST` | `/upload` | Upload file video (MP4, AVI, MOV, MKV, WebM) |
| `POST` | `/configure` | Set sumber video + mode ROI |
| `GET` | `/first_frame` | Frame pertama sumber yang baru dikonfigurasi sebagai JPEG (untuk drawing ROI); `204` selama frame itu belum tersedia |
| `POST` | `/set_roi` | Terima koordinat polygon zona larangan parkir |
| `GET` | `/video_feed` | MJPEG stream (mengirim frame hanya saat ada frame baru) |
| `WS` | `/ws/alerts` | WebSocket — push `alerts` + `stats` + `proc` setiap 1 detik |
| `GET` | `/status` | Status processor (`proc`), source, ROI, stats |
| `GET` | `/debug` | Snapshot lengkap state (troubleshooting) |
| `GET` | `/` | Health check |
| `GET` | `/docs` | Swagger UI (auto-generated) |

#### Status Processor (`proc`)

`GET /status` dan setiap pesan WebSocket `/ws/alerts` membawa objek `proc`, sehingga dashboard (atau `curl`) bisa melihat apa yang sedang dikerjakan processor tanpa membuka log:

```json
"proc": { "state": "running", "tick": 42, "tick_ms": 850.3, "error": null }
```

(Angka di atas hanya contoh bentuk data, bukan hasil pengukuran.)

| Field | Arti |
|---|---|
| `state` | Tahap processor saat ini (lihat tabel di bawah) |
| `tick` | Jumlah tick yang sudah selesai untuk sumber yang sedang aktif |
| `tick_ms` | Lama tick terakhir dalam milidetik (waktu nyata), `null` kalau belum ada tick |
| `error` | Pesan error terakhir, `null` kalau tidak ada |

| `state` | Arti |
|---|---|
| `loading_models` | Model YOLO sedang dimuat |
| `waiting_source` | Menunggu sumber video dari `POST /configure` |
| `opening_source` | Sedang membuka file video / kamera |
| `waiting_roi` | Sumber sudah terbuka, menunggu zona dari `POST /set_roi` |
| `running` | Deteksi berjalan |
| `error` | Processor gagal — penyebabnya ada di field `error` |
| `stopped` | Processor dihentikan |

### `processor.py` — VideoProcessor

Inti dari sistem deteksi. Menjalankan pipeline berikut pada setiap tick (file video: 1 tick = 1 detik video; kamera: 1 tick = 1 frame yang diproses):

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
| Re-linking | Ketika tracker kehilangan ID, sistem mencocokkan deteksi baru ke record lama berdasarkan IoU, jarak, dan durasi parkir (kelas kendaraan dan zona harus sama). Warna tidak dipakai untuk pencocokan — hanya untuk label dashboard dan teks peringatan suara |
| Occlusion TTL | Kendaraan tersembunyi tetap dilacak hingga 80 detik |
| Color classification | HSV-based, 12 kategori warna, tanpa ML tambahan. Dijalankan saat kendaraan pertama kali terlihat, lalu sekali lagi saat kendaraan mulai dianggap parkir (bukan menunggu 300 detik) |
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
# Dari root project (Python 3.11)
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Ini perintah untuk pemakaian biasa, demo, dan mini PC — **tanpa** `--reload`.

Khusus saat mengembangkan kode backend, hot-reload bisa dipakai asalkan dibatasi ke folder `backend/`:

```bash
# Development saja — jalankan dari root project
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend
```

> `--reload` tanpa `--reload-dir` memantau **seluruh** root project (termasuk `environments/`, `demo*.py`, `backup-backend/`). Setiap file `.py` yang berubah di mana pun akan me-restart backend: model dimuat ulang dan seluruh state tracking (durasi parkir) hilang.

> `lap` (dipakai tracker BoT-SORT/ByteTrack) sekarang dependency biasa di `requirements.txt`. Sebelumnya paket ini dipasang otomatis oleh Ultralytics pada tick pertama, yang butuh internet dan gagal diam-diam saat offline. Kalau environment lama belum punya `lap`, cukup jalankan ulang `pip install -r requirements.txt`.

### PC lambat (CPU lama tanpa AVX2)

Di mesin seperti mini PC Intel Core i5-2400, satu tick bisa memakan waktu lebih dari satu detik. Urutan langkahnya — benchmark di mesin itu dengan `tools/benchmark_inference.py`, memilih `PARKING_TICK_STEP`, menguji model ONNX, dan daftar pilihan mana yang mengubah hasil deteksi — ada di [`SETUP.md` → Menjalankan di PC Lambat](../SETUP.md#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2).

### Dengan Docker

```bash
cd docker
docker compose up --build backend
```

Di Docker, variabel di bawah diisi lewat file `docker/.env` (lihat [`docker/README.md`](../docker/README.md)).

### Environment Variables

Semua konfigurasi di bawah dibaca **satu kali saat backend start** — setelah mengubah nilainya, restart backend. Nilai yang tidak valid (mis. `PARKING_VEHICLE_IMGSZ=abc`) tidak membuat backend gagal start: nilainya diabaikan, default dipakai, dan satu baris peringatan dicetak di log. Tanpa variabel apa pun, backend berjalan dengan nilai default.

| Variable | Default | Arti |
|---|---|---|
| `PARKING_VEHICLE_MODEL` | `best.pt` | Model deteksi kendaraan. Boleh file `.pt` atau model hasil export, mis. `best.onnx` (ONNX Runtime) — lihat catatan "Model hasil export" di bawah. |
| `PARKING_TRIANGLE_MODEL` | `triangle.pt` | Model deteksi segitiga pengaman. |
| `PARKING_VEHICLE_IMGSZ` | `960` | Ukuran input (piksel) model kendaraan; dibulatkan ke atas ke kelipatan 32. Mengubahnya memengaruhi kecepatan dan hasil deteksi. Model hasil export yang statis mengabaikan nilai ini (export dengan `dynamic=True`). |
| `PARKING_TRIANGLE_IMGSZ` | `640` | Ukuran input (piksel) model segitiga; dibulatkan ke atas ke kelipatan 32. |
| `PARKING_TICK_STEP` | `1` | Bilangan bulat ≥ 1. **Hanya untuk file video**: jumlah detik video yang dimajukan per tick. Tidak berpengaruh pada mode kamera. |
| `PARKING_TRACKER` | `botsort.yaml` | Konfigurasi tracker. Default-nya BoT-SORT bawaan Ultralytics (dengan GMC). Nilai lain: `bytetrack.yaml` (bawaan Ultralytics), path ke file YAML sendiri, atau `botsort_static.yaml` = file bawaan `backend/botsort_static.yaml` (BoT-SORT tanpa GMC). Yang terakhir **opt-in**: sedikit lebih ringan, tetapi bisa mengubah logical id / durasi sebagian kendaraan. |
| `PARKING_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173` | Origin dashboard yang boleh memanggil API, dipisah koma. Port 5173 = `npm run dev` / Docker, 4173 = `npm run preview`. |
| `ENABLE_TTS` | `true` (`false` di Docker) | Aktifkan/matikan TTS audio alert. `false`, `0`, atau `no` = mati. |
| `VITE_API_BASE` | *(kosong)* → `http://<hostname halaman dashboard>:8000` | **Frontend, bukan backend**: alamat backend yang dipakai dashboard. Dibaca Vite saat `npm run dev` / `npm run build` (lihat [`parking-dashboard/README.md`](../parking-dashboard/README.md)). |

Catatan:

- Path relatif (`best.pt`, `triangle.pt`, file YAML tracker buatan sendiri) dihitung dari folder tempat backend dijalankan, yaitu root project. Pengecualian: nama `botsort_static.yaml` selalu berarti file bawaan `backend/botsort_static.yaml`, dari folder mana pun backend dijalankan; `botsort.yaml` dan `bytetrack.yaml` adalah file bawaan Ultralytics.
- Kalau dashboard dibuka dari perangkat lain di jaringan (mis. `http://192.168.1.20:5173`), origin itu harus ditambahkan ke `PARKING_CORS_ORIGINS`. Tanpa itu pemanggilan API dari wizard (`/upload`, `/configure`, `/first_frame`, `/set_roi`) diblokir browser.
- **Model hasil export** bersifat opsional dan butuh paket yang tidak dipasang `requirements.txt` (dan tidak ada di image Docker):
  - `best.onnx` butuh `onnxruntime` dan `onnx`. Hasil deteksinya identik dengan `best.pt` pada `imgsz` yang sama, tetapi belum terbukti bisa jalan di CPU tanpa AVX2 — uji dulu di mesin target dengan `tools/benchmark_inference.py`. Export harus dengan `dynamic=True`; kalau tidak, `PARKING_VEHICLE_IMGSZ` diabaikan (Ultralytics memakai ukuran saat export).
  - OpenVINO (folder `best_openvino_model`, paket `openvino`) hanya untuk CPU **dengan** AVX2. Jangan dipakai di CPU lama tanpa AVX2 seperti Core i5-2400.
  - Perintah export dan urutan ujinya ada di [`SETUP.md` → Menjalankan di PC Lambat](../SETUP.md#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2).
- `SDL_AUDIODRIVER` (variabel milik SDL/pygame, bukan milik proyek) menentukan audio driver: tidak perlu diset di Windows; di Docker default-nya `dummy` (tanpa suara), bisa diganti `alsa` / `pulse`.

#### Cara mengisi variabel

Variabel hanya berlaku untuk jendela terminal tempat ia diset, jadi set dulu baru jalankan `uvicorn` di jendela yang sama.

Windows — Command Prompt (cmd):

```bat
set ENABLE_TTS=false
set PARKING_CORS_ORIGINS=http://localhost:5173,http://192.168.1.20:5173
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

> Di cmd jangan beri spasi di sekitar `=` dan jangan pakai tanda kutip — keduanya ikut menjadi bagian dari nilai. Menghapus variabel: `set ENABLE_TTS=`.

Windows — PowerShell:

```powershell
$env:ENABLE_TTS = "false"
$env:PARKING_CORS_ORIGINS = "http://localhost:5173,http://192.168.1.20:5173"
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

> Menghapus variabel: `Remove-Item Env:ENABLE_TTS`.

Linux / macOS:

```bash
ENABLE_TTS=false PARKING_CORS_ORIGINS="http://localhost:5173,http://192.168.1.20:5173" \
  uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

#### Catatan `YOLO_OFFLINE` (instalasi native)

Image Docker menyetel `YOLO_OFFLINE=True` (variabel milik Ultralytics) supaya tidak ada cek online, telemetri, maupun auto-install paket saat runtime. Di instalasi native variabel ini **tidak** diset. Mengaktifkannya sendiri (`set YOLO_OFFLINE=true` di cmd, `$env:YOLO_OFFLINE = "true"` di PowerShell) aman selama `pip install -r requirements.txt` sudah selesai — dalam mode offline Ultralytics tidak bisa lagi mengunduh atau memasang apa pun sendiri, dan itulah sebabnya `lap` harus sudah terpasang dari `requirements.txt`. TTS (Edge-TTS) tetap membutuhkan internet terlepas dari variabel ini.

---

## Konfigurasi Deteksi

Model, ukuran input, tracker, dan TTS diatur lewat [environment variable](#environment-variables) tanpa mengubah kode. Parameter lain adalah konstanta di bagian atas `processor.py`:

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
