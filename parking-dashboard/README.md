# Parking Dashboard — React Frontend

> **v1.0 Prototype** — UI dan fitur dapat berubah di versi mendatang.

Dashboard monitoring real-time untuk sistem deteksi parkir liar. Menampilkan live video feed dari backend, alert kendaraan yang terparkir di zona terlarang, dan statistik agregat — semuanya update secara real-time via MJPEG stream dan WebSocket.

---

## Tech Stack

| Teknologi | Versi | Fungsi |
|---|---|---|
| [React](https://react.dev/) | 18.3 | UI library |
| [Vite](https://vitejs.dev/) | 5.4 | Build tool & dev server |
| [Tailwind CSS](https://tailwindcss.com/) | 3.4 | Utility-first styling |
| [PostCSS](https://postcss.org/) + Autoprefixer | 8.4 | CSS processing |

> Tidak menggunakan state management library (Redux/Zustand) — state cukup sederhana untuk `useState` + custom hook.

---

## Struktur File

```
parking-dashboard/
├── index.html                 # Entry point HTML
├── package.json               # Dependencies & scripts
├── vite.config.js             # Vite configuration
├── postcss.config.js          # PostCSS + Tailwind
├── src/
│   ├── main.jsx               # React root render
│   ├── config.js              # Alamat backend: API_BASE, WS_URL, STREAM_URL
│   ├── index.css              # Design system, animasi, CSS variables
│   ├── App.jsx                # Root component — state machine (setup ↔ dashboard)
│   ├── components/
│   │   ├── SetupWizard.jsx    # Wizard konfigurasi 3 langkah
│   │   ├── VideoMonitor.jsx   # Live video feed + ROI editor
│   │   └── AlertSidebar.jsx   # Feed alert real-time
│   ├── hooks/
│   │   ├── useAlerts.js       # Custom hook WebSocket + auto-reconnect
│   │   └── useFirstFrame.js   # Custom hook: ambil frame pertama (GET /first_frame)
│   └── lib/
│       └── roiGeometry.js     # Geometri editor zona (klik → koordinat ternormalisasi)
```

---

## User Flow

Aplikasi memiliki 2 mode utama yang dikelola sebagai state machine sederhana di `App.jsx`:

```
┌─────────────────────────────────────────────────┐
│                 SETUP WIZARD                     │
│                                                 │
│  Step 0: Pilih Sumber Video                     │
│  ├─ Upload file video (MP4/AVI/MOV/MKV/WebM)   │
│  └─ Kamera langsung (webcam index 0–3)          │
│              │                                   │
│  Step 1: Pilih Mode Zona                         │
│  ├─ Manual → lanjut ke Step 2                   │
│  └─ Otomatis → langsung ke Dashboard            │
│              │                                   │
│  Step 2: Gambar Zona (hanya jika manual)         │
│  ├─ Klik titik-titik di frame → polygon         │
│  ├─ Bisa buat multiple zona                     │
│  └─ Simpan → ke Dashboard                       │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│                  DASHBOARD                       │
│                                                 │
│  ┌─────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Header  │  │ Metric   │  │ Tombol       │   │
│  │ + Clock │  │ Cards    │  │ Ganti Setup  │   │
│  └─────────┘  └──────────┘  └──────────────┘   │
│                                                 │
│  ┌────────────────────┐  ┌──────────────────┐   │
│  │   VideoMonitor     │  │  AlertSidebar    │   │
│  │   (MJPEG stream)   │  │  (WebSocket      │   │
│  │                    │  │   real-time)      │   │
│  │   [Update Zona]    │  │                  │   │
│  └────────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Komponen Detail

### `App.jsx` — Root Component

Mengelola state `view` (`'setup'` | `'dashboard'`):
- Render `SetupWizard` saat pertama kali dibuka
- Setelah setup selesai, switch ke `Dashboard`
- Tombol "Ganti Setup" di dashboard mengembalikan ke wizard

Sub-komponen di dalam App.jsx:
- **`LiveClock`** — Jam digital real-time (format Indonesia)
- **`MetricCard`** — Kartu statistik (total kendaraan, warning, violation)
- **`ConnectionBadge`** — Indikator status dengan tiga keadaan: **Live** (WebSocket tersambung dan processor berjalan), **Error** (tersambung, tetapi processor berhenti — penyebabnya muncul di tooltip), **Offline** (WebSocket putus)

### `SetupWizard.jsx` — Wizard Konfigurasi

Wizard 3 langkah dengan progress indicator:

| Step | Komponen | API Call |
|---|---|---|
| 0 — Pilih Sumber | `StepSource` | `POST /upload` (jika video file) |
| 1 — Mode Zona | `StepROIMode` | `POST /configure` |
| 2 — Gambar ROI | `StepDrawROI` | `GET /first_frame` + `POST /set_roi` |

**Fitur di Step 2:**
- Canvas overlay di atas frame pertama video
- Klik untuk menambah titik polygon
- Bisa buat multiple zona (masing-masing dengan warna berbeda)
- Undo per-titik dan undo per-zona
- Validasi minimal 3 titik per zona

### `VideoMonitor.jsx` — Live Video Feed

- Menampilkan MJPEG stream dari `GET /video_feed` via tag `<img>`
- Indikator status stream (Streaming/Standby)
- **ROI Update Panel**: overlay untuk menggambar ulang zona saat monitoring sudah berjalan, tanpa harus kembali ke wizard
- Corner brackets decorative (gaya CCTV/security)
- Offline placeholder dengan animasi pulse saat stream belum tersedia

### `AlertSidebar.jsx` — Feed Alert Real-time

Menampilkan daftar kendaraan yang terdeteksi di zona pantau:

- **Alert Card**: menampilkan tipe kendaraan, warna, zona, durasi, status
- **Status badge**: Pelanggaran (merah), Peringatan (kuning), Aman (hijau), Memantau (abu)
- **Progress bar**: visualisasi durasi relatif terhadap threshold 300 detik
- **Sorting**: violation di atas, lalu warning, monitoring, safe
- **Segment bar**: overview proporsi status di bagian atas
- **Animasi**: card masuk dengan slide-up, violation card berkedip

### `useAlerts.js` — Custom Hook WebSocket

Hook yang mengelola koneksi WebSocket ke backend:

```
Connect → onopen → mulai ping setiap 25 detik
                 → onmessage → parse JSON → update alerts, stats & proc
                 → onclose → auto-reconnect setiap 3 detik
                 → onerror → set error message
Unmount → close(1000) → tidak auto-reconnect
```

Return value: `{ alerts, stats, connected, error, proc }` — `proc` adalah status processor dari backend (`state`, `tick`, `tick_ms`, `error`; lihat [`backend/README.md`](../backend/README.md#status-processor-proc)), atau `null` kalau backend tidak mengirimnya / koneksi putus.

---

## Design System

Didefinisikan di `index.css` menggunakan CSS custom properties:

### Warna

| Token | Hex | Kegunaan |
|---|---|---|
| `--void` | `#08090f` | Background utama |
| `--cyan` | `#22d3ee` | Accent utama, elemen aktif |
| `--amber` | `#fbbf24` | Warning status |
| `--red` | `#f87171` | Violation status |
| `--green` | `#4ade80` | Safe status |
| `--purple` | `#a78bfa` | Badge/highlight sekunder |

### Animasi

| Class | Efek |
|---|---|
| `live-dot` | Pulse berkedip untuk indikator "Live" |
| `scanline-wrap` | Efek garis scan ala CCTV |
| `alert-enter` | Slide-up masuk untuk alert card |
| `violation-pulse` | Glow berkedip untuk kartu violation |
| `wizard-enter` | Fade + scale masuk untuk wizard step |

### Font Stack

- **DM Sans** — Body text
- **Share Tech Mono** — Monospace (label, counter)

Kedua font diambil dari Google Fonts di `index.html` **tanpa menahan render**: stylesheet-nya dimuat sebagai `media="print"` lalu diaktifkan saat selesai (`onload`), dengan `<noscript>` sebagai cadangan. Dashboard langsung tampil dengan font fallback (`sans-serif` / `monospace`) dan berganti ke font di atas begitu tersedia — jadi internet yang lambat atau putus tidak menunda tampilan.

---

## Cara Menjalankan

### Development

```bash
cd parking-dashboard
npm install
npm run dev
# Buka http://localhost:5173
```

> Backend harus sudah berjalan di port 8000 pada host yang sama (alamat lain: lihat [Koneksi ke Backend](#koneksi-ke-backend)).

### Production Build

```bash
npm run build
npm run preview     # Preview build result (http://localhost:4173)
```

> Origin `npm run preview` (port 4173) sudah termasuk default `PARKING_CORS_ORIGINS` di backend, jadi wizard tetap bisa memanggil API.
>
> Untuk pemakaian biasa di PC lambat, sajikan hasil build ini alih-alih `npm run dev` — lihat [`SETUP.md` → Menjalankan di PC Lambat](../SETUP.md#7-menjalankan-di-pc-lambat-cpu-lama-tanpa-avx2).

### Dengan Docker

```bash
cd docker
docker compose up --build frontend
# Akses http://localhost:5173
```

---

## Koneksi ke Backend

Alamat backend ditentukan di satu tempat, `src/config.js`. File lain tidak menulis alamat backend sendiri — semuanya mengimpor dari modul ini.

| Export | Nilai | Dipakai untuk |
|---|---|---|
| `API_BASE` | `VITE_API_BASE`; kalau kosong: `http://<hostname halaman>:8000` | REST (`/upload`, `/configure`, `/first_frame`, `/set_roi`) |
| `WS_URL` | `API_BASE` dengan `http` → `ws`, ditambah `/ws/alerts` | WebSocket alert |
| `STREAM_URL` | `API_BASE` + `/video_feed` | MJPEG stream |

Default-nya mengikuti hostname halaman dashboard:

- dibuka di mesin backend (`http://localhost:5173`) → backend `http://localhost:8000`;
- dibuka dari perangkat lain (mis. `http://192.168.1.20:5173`) → backend `http://192.168.1.20:8000`, tanpa build ulang.

### Mengganti alamat backend (`VITE_API_BASE`)

Hanya diperlukan kalau backend **tidak** berada di `<hostname yang sama>:8000` (port lain atau mesin lain). Variabel ini dibaca Vite saat `npm run dev` dan di-bake ke bundle saat `npm run build`.

Windows — Command Prompt (cmd):

```bat
set VITE_API_BASE=http://192.168.1.20:8000
npm run dev
```

Windows — PowerShell:

```powershell
$env:VITE_API_BASE = "http://192.168.1.20:8000"
npm run dev
```

Linux / macOS:

```bash
VITE_API_BASE=http://192.168.1.20:8000 npm run dev
```

Alternatif yang menetap: tulis `VITE_API_BASE=http://192.168.1.20:8000` di file `parking-dashboard/.env` (dibaca Vite, tidak ikut git). Untuk Docker, nilainya diisi lewat `docker/.env` sebagai build-arg (lihat [`docker/README.md`](../docker/README.md)).

### Membuka dashboard dari perangkat lain

1. Jalankan Vite dengan `--host` supaya bisa diakses dari jaringan: `npm run dev -- --host`
2. Tambahkan origin dashboard (mis. `http://192.168.1.20:5173`) ke `PARKING_CORS_ORIGINS` di backend — lihat tabel environment variable di [`backend/README.md`](../backend/README.md#environment-variables).
3. Backend harus dijalankan dengan `--host 0.0.0.0` (sudah demikian di perintah pada dokumentasi).
