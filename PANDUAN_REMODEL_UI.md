# Panduan remodel UI — Parking Guard (AI Illegal Parking Detection)

Paket ini berisi seluruh sistem yang berjalan di mini PC per 10-11-2026: backend (FastAPI + YOLO) dan
frontend (React + Vite + Tailwind). Tujuannya: UI dashboard dirombak **tanpa mengubah backend**.

## 1. Isi paket

| Path | Isi |
|---|---|
| `backend\` | `main.py` (API), `processor.py` (deteksi, tracking, status parkir, TTS), `shared.py` (state bersama), `botsort_static.yaml` (tracker), `README.md` |
| `parking-dashboard\` | kode frontend (tanpa `node_modules\` dan `dist\`; jalankan `npm install`) |
| `best_ft1.onnx`, `best_ft1.pt` | model kendaraan hasil fine-tune (dipakai sekarang; `.onnx` lebih cepat di CPU) |
| `triangle.pt` | model segitiga pengaman |
| `start_minipc.bat` | menjalankan backend + dashboard hasil build di mini PC dengan satu klik |
| `tools\disable_quickedit.py` | dipakai `start_minipc.bat` untuk jendela backend |
| `requirements.txt` | paket Python (plus `onnxruntime` dan `onnx==1.18.0` untuk model `.onnx`) |
| `docker\` | opsi deployment Docker |
| `input2.mp4` | video contoh pendek (43 MB) untuk mencoba UI |
| `README.md`, `SETUP.md` | dokumentasi sistem dan instalasi |

## 2. Menjalankan untuk pengembangan UI

Butuh: Python 3.11, Node.js 18+ (di mini PC: Node 22).

```bat
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
pip install onnxruntime onnx==1.18.0
set PARKING_VEHICLE_MODEL=best_ft1.onnx
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Jalankan perintah di atas dari folder root paket, karena path model dibaca relatif dari folder kerja.

Di jendela lain:

```bat
cd parking-dashboard
npm install
npm run dev
```

Lalu buka http://localhost:5173.

- Kalau backend ada di komputer lain, isi `VITE_API_BASE=http://<ip>:8000` sebelum `npm run dev` / `npm run build`.
- Dokumentasi API otomatis ada di http://localhost:8000/docs.

## 3. Kontrak API (yang harus tetap dipakai UI baru)

Satu-satunya tempat alamat backend: `parking-dashboard\src\config.js` (`API_BASE`, `WS_URL`, `STREAM_URL`).

### 3.1 Alur pakai

1. **Pilih video** (salah satu):
   - **Video dari file:** `GET /upload/check`, lalu `PUT /upload/stream` bila belum ada di server.
   - **Kamera:** langsung ke langkah 2.
2. `POST /configure`.
3. Tunggu `GET /first_frame` mengembalikan JPEG. Selama belum siap, jawabannya 204.
4. Pengguna menggambar zona, lalu `POST /set_roi`.
5. Pantau dengan `GET /video_feed` (MJPEG) dan WebSocket `/ws/alerts`.

### 3.2 Endpoint

| Endpoint | Request | Response |
|---|---|---|
| `GET /upload/check?size=<byte>&sample=<sha256 hex>` | sidik video, lihat 3.4 | `{status:"ok", found:false}` atau `{status:"ok", found:true, path, filename, reused:true}` |
| `PUT /upload/stream?filename=<nama>` | body = isi file mentah (bukan multipart) | `{status:"ok", path, filename, reused}` / `{status:"error", message}` |
| `POST /upload` | multipart `file` (cara lama) | sama seperti di atas |
| `POST /configure` | `{source_type:"video"\|"camera", path?, camera_index?, roi_mode:"manual"\|"auto"}` | `{status:"ok", source, roi_mode}` / `{status:"error", message}` |
| `GET /first_frame` | – | JPEG, atau 204 bila belum siap |
| `POST /set_roi` | `{rois: [[[x,y],...], ...]}`; koordinat **ternormalisasi 0..1**, minimal 3 titik per zona | `{status:"ok", zones, points}` |
| `GET /video_feed` | – | MJPEG (`multipart/x-mixed-replace`); pasang di `<img src>` |
| `GET /status` | – | `{running, source, roi_mode, has_first_frame, stats, alerts, proc}` |
| `GET /debug` | – | seperti `/status` plus `roi_pending`, `ws_clients` |
| `WS /ws/alerts` | – | pesan JSON tiap ada perubahan: `{alerts, stats, proc}` |

