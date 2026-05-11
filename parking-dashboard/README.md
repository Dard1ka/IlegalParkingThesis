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
│   ├── index.css              # Design system, animasi, CSS variables
│   ├── App.jsx                # Root component — state machine (setup ↔ dashboard)
│   ├── components/
│   │   ├── SetupWizard.jsx    # Wizard konfigurasi 3 langkah
│   │   ├── VideoMonitor.jsx   # Live video feed + ROI editor
│   │   └── AlertSidebar.jsx   # Feed alert real-time
│   └── hooks/
│       └── useAlerts.js       # Custom hook WebSocket + auto-reconnect
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
- **`ConnectionBadge`** — Indikator status koneksi WebSocket (Live/Offline)

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
                 → onmessage → parse JSON → update alerts & stats
                 → onclose → auto-reconnect setiap 3 detik
                 → onerror → set error message
Unmount → close(1000) → tidak auto-reconnect
```

Return value: `{ alerts, stats, connected, error }`

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
- **Rajdhani** — Heading (tersedia, belum digunakan intensif)

---

## Cara Menjalankan

### Development

```bash
cd parking-dashboard
npm install
npm run dev
# Buka http://localhost:5173
```

> Backend harus sudah berjalan di `http://localhost:8000`.

### Production Build

```bash
npm run build
npm run preview     # Preview build result
```

### Dengan Docker

```bash
cd docker
docker compose up --build frontend
# Akses http://localhost:5173
```

---

## Koneksi ke Backend

Semua URL backend di-hardcode ke `localhost:8000` (v1.0):

| File | Konstanta | URL |
|---|---|---|
| `VideoMonitor.jsx` | `STREAM_URL` | `http://localhost:8000/video_feed` |
| `VideoMonitor.jsx` | `API` | `http://localhost:8000` |
| `SetupWizard.jsx` | `API` | `http://localhost:8000` |
| `useAlerts.js` | `WS_URL` | `ws://localhost:8000/ws/alerts` |

> Di versi mendatang, ini akan di-extract ke environment variable via Vite (`import.meta.env`).
