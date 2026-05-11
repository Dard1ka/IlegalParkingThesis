# Setup Guide — Illegal Parking Detection System

Panduan instalasi lengkap untuk semua mode operasi.

---

## Prerequisites

- Python 3.9+ → [python.org](https://python.org)
- Node.js 18+ → [nodejs.org](https://nodejs.org) *(hanya untuk dashboard)*
- Git → [git-scm.com](https://git-scm.com)

---

## 1. Clone Repository

```bash
git clone https://github.com/YOUR_USERNAME/illegal-parking-detection.git
cd illegal-parking-detection
```

---

## 2. Python Environment

```bash
# Buat virtual environment (sangat direkomendasikan)
python -m venv venv

# Aktifkan
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

---

## 3. Model Weights

Model tidak di-include dalam repo karena ukurannya. Ada dua cara mendapatkannya:

**Cara A — Download dari Releases:**
```
https://github.com/YOUR_USERNAME/illegal-parking-detection/releases
```
Letakkan `best.pt` dan `triangle.pt` di root folder project.

**Cara B — Train sendiri:**  
Gunakan notebook yang tersedia:
- `VehicleDetection.ipynb` — training vehicle detection model
- `WarningTriangleYOLOv8.ipynb` — training triangle detection model

---

## 4. Mode Standalone (tanpa dashboard)

```bash
# Quick start dengan environment check
python demo_quickstart.py --video input4.mp4

# Tanpa TTS (untuk testing)
python demo_quickstart.py --video input4.mp4 --no-tts

# Langsung jalankan (advanced)
python demo3_tts.py
```

**Cara penggunaan window:**
1. Window akan muncul dan menanyakan jumlah ROI yang ingin dibuat
2. Klik titik-titik di frame untuk membuat polygon zona larangan
3. Tekan `ENTER` untuk selesaikan satu polygon
4. Tekan `C` untuk clear titik yang salah
5. Tekan `ESC` untuk keluar dari proses

---

## 5. Mode Dashboard (full web app)

### Backend

```bash
# Dari root folder project
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Backend akan berjalan di `http://localhost:8000`  
Swagger API docs: `http://localhost:8000/docs`

### Frontend

```bash
cd parking-dashboard
npm install
npm run dev
```

Dashboard akan berjalan di `http://localhost:5173`

### Alur penggunaan dashboard:

1. Buka `http://localhost:5173`
2. **Step 1 — Sumber Video**: Upload file video atau pilih kamera (index 0, 1, ...)
3. **Step 2 — Zona Parkir**: Pilih "Gambar Sendiri" atau "Otomatis"
   - *Gambar Sendiri*: Klik titik-titik di frame → Selesaikan zona → Simpan
   - *Otomatis*: Langsung mulai, seluruh frame jadi zona pantau
4. Dashboard aktif dengan live stream + alert real-time

---

## 6. GPU Acceleration (opsional)

Untuk performa lebih baik, install PyTorch dengan CUDA support:

```bash
# CUDA 11.8
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118

# CUDA 12.1
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

Ultralytics akan otomatis menggunakan GPU jika tersedia.

---

## 7. Troubleshooting

| Masalah | Solusi |
|---|---|
| `ModuleNotFoundError: edge_tts` | `pip install edge-tts` |
| `pygame.error: No such device` | TTS akan skip jika tidak ada audio device |
| Stream MJPEG lambat | Normal, processor berjalan 1 FPS (1 detik per tick) |
| `GAGAL membuka video` | Cek path video, pastikan file tidak corrupt |
| Camera tidak terdeteksi | Coba index 0, 1, 2 — cek device manager |
| Port 8000 sudah dipakai | `uvicorn backend.main:app --port 8001` |
| Frontend tidak bisa konek | Pastikan CORS di `main.py` include port frontend |

---

## 8. Verifikasi Instalasi

```bash
python demo_quickstart.py --video input4.mp4 --no-tts
```

Jika semua `✓`, instalasi berhasil.
