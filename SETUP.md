# Setup Guide — Illegal Parking Detection System

Panduan instalasi lengkap untuk semua mode operasi.

---

## Prerequisites

- Python 3.11 → [python.org](https://python.org) *(versi yang dipakai venv development dan image Docker)*
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
# Windows dengan beberapa versi Python terpasang: py -3.11 -m venv venv

# Aktifkan
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

Catatan:

- `lap` (dipakai tracker BoT-SORT/ByteTrack) sekarang dependency biasa di `requirements.txt`. Sebelumnya Ultralytics memasangnya sendiri saat deteksi pertama berjalan — itu butuh internet dan gagal diam-diam kalau mesin offline. Kalau environment sudah dibuat sebelum perubahan ini, jalankan ulang `pip install -r requirements.txt`.
- **Windows**: PyTorch dari PyPI sudah build CPU-only, tidak perlu langkah tambahan.
- **Linux tanpa GPU**: PyTorch dari PyPI adalah build CUDA (unduhan beberapa GB). Pasang build CPU lebih dulu, baru jalankan `pip install -r requirements.txt`:
  ```bash
  pip install "torch>=2.0.0,<3" torchvision --index-url https://download.pytorch.org/whl/cpu
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
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Backend akan berjalan di `http://localhost:8000`  
Swagger API docs: `http://localhost:8000/docs`  
Status processor (sedang memuat model / menunggu sumber / berjalan / error): `http://localhost:8000/status` → field `proc`

Perintah di atas sengaja **tanpa** `--reload` — itu yang dipakai untuk pemakaian biasa, demo, dan mini PC. Hanya saat mengembangkan kode backend, pakai hot-reload yang dibatasi ke folder `backend/`:

```bash
# Development saja — dari root folder project
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload --reload-dir backend
```

Tanpa `--reload-dir backend`, uvicorn memantau seluruh folder project (termasuk `environments/` dan `demo*.py`), sehingga backend restart dan state tracking hilang setiap ada file `.py` yang berubah.

#### Konfigurasi lewat environment variable

Model, ukuran input (`PARKING_VEHICLE_IMGSZ`, default 960), langkah tick video (`PARKING_TICK_STEP`), tracker, CORS, dan TTS diatur lewat environment variable. Tabel lengkap (default + arti) ada di [`backend/README.md`](backend/README.md#environment-variables). Contoh mematikan TTS di Windows:

```bat
:: Command Prompt (cmd)
set ENABLE_TTS=false
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

```powershell
# PowerShell
$env:ENABLE_TTS = "false"
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Variabel hanya berlaku di jendela terminal tempat ia diset. Catatan soal `YOLO_OFFLINE` untuk instalasi native juga ada di [`backend/README.md`](backend/README.md#catatan-yolo_offline-instalasi-native).

Kalau mesinnya lambat (mis. mini PC dengan CPU lama), lihat [bagian 7 — Menjalankan di PC Lambat](#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2): di sana ada urutan langkah dan variabel mana yang aman diubah.

### Frontend

```bash
cd parking-dashboard
npm install
npm run dev
```

Dashboard akan berjalan di `http://localhost:5173`

Dashboard otomatis memanggil backend di `http://<hostname halaman>:8000`. Kalau backend ada di alamat/port lain, atau dashboard dibuka dari perangkat lain, lihat bagian "Koneksi ke Backend" di [`parking-dashboard/README.md`](parking-dashboard/README.md).

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

## 7. Menjalankan di PC Lambat (CPU lama tanpa AVX2)

Bagian ini untuk mesin seperti mini PC Intel Core i5-2400: 4 core, punya AVX tetapi tidak punya AVX2, RAM 8 GB, tanpa GPU. Di mesin sekelas itu satu tick deteksi bisa memakan waktu lebih dari satu detik, sehingga video di dashboard berjalan lebih lambat dari aslinya.

**Tentang angka di bagian ini**

- Belum ada yang diukur di CPU tanpa AVX2 yang sesungguhnya. Semua angka kecepatan di bawah berasal dari laptop development — sebagian dalam emulasi mini PC (4 core, set instruksi dibatasi sampai AVX) — jadi hanya menunjukkan orde besarannya.
- **Perkiraan kasar** (bukan hasil ukur) untuk Core i5-2400 dengan konfigurasi default (`best.pt`, `imgsz` 960): sekitar 2–3 detik per tick, atau lebih.
- Angka yang sebenarnya hanya bisa didapat dengan menjalankan `tools\benchmark_inference.py` di mesin itu sendiri (langkah 2).

### Ringkasan pilihan

| Pilihan | Mengubah hasil deteksi? | Catatan |
|---|---|---|
| `PARKING_TICK_STEP` lebih besar (khusus file video) | Per frame tidak; id / durasi bisa | Deteksi per frame sama, tetapi tracker dan logika parkir melihat frame yang berjarak lebih jauh, jadi logical id / durasi sebagian kendaraan bisa berbeda dari hasil nilai 1. Tick tidak jadi lebih singkat; tiap tick mencakup lebih banyak detik video, jadi ketelitian waktu lebih kasar |
| Model ONNX lewat ONNX Runtime (`PARKING_VEHICLE_MODEL=best.onnx`) | Tidak | Deteksi identik dengan `best.pt` pada `imgsz` yang sama (100 dari 100 frame uji). Kemungkinan lebih cepat, tetapi belum terbukti bisa jalan di CPU tanpa AVX2 |
| `ENABLE_TTS=false` | Tidak | Kalau tidak ada speaker atau internet |
| Frontend hasil build (`npm run preview`) | Tidak | Menggantikan dev server Vite |
| `PARKING_TRACKER=botsort_static.yaml` | Ya, sebagian | Opt-in. Hematnya kecil; logical id / durasi sebagian kendaraan bisa berubah |
| `PARKING_VEHICLE_IMGSZ=736` atau `640` | **Ya, banyak** | Pilihan terakhir |
| Melatih ulang model yang lebih kecil | Ya (model lain) | Jangka panjang; akurasinya baru diketahui setelah dilatih dan divalidasi |

OpenVINO tidak ada di tabel karena **jangan dipakai** di CPU tanpa AVX2 (alasannya di langkah 5).

### Langkah 1 — Salin file ke mini PC

1. Salin folder project (atau `git clone`), lalu siapkan environment seperti [bagian 2](#2-python-environment). `pip install` butuh internet satu kali.
2. Salin manual (mis. lewat flashdisk) ke folder root project: `best.pt`, `triangle.pt`, dan satu video uji (mis. `input4.mp4`). File model dan video **tidak ikut git**.

```bat
:: Command Prompt (cmd) — sesuaikan path dengan lokasi folder project
cd /d C:\illegal-parking-detection
:: baris berikut sekali saja, kalau folder venv belum ada
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

`lap` sekarang dependency biasa di `requirements.txt`, jadi tick pertama tidak lagi memicu `pip install` saat runtime (yang gagal diam-diam kalau mesin offline).

### Langkah 2 — Jalankan benchmark

Jalankan dari root project, di environment aplikasi, saat backend tidak sedang berjalan:

```bat
python tools\benchmark_inference.py --sizes 960
```

Skrip ini mengukur pekerjaan yang sama dengan satu tick backend (ambil frame dari video, `.track()` dengan tracker default, encode JPEG), lalu mencetak tabel berisi **median ms** per konfigurasi dan **detik/tick**, serta menyimpan hasil lengkapnya ke `benchmark_inference_<waktu>.json` di folder kerja. Skrip tidak meng-install apa pun. Yang tidak ikut diukur: model segitiga, TTS, dan pekerjaan FastAPI/browser.

| Opsi | Default | Arti |
|---|---|---|
| `--video` | `input4.mp4` | File video uji. Video hasil upload dashboard ada di folder `uploads` |
| `--model` | `best.pt` | Model yang diuji; boleh diulang untuk membandingkan (`--model best.pt --model best.onnx`) |
| `--sizes` | `960 736 640 512 416` | Daftar `imgsz` yang diuji. `--sizes 960` = hanya ukuran default backend |
| `--frames` | `12` | Jumlah frame yang diukur per konfigurasi |
| `--tracker` | `botsort.yaml` | Tracker yang dipakai, sama dengan default backend. Boleh `backend\botsort_static.yaml` atau `none` (tanpa tracker) |
| `--threads` | *(default)* | Paksa jumlah thread — hanya untuk pembanding; backend sendiri tidak punya pengaturan ini |
| `--start` | `5` | Detik video pertama yang dipakai |
| `--out` | `benchmark_inference_<waktu>.json` | Nama file JSON hasil |

### Langkah 3 — Tentukan `PARKING_TICK_STEP` (file video)

Ambil angka **detik/tick** untuk `best.pt` pada `imgsz` 960, lalu **bulatkan ke atas**:

| detik/tick di benchmark | `PARKING_TICK_STEP` |
|---|---|
| `1.00` atau kurang | `1` (default, tidak perlu diubah) |
| `1.40` | `2` |
| `2.30` | `3` |

Kalau angkanya mepet ke batas (mis. `1.90`), tambah satu (jadi `3`, bukan `2`) — browser memakai core CPU yang sama dengan backend.

Dengan nilai itu video kembali mengikuti waktu sebenarnya. Yang perlu dipahami: tick **tidak** menjadi lebih singkat. Tiap tick hanya mencakup lebih banyak detik video, sehingga ketelitian waktunya lebih kasar (dengan nilai 3, durasi parkir bertambah tiga detik sekali). Tracker dan logika parkir juga melihat frame yang berjarak lebih jauh, jadi logical id / durasi sebagian kendaraan bisa berbeda dari hasil dengan nilai 1.

```bat
:: Command Prompt (cmd)
set PARKING_TICK_STEP=3
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

```powershell
# PowerShell
$env:PARKING_TICK_STEP = "3"
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

> Di cmd, `set NAMA=nilai` ditulis **tanpa spasi** di sekitar `=`, satu `set` per baris, di jendela yang sama sebelum `uvicorn` dijalankan.

Untuk memeriksa hasilnya, buka `http://localhost:8000/status`: `proc.tick_ms` adalah lama tick terakhir dalam milidetik. Video mengikuti waktu sebenarnya selama angka itu di bawah `PARKING_TICK_STEP` × 1000.

**Mode kamera:** `PARKING_TICK_STEP` tidak berpengaruh. Satu tick = satu frame yang diproses dan dihitung sebagai satu detik logika. Jadi kalau satu tick memakan 1,5 detik, ambang "60 detik" baru tercapai setelah kira-kira 90 detik nyata.

### Langkah 4 — (Opsional) Uji ONNX Runtime

Model kendaraan yang sama bisa dijalankan lewat ONNX Runtime. Yang di-export hanya `best.pt`; `triangle.pt` tetap.

**Di laptop development** (di environment project):

```bat
pip install onnx==1.18.0
python -c "from ultralytics import YOLO; YOLO('best.pt').export(format='onnx', dynamic=True, imgsz=960, simplify=False)"
```

Hasilnya `best.onnx` (sekitar 80 MB) di sebelah `best.pt`. Salin manual ke folder root project di mini PC (file `.onnx` juga tidak ikut git).

**Di mini PC**, bandingkan keduanya:

```bat
pip install onnxruntime onnx==1.18.0
python tools\benchmark_inference.py --model best.pt --model best.onnx --sizes 960
```

Pakai `best.onnx` **hanya kalau** modelnya berhasil dimuat dan angkanya memang lebih cepat:

```bat
set PARKING_VEHICLE_MODEL=best.onnx
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Hitung ulang `PARKING_TICK_STEP` (langkah 3) dari baris `best.onnx`.

Yang sudah dan belum diketahui:

- Hasil deteksinya identik dengan `best.pt` pada `imgsz` yang sama, di 100 dari 100 frame uji.
- Dalam emulasi, ONNX Runtime 1,6–2,6× lebih cepat daripada `best.pt`. **Tetapi** set instruksi ONNX Runtime tidak bisa dibatasi dalam emulasi itu, jadi kecepatannya di CPU tanpa AVX2 tidak diketahui, dan belum terbukti bisa jalan di sana.
- Kalau proses berhenti mendadak tanpa tabel hasil — "Illegal instruction", atau di cmd `echo %ERRORLEVEL%` menampilkan `-1073741795` (kode `0xC000001D`) — ONNX Runtime tidak cocok dengan CPU itu: tetap pakai `best.pt`. Skrip benchmark menyimpan JSON sebelum tiap model diuji, jadi hasil `best.pt` tidak hilang.
- Export harus dengan `dynamic=True`. Tanpa itu `PARKING_VEHICLE_IMGSZ` diabaikan untuk model hasil export (Ultralytics memakai ukuran saat export).

### Langkah 5 — Kalau masih terlalu lambat

Urut dari yang paling aman:

1. **Matikan TTS** kalau tidak ada speaker atau internet: `set ENABLE_TTS=false`. Edge-TTS butuh internet untuk setiap kalimat yang audionya belum tersimpan.
2. **Sajikan frontend hasil build**, bukan dev server Vite (`npm run dev`). Di jendela terminal kedua, dari root project:

   ```bat
   cd parking-dashboard
   npm install
   npm run build
   npm run preview
   ```

   Dashboard ada di `http://localhost:4173`. Port ini sudah termasuk default `PARKING_CORS_ORIGINS`, jadi tidak ada yang perlu diubah di backend.
3. **(Opt-in) `set PARKING_TRACKER=botsort_static.yaml`** — BoT-SORT tanpa GMC. Di laptop development hematnya kira-kira 20–70 ms per tick, tetapi logical id / durasi sebagian kendaraan bisa berubah (12 dari 60 tick berbeda pada video uji). Karena itu bukan default.
4. **Pilihan terakhir: `set PARKING_VEHICLE_IMGSZ=736` atau `640`.** Pada 640 kira-kira 2× lebih cepat, tetapi hasil deteksinya berubah banyak dibanding 960: kecocokan dengan keluaran 960 hanya recall sekitar 0,74 dan precision sekitar 0,5; 22–23 dari 30 kotak kecil (di bawah 48 px) hilang; label kelas berpindah. Model ini dilatih pada `imgsz` 1280, jadi peka terhadap pengecilan gambar. Semua angka akurasi di skripsi yang diukur pada 960 harus diukur ulang.
5. **Jangan pakai OpenVINO di CPU tanpa AVX2.** Di sana OpenVINO turun ke kernel SSE4.2; dalam emulasi yang dibatasi sampai AVX ia tidak lebih cepat daripada `best.pt` (pada 960 lebih lambat di 5 dari 6 putaran), dan CPU Core generasi ke-2 tidak ada di daftar CPU yang didukung OpenVINO. Di CPU Intel modern dengan AVX2, OpenVINO pilihan yang sah (tanpa pembatasan, ia lebih cepat daripada `best.pt` di laptop development).
6. **Jangka panjang: latih ulang model yang lebih kecil.** Dalam emulasi YOLO11s kira-kira 2,4–2,9× lebih cepat. Itu kecepatan arsitektur standarnya saja — akurasinya belum diketahui sampai modelnya dilatih dan divalidasi.

Contoh lengkap untuk mini PC (benchmark menunjukkan `2.30` detik/tick, tanpa speaker):

```bat
:: Command Prompt (cmd)
cd /d C:\illegal-parking-detection
venv\Scripts\activate
set PARKING_TICK_STEP=3
set ENABLE_TTS=false
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Arti dan default semua variabel ada di [`backend/README.md`](backend/README.md#environment-variables).

---

## 8. Troubleshooting

| Masalah | Solusi |
|---|---|
| `ModuleNotFoundError: edge_tts` | `pip install edge-tts` |
| `ModuleNotFoundError: No module named 'lap'` | Environment dibuat sebelum `lap` masuk `requirements.txt` → jalankan ulang `pip install -r requirements.txt` |
| `pygame.error: No such device` | TTS akan skip jika tidak ada audio device |
| Stream MJPEG lambat | Gambar di stream berganti sekali per tick. Untuk file video 1 tick = `PARKING_TICK_STEP` detik video (default 1), jadi sekitar satu gambar per detik itu normal. Kalau lebih lambat dari itu, satu tick memakan waktu lebih lama dari jatahnya: cek `proc.tick_ms` di `http://localhost:8000/status`, lalu ikuti [bagian 7](#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2) |
| `Processor berhenti: Sumber tidak bisa dibuka: ...` atau `Frame pertama tidak bisa dibaca: ...` (di log backend, banner dashboard, dan `proc.error`) | Cek path video dan pastikan file tidak corrupt; untuk kamera coba index lain. Sumber yang gagal tidak dicoba ulang sendiri — ulangi dari wizard (tombol **Ganti Setup**) |
| Camera tidak terdeteksi | Coba index 0, 1, 2 — cek device manager. Di Docker Desktop Windows/Mac kamera tidak bisa diteruskan ke container (lihat `docker/README.md`) |
| Deteksi tidak jalan | Buka `http://localhost:8000/status` dan lihat `proc.state` / `proc.error`, lalu cek log terminal backend. Kalau `proc.state` = `running` dan `proc.tick` terus bertambah, deteksi berjalan tetapi lambat → [bagian 7](#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2) |
| Port 8000 sudah dipakai | `uvicorn backend.main:app --port 8001`, lalu jalankan frontend dengan `VITE_API_BASE=http://localhost:8001` (lihat `parking-dashboard/README.md`) |
| Frontend tidak bisa konek | Pastikan origin dashboard (mis. `http://localhost:5173`) ada di `PARKING_CORS_ORIGINS` (lihat `backend/README.md`) dan backend sudah jalan di port 8000 |

---

## 9. Verifikasi Instalasi

```bash
python demo_quickstart.py --video input4.mp4 --no-tts
```

Jika semua `✓`, instalasi berhasil.