Catatan endpoint:
- Format video yang diterima dicek di backend (`ALLOWED_VIDEO_EXTS` di `main.py`).
- Untuk `/upload/stream`, browser wajib mengirim `Content-Length`. Unggahan yang tidak lengkap dibuang.
- Selama unggahan dari komputer yang sama berjalan, deteksi dijeda (`proc.state = "paused"`).
- Zona di `/set_roi` diberi nomor 1, 2, … sesuai urutan dalam array.

### 3.3 Bentuk data

```jsonc
// alerts[] — hanya kendaraan yang sedang terlihat di dalam zona
{ "id": 3, "lid": "LID-03", "type": "car",        // motorcycle | car | bus | truck
  "color": "Putih",                                // atau "Unknown"
  "zone": 1, "duration": 75,                       // detik
  "status": "warning",                             // monitoring | warning | violation | safe
  "triangle": false }                              // segitiga pengaman terdeteksi

// stats
{ "total": 4, "warning": 1, "violation": 1, "safe": 0 }

// proc
{ "state": "running",  // loading_models | waiting_source | opening_source | waiting_roi
                       // | running | paused | error | stopped
  "tick": 120, "tick_ms": 1150.0, "error": null }
```

**Aturan status** (ditetapkan di backend, UI cukup menampilkan):

| Durasi | Segitiga pengaman tidak ada | Segitiga pengaman ada |
|---|---|---|
| < 60 detik | `monitoring` | `monitoring` |
| 60–299 detik | `warning` | `safe` |
| ≥ 300 detik | `violation` | `safe` |

### 3.4 Sidik video untuk `/upload/check`

SHA-256 dari isi file:
- seluruh file bila ukurannya ≤ 3 MiB;
- bila lebih besar: gabungan 1 MiB awal + 1 MiB tengah (mulai `size/2 − 512 KiB`) + 1 MiB akhir.

Implementasi JS yang sudah jalan ada di `SetupWizard.jsx` (baris 66–85). Format video yang diterima:
`.mp4 .avi .mov .mkv .webm`.

## 4. Struktur frontend saat ini

| File | Fungsi |
|---|---|
| `src\App.jsx` | layout utama, perpindahan tampilan setup ↔ monitor |
| `src\components\SetupWizard.jsx` | langkah sumber video → mode zona → gambar zona (upload, configure, set_roi) |
| `src\components\ZoneEditor.jsx`, `src\lib\roiDraw.js`, `src\lib\roiGeometry.js` | menggambar dan mengedit polygon zona (koordinat ternormalisasi) |
| `src\components\VideoMonitor.jsx` | stream MJPEG, overlay zona, ubah zona saat berjalan |
| `src\components\AlertSidebar.jsx` | daftar kendaraan dan statusnya |
| `src\components\RuleLane.jsx` | lajur waktu 0–6 menit dengan garis 60 s / 300 s; posisi garis juga di `index.css` |
| `src\components\Icon.jsx`, `Glyphs.jsx` | ikon SVG |
| `src\hooks\useAlerts.js` | koneksi WebSocket + reconnect |
| `src\hooks\useFirstFrame.js` | polling `/status` dan `/first_frame` |
| `src\index.css`, `tailwind.config.js` | tema, warna, animasi; kelas `.lite` = mode ringan |
| `src\main.jsx` | entry; `?lite` di URL menambah kelas `lite` pada `<html>` |

## 5. Batasan yang perlu dijaga saat remodel

- **Backend jangan diubah**:
  - model, imgsz, tracker, ambang deteksi, dan aturan 60/300 detik adalah bagian penelitian;
  - UI hanya mengonsumsi API di atas.
- **Mini PC lemah**: i5-2400S, RAM 8 GB, tanpa akselerasi GPU di browser. Deteksi dan browser berbagi CPU yang sama.
  - Mode `?lite` harus tetap ada: tanpa animasi terus-menerus, tanpa `backdrop-filter`/blur, tanpa video/canvas
    yang dirender ulang tiap frame.
  - `start_minipc.bat` membuka `http://localhost:4173/?lite`.
- **Offline**: font dibundel lewat `@fontsource` (tanpa CDN), karena mini PC bisa tanpa internet. Aset baru juga
  harus lokal.
- **Suara alert diputar oleh backend** (speaker mini PC, Edge-TTS), bukan oleh browser. UI tidak perlu memutar
  audio.
- Di mini PC, dashboard dijalankan dari hasil build:
  - `npm run build`, lalu `npm run preview` (port 4173);
  - `start_minipc.bat` hanya build ulang bila `parking-dashboard\dist\index.html` belum ada, jadi hapus `dist\`
    setelah mengganti UI.
