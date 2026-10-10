# Docker Setup — Illegal Parking Detection System

Containerized deployment untuk sistem deteksi parkir liar.
Semua konfigurasi Docker ada di folder ini; satu-satunya file di root yang ikut berperan adalah `.dockerignore`, karena build context-nya adalah root project.

---

## Struktur Folder

```
docker/
├── backend/
│   └── Dockerfile          # FastAPI + YOLO (Ultralytics) + OpenCV + Edge-TTS, PyTorch CPU-only
├── frontend/
│   ├── Dockerfile          # React build (npm ci) → nginx serve
│   └── nginx.conf          # SPA routing + gzip + caching
├── docker-compose.yml      # Orkestrasi 2 service
├── .env.example            # Template environment variable
└── README.md               # File ini
```

---

## Prerequisites

- **Docker Desktop** (Windows/Mac) atau Docker Engine + Compose plugin (Linux)
- Model weights `best.pt` dan `triangle.pt` **di folder root project**. Keduanya tidak ikut `git clone` (di-gitignore), jadi harus disalin manual. Kalau belum ada, `docker compose up` langsung berhenti dengan error path tidak ditemukan (`bind source path does not exist`) — bukan lagi diam-diam membuat folder kosong bernama `best.pt`.
- Video uji tidak perlu disiapkan di sini: video dikirim dari dashboard lewat upload dan disimpan di `uploads/`.

Cek instalasi:
```bash
docker --version
docker compose version
```

---

## Quick Start

```bash
# 1. Dari folder docker/
cd docker

# 2. (Opsional) Buat file .env dari template
cp .env.example .env          # Windows cmd: copy .env.example .env

# 3. Build & jalankan
docker compose up --build

# 4. Akses
#    Dashboard : http://localhost:5173
#    API       : http://localhost:8000
#    API docs  : http://localhost:8000/docs
```

**Build pertama** butuh beberapa menit karena mengunduh PyTorch (build CPU), Ultralytics, dan node_modules.
**Build berikutnya** jauh lebih cepat karena layer ter-cache. PyTorch dipasang di layer tersendiri, jadi mengubah `requirements.txt` tidak mengunduh ulang PyTorch.

---

## Penggunaan

### Mode detached (background)
```bash
docker compose up -d --build
docker compose logs -f backend     # tail log backend
docker compose logs -f frontend    # tail log frontend
```

### Stop
```bash
docker compose down
```

### Stop + hapus volume & image
```bash
docker compose down -v --rmi local
```

### Rebuild satu service
```bash
docker compose build backend
docker compose up -d backend
```

---

## Konfigurasi (`.env`)

