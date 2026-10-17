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
│  1 Sumber video                                 │
│  ├─ File video (unggah, atau pakai video aktif)│
│  └─ Kamera (indeks 0–3)                         │
│              │                                   │
│  2 Zona larangan                                 │
│  ├─ Seluruh frame (roi_mode auto) → Dashboard   │
│  └─ Gambar zona (manual) → halaman editor zona │
│       klik / keyboard, kaca pembesar, Simpan    │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│                  DASHBOARD                       │
│  Header: rambu, status deteksi, Ganti sumber…,  │
│          jam; pelat "n pelanggaran" saat ada    │
│                                                 │
│  ┌────────────────────┐  ┌──────────────────┐   │
│  │   VideoMonitor     │  │  AlertSidebar    │   │
│  │   Sumber / Zona    │  │  Kendaraan       │   │
│  │   [Ubah zona…]     │  │  berhenti di zona│   │
│  │   MJPEG + legenda  │  │  (lajur waktu)   │   │
│  └────────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Komponen Detail

### `App.jsx` — Root Component

Mengelola state `view` (`'setup'` | `'dashboard'`):
- Render `SetupWizard` saat pertama kali dibuka
- Setelah setup selesai, switch ke `Dashboard`
- Tombol "Ganti sumber…" di header mengembalikan ke wizard (Dashboard di-unmount → WebSocket dan MJPEG ditutup)

Isi header (`Dashboard`): rambu Dilarang Parkir (abu-abu saat normal, **menyala** saat ada pelanggaran) + pelat merah "n pelanggaran", status deteksi dari `proc.state` (dengan hitungan detik saat menunggu), "Ganti sumber…", dan jam. Status putus koneksi / processor berhenti tampil sebagai pelat abu-abu.

### `SetupWizard.jsx` — Wizard Konfigurasi

| Langkah | Isi | API Call |
|---|---|---|
| 1 Sumber video | File video (unggah dengan progres + Batalkan, atau "Pakai video yang sedang aktif"), atau Kamera. Sebelum mengunggah, sidik video (SHA-256 tiga potongan 1 MiB) dicocokkan ke server: video yang sudah ada di `uploads/` langsung dipakai tanpa unggah ulang, dan langkah 2 menyebutkannya | `GET /status`, `GET /upload/check`, `PUT /upload/stream` (XHR, body = isi file) |
| 2 Zona larangan | "Seluruh frame" (`roi_mode: auto`) atau "Gambar zona" (`manual`) + legenda "Aturan waktu" | `POST /configure` |
| Halaman gambar zona | `ZoneEditor` + panel samping (daftar zona, Selesaikan, Urungkan, Hapus semua dengan urungkan) | `GET /first_frame` + `POST /set_roi` |

### `ZoneEditor.jsx` — Editor Zona (dipakai wizard dan dialog "Ubah zona")

- Klik dikunci ke **piksel video** di bawah kursor dan disimpan sebagai pusat piksel, sehingga `int(x·W)` di backend menghasilkan piksel yang sama (terukur ≤ 0,35 px di stream backend)
- Kaca pembesar 7× + pembacaan "X … Y …" dalam piksel video
- Keyboard: panah 1 piksel, Shift+panah 10 piksel, Enter menambah titik, Backspace mengurungkan, Ctrl+Enter menyelesaikan zona
- Zona digambar cyan `#00FFFF`, sama dengan garis zona yang ditulis backend di video

### `VideoMonitor.jsx` — Live Video Feed

- Toolbar Sumber / Zona + tombol "Ubah zona…" (membuka `<dialog>` native berisi `ZoneEditor`; stream MJPEG dijeda selama dialog terbuka)
- MJPEG stream dari `GET /video_feed` via tag `<img>` yang selalu ter-mount
- Legenda di bawah video: arti tiap warna kotak yang ditulis backend (Zona, Memantau, Peringatan, Aman, Pelanggaran, Di luar zona) + label tick ("1,1 dtk/tick")

### `AlertSidebar.jsx` — Kendaraan berhenti di zona

- Satu baris per kendaraan: glyph status (bentuk rambu), status, `LID{n}` (sama dengan label di video), jenis + warna dalam bahasa Indonesia, **lajur waktu** 0–6 menit dengan garis 1 mnt / 5 mnt (ambang backend 60 / 300 detik), durasi `m:ss`
- Kalimat ringkasan menyebut hanya jumlah yang bukan nol; baris pelanggaran diberi latar merah sekali (animasi 200 ms satu kali)
- Saat koneksi putus: baris jadi netral + "Data terakhir hh.mm.ss"
- Pengumuman `aria-live` untuk kendaraan yang baru masuk Peringatan / Pelanggaran

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

Desain "Rambu Menyala" (Okt 2026), disusun dari skill apple-design (Apple HIG: kontras, tipografi, layout, aksesibilitas) dan riset pendapat desainer tentang ciri UI "buatan AI". Spesifikasi lengkapnya ada di riwayat pengerjaan; ringkasnya:

- **Warna hanya untuk arti.** Permukaan abu-abu netral; warna status sama 1:1 dengan kotak yang ditulis backend di video (kuning = Peringatan, merah = Pelanggaran, hijau = Aman, biru = Memantau, cyan = Zona). Merah hanya berarti pelanggaran. Tidak ada warna merek, gradien, ungu, atau glow.
- **Satu elemen khas:** rambu Dilarang Parkir (PM 13/2014) yang menyala hanya saat aturan 300 detik dilanggar.
- **Tema terang dan gelap** lewat `prefers-color-scheme` (mengikuti mode aplikasi Windows, tanpa tombol di aplikasi), plus `prefers-contrast: more` dan Windows High Contrast. Token di `:root` pada `index.css`; kontras semua pasangan teks ≥ 4,69:1.
- **Font offline:** Overpass (`@fontsource-variable/overpass`, garis keturunan huruf rambu jalan) hanya untuk teks bergaya rambu dan angka; teks lain memakai Segoe UI bawaan Windows. Angka memakai `tabular-nums`.
- **Tanpa GPU:** tidak ada animasi berulang, blur, filter, gradien, bayangan, atau transisi. Hanya dua animasi sekali jalan (`tintIn` 200 ms pada baris pelanggaran, `dlgIn` 150 ms pada dialog); keduanya 0 di `?lite` dan `prefers-reduced-motion`. Utilitas Tailwind untuk efek mahal dimatikan di `tailwind.config.js` (`corePlugins`).

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
| `API_BASE` | `VITE_API_BASE`; kalau kosong: `http://<hostname halaman>:8000` | REST (`/upload/check`, `/upload/stream`, `/configure`, `/first_frame`, `/set_roi`) |
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
