# Docker Setup — Illegal Parking Detection System

Containerized deployment untuk sistem deteksi parkir liar.
Tidak memodifikasi file di root — semua konfigurasi Docker ada di folder ini.

---

## Struktur Folder

```
docker/
├── backend/
│   └── Dockerfile          # FastAPI + YOLOv8 + OpenCV + Edge-TTS
├── frontend/
│   ├── Dockerfile          # React build → nginx serve
│   └── nginx.conf          # SPA routing + gzip + caching
├── docker-compose.yml      # Orkestrasi 2 service
├── .env.example            # Template environment variable
└── README.md               # File ini
```

---

## Prerequisites

- **Docker Desktop** (Windows/Mac) atau Docker Engine + Compose plugin (Linux)
- Model weights `best.pt` dan `triangle.pt` **di folder root project**
- Video `input4.mp4` di root (opsional, bisa diganti via upload nanti)

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
cp .env.example .env

# 3. Build & jalankan
docker compose up --build

# 4. Akses
#    Dashboard : http://localhost:5173
#    API       : http://localhost:8000
#    API docs  : http://localhost:8000/docs
```

**Build pertama:** ~5–10 menit (install PyTorch + Ultralytics + node_modules).
**Build berikutnya:** <30 detik (layer cached).

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

## Volume Mount

| Host path                  | Container path          | Mode | Fungsi                               |
| -------------------------- | ----------------------- | ---- | ------------------------------------ |
| `../best.pt`               | `/app/best.pt`          | ro   | Model deteksi kendaraan              |
| `../triangle.pt`           | `/app/triangle.pt`      | ro   | Model deteksi segitiga pengaman      |
| `../input4.mp4`            | `/app/input4.mp4`       | ro   | Video testing                        |
| `../uploads`               | `/app/uploads`          | rw   | Video hasil upload dari dashboard    |
| `../outputs`               | `/app/outputs`          | rw   | File MP3 TTS sementara               |

Model & video di-mount (bukan di-copy ke image) supaya image tetap ringan
(~1.5 GB vs ~3 GB kalau semua di-embed).

---

## GPU Support (opsional)

Kalau host punya NVIDIA GPU + [nvidia-container-toolkit](https://github.com/NVIDIA/nvidia-container-toolkit):

1. Edit `docker-compose.yml` → uncomment blok `deploy.resources.reservations.devices`
2. Ganti base image di `backend/Dockerfile`:
   ```dockerfile
   FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04
   ```
   dan install Python 3.11 secara manual, atau gunakan image `pytorch/pytorch:2.1.2-cuda12.1-cudnn8-runtime` yang sudah siap pakai.
3. Rebuild: `docker compose build backend`

---

## TTS di dalam Container

Container tidak punya hardware audio, jadi default pakai `SDL_AUDIODRIVER=dummy`
— MP3 tetap di-generate oleh Edge-TTS tapi tidak ada suara keluar.

**Opsi TTS aktif:**

| Host OS    | Cara                                                                 |
| ---------- | -------------------------------------------------------------------- |
| Linux      | Mount `/run/user/1000/pulse` + set `SDL_AUDIODRIVER=pulse`           |
| Windows    | TTS realistis hanya di mode non-Docker (jalankan backend manual)     |
| Mac        | Sama seperti Windows                                                 |

**Matikan TTS sepenuhnya:** set `ENABLE_TTS=false` di `.env`.

---

## Troubleshooting

| Masalah                                         | Solusi                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `Cannot find /app/best.pt`                      | Pastikan `best.pt` ada di root project (satu level di atas `docker/`) |
| Port 8000/5173 sudah dipakai                    | Ubah mapping di `docker-compose.yml` → `"8001:8000"` dst        |
| Frontend tidak bisa konek ke backend            | Cek `backend` health: `docker compose ps` → status harus `healthy` |
| Build lambat / timeout                          | Gunakan mirror PyPI: tambah `--index-url` di `pip install` Dockerfile |
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

- **Network**: kedua service di network `parking-net` (bridge driver). Frontend
  pakai `localhost:8000` (bukan `backend:8000`) karena browser user yang
  konek ke WebSocket, bukan container frontend.
- **Healthcheck**: backend expose `/` untuk liveness (40s start period supaya
  YOLO sempat load).
- **Restart policy**: `unless-stopped` → auto-restart kalau crash, tapi hormati
  `docker compose down` manual.