Arti dan default setiap variabel ada di satu tabel: [`backend/README.md` → Environment Variables](../backend/README.md#environment-variables). `docker-compose.yml` meneruskan semuanya ke container dengan default yang sama, kecuali hal-hal khusus Docker berikut:

- **`ENABLE_TTS`** default-nya `false` (native: `true`) — lihat [TTS di dalam Container](#tts-di-dalam-container).
- **`PARKING_CORS_ORIGINS`** default-nya hanya origin service frontend: `http://localhost:5173,http://127.0.0.1:5173`.
- **`PARKING_VEHICLE_MODEL` / `PARKING_TRIANGLE_MODEL`** harus berupa path **relatif terhadap root project** (tanpa `/` di depan). Compose memakai nilai yang sama untuk me-mount file/folder itu secara read-only ke `/app/...`, jadi mengganti model cukup lewat `.env`. Image hanya berisi runtime untuk model `.pt`: model hasil export (mis. `best.onnx`) butuh paket yang tidak ada di image (`onnxruntime`, `onnx`), dan karena `YOLO_OFFLINE=True` Ultralytics tidak memasangnya sendiri saat runtime.
- **`PARKING_TRACKER`**: default-nya `botsort.yaml` (BoT-SORT bawaan Ultralytics, sama dengan default backend); `bytetrack.yaml` juga langsung bisa dipakai. `botsort_static.yaml` (file bawaan image `backend/botsort_static.yaml`, BoT-SORT tanpa GMC) bersifat **opt-in**: sedikit lebih ringan, tetapi bisa mengubah logical id / durasi sebagian kendaraan. File YAML buatan sendiri harus ada di dalam container — tambahkan mount-nya di `docker-compose.yml`.
- **`VITE_API_BASE`** adalah build-arg frontend (di-bake ke bundle). Kosong = dashboard memanggil `http://<hostname halaman dashboard>:8000`. Setelah mengubahnya: `docker compose build frontend`.

Mengubah variabel backend tidak perlu build ulang: edit `.env`, lalu `docker compose up -d` (container dibuat ulang dengan nilai baru).

### Akses dari perangkat lain di jaringan

1. Di `.env`, tambahkan origin dashboard yang akan dibuka:
   `PARKING_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://<IP-host>:5173`
2. `docker compose up -d`
3. Buka `http://<IP-host>:5173`. Dashboard otomatis memanggil backend di `http://<IP-host>:8000`, jadi firewall host harus mengizinkan port 5173 **dan** 8000.

---

## Volume Mount

| Host path                                   | Container path          | Mode | Fungsi                               |
| ------------------------------------------- | ----------------------- | ---- | ------------------------------------ |
| `../best.pt` (`PARKING_VEHICLE_MODEL`)      | `/app/best.pt`          | ro   | Model deteksi kendaraan              |
| `../triangle.pt` (`PARKING_TRIANGLE_MODEL`) | `/app/triangle.pt`      | ro   | Model deteksi segitiga pengaman      |
| `../uploads`                                | `/app/uploads`          | rw   | Video hasil upload dari dashboard    |
| `../outputs`                                | `/app/outputs`          | rw   | Cache audio TTS (satu MP3 per kalimat, dipakai lagi setelah restart) |

Model di-mount (bukan di-copy ke image) supaya image tetap ringan dan model bisa diganti tanpa build ulang. Mount model memakai `create_host_path: false`: kalau file belum ada, compose berhenti dengan error yang jelas.

Mount `input4.mp4` yang dulu ada sudah dihapus — video uji selalu dikirim lewat upload dashboard (`POST /upload` → `uploads/`), sehingga file itu tidak pernah terpakai.

---

## GPU Support (opsional)

Image default **CPU-only**: PyTorch dipasang dari index CPU supaya tidak ikut mengunduh wheel CUDA berukuran beberapa GB. Kalau host punya NVIDIA GPU + [nvidia-container-toolkit](https://github.com/NVIDIA/nvidia-container-toolkit):

1. Edit `docker-compose.yml` → uncomment blok `deploy.resources.reservations.devices`
2. Edit `backend/Dockerfile` → di layer "PyTorch CPU-only", ganti index `https://download.pytorch.org/whl/cpu` dengan index CUDA yang sesuai driver host (mis. `https://download.pytorch.org/whl/cu121`).
   Alternatif: ganti base image ke image yang sudah berisi PyTorch + CUDA (mis. `pytorch/pytorch:2.1.2-cuda12.1-cudnn8-runtime`) dan hapus layer PyTorch tersebut.
3. Rebuild: `docker compose build backend`

---

## TTS di dalam Container

Container tidak punya hardware audio, jadi default-nya `SDL_AUDIODRIVER=dummy` dan **`ENABLE_TTS=false`**. Dengan driver dummy, TTS yang aktif hanya membuang kerja: MP3 tetap diminta ke Edge-TTS lewat internet lalu "diputar" tanpa ada suara yang keluar.

**Mengaktifkan audio sungguhan:** teruskan perangkat audio host ke container, lalu set driver dan `ENABLE_TTS=true` di `.env`.

| Host OS    | Cara                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| Linux      | Mount `/run/user/1000/pulse` ke container + `SDL_AUDIODRIVER=pulse` + `ENABLE_TTS=true`      |
| Windows    | TTS realistis hanya di mode non-Docker (jalankan backend manual, lihat `SETUP.md`)           |
| Mac        | Sama seperti Windows                                                                         |

---

## Mode Kamera di Docker

Compose default tidak meneruskan perangkat kamera ke container, jadi pilihan "Kamera Langsung" di wizard tidak akan menemukan kamera apa pun.

- **Docker Desktop (Windows/Mac):** webcam USB tidak bisa diteruskan ke container. Untuk mode kamera, jalankan aplikasi secara native (lihat [`SETUP.md`](../SETUP.md)).
- **Host Linux:** uncomment blok `devices:` di `docker-compose.yml` (`/dev/video0:/dev/video0`). Indeks kamera di wizard mengikuti nomor `/dev/videoN` yang dipetakan; banyak webcam membuat dua node (mis. `video0` = gambar, `video1` = metadata).

---

## Troubleshooting

| Masalah                                         | Solusi                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `bind source path does not exist` saat `up`     | `best.pt` / `triangle.pt` belum ada di root project (satu level di atas `docker/`), atau `PARKING_*_MODEL` di `.env` menunjuk path yang salah |
| Port 8000/5173 sudah dipakai                    | Ubah mapping di `docker-compose.yml`. Kalau port **backend** diganti (mis. `"8001:8000"`), set `VITE_API_BASE=http://localhost:8001` lalu `docker compose build frontend`. Kalau port **frontend** diganti (mis. `"8080:80"`), sesuaikan `PARKING_CORS_ORIGINS` (mis. `http://localhost:8080,http://127.0.0.1:8080`) |
| Frontend tidak bisa konek ke backend            | Cek `docker compose ps` (backend harus `healthy`). Kalau dashboard dibuka bukan dari `localhost:5173`, tambahkan origin-nya ke `PARKING_CORS_ORIGINS` |
| Deteksi tidak jalan padahal backend `healthy`   | Healthcheck hanya memeriksa API hidup. Buka `http://localhost:8000/status` → lihat `proc.state` dan `proc.error`, lalu `docker compose logs backend` |
| `npm ci` gagal saat build frontend              | `package.json` dan `package-lock.json` tidak sinkron → jalankan `npm install` di `parking-dashboard/`, lalu build ulang |
| Build lambat / timeout                          | Gunakan mirror PyPI: tambah `--index-url` di `pip install -r` pada Dockerfile backend |
| `libGL.so.1` error                              | Base image sudah include `libgl1`; kalau masih error cek arsitektur (arm64 vs amd64) |
| Kontainer backend restart terus                 | `docker compose logs backend` — biasanya model tidak ditemukan atau OOM |

---

## Deployment ke Server

Untuk push ke registry & deploy di VPS:

```bash
# Tag & push
docker tag illegal-parking-backend:latest  registry.example.com/parking-backend:v2.0
docker tag illegal-parking-frontend:latest registry.example.com/parking-frontend:v2.0
docker push registry.example.com/parking-backend:v2.0
docker push registry.example.com/parking-frontend:v2.0

# Di server:
docker compose pull
docker compose up -d
```

---

## Catatan Arsitektur

- **Network**: kedua service di network `parking-net` (bridge driver). Dashboard
  memanggil backend langsung dari browser ke `http://<hostname halaman>:8000`
  (bukan `backend:8000`, dan nginx tidak mem-proxy API) karena yang membuka
  koneksi stream/WebSocket adalah browser user, bukan container frontend.
- **Dependency**: semua paket Python — termasuk `lap` untuk tracker — dipasang
  saat build. Image menyetel `YOLO_OFFLINE=True`, jadi Ultralytics tidak
  memasang atau mengunduh apa pun saat runtime.
- **Healthcheck**: backend expose `/` untuk liveness (40s start period supaya
  YOLO sempat load). Status deteksi yang sebenarnya ada di `GET /status`
  (objek `proc`).
- **Restart policy**: `unless-stopped` → auto-restart kalau crash, tapi hormati
  `docker compose down` manual.
- **Log**: kedua service memakai driver `json-file` dengan rotasi (`max-size`
  10 MB, `max-file` 3), jadi log container paling banyak sekitar 30 MB per
  service dan tidak tumbuh tanpa batas. `docker compose logs` tetap bekerja
  seperti biasa; angkanya bisa diubah di blok `x-logging` pada
  `docker-compose.yml`. Container yang sudah ada baru memakai pengaturan ini
  setelah dibuat ulang (`docker compose up -d` melakukannya).
