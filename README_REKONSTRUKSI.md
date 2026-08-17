# Iterasi 2 — Raspberry Pi 4 Model B (REKONSTRUKSI)

**Ini bukan file asli dari Raspberry Pi.** File asli di kartu SD Pi (`~/Illegal_Parking`) tidak pernah
disalin balik ke laptop dan kartu SD-nya sudah tidak ada. Paket ini disusun ulang pada 10-11-2026 dari:

- `Thesis Raspberry Pi.zip` (kode yang disalin ke Pi, 16-08-2026), dan
- log sesi Claude Code di laptop `b3cbe55e-e13c-40a9-822e-e5b6a23f442d.jsonl` (16-18 Agustus 2026), yang
  memuat perintah dan potongan kode yang benar-benar ditempel dan dijalankan di Pi.

## Kondisi akhir yang direkonstruksi (17-08-2026, ±19.53 UTC)

| Perubahan di Pi | Lokasi di paket ini | Bukti di log |
|---|---|---|
| Video terbalik 180° → helper `_read_rot()` (cv2.rotate) menggantikan semua `cap.read()` | `backend/processor.py` (helper di bawah `from .shared import SharedState` + 6 pemanggilan) | L587 (patch pertama, rekursi), L600/L606 (patch ulang yang dijalankan), L613 (grep baris 33, 619, 656, 677, 1019, 1035, 1039) |
| Ukuran input YOLO diturunkan: `VEHICLE_IMGSZ` 960 → 320, `TRIANGLE_IMGSZ` 640 → 320 | `backend/processor.py` (blok CONFIG) | L626 (sed imgsz 320), L639 (imgsz tetap 320) |
| Percobaan model NCNN (`best_ncnn_model`, `triangle_ncnn_model`) → *segmentation fault* → kembali ke `.pt` | `catatan_pi/processor_langkah_ncnn320.py` (keadaan sementara) | L626 (sed ke NCNN), L635 "balikkan ke pt saja karena segmentation fault", L639 (sed kembali ke best.pt) |
| `import torch` gagal (`undefined symbol: sbgemm_`) → backend dijalankan dengan `LD_PRELOAD` OpenBLAS milik torch | `catatan_pi/run_backend_pi.sh` | L468-L506 ("oke backend nya kebuka") |
| apt macet (IPv6), pemulihan upgrade, paket sistem, venv, export NCNN, Node/npm | `catatan_pi/setup_pi_commands.sh` | L251-L532 |
| Cadangan sebelum patch (`cp processor.py processor.py.bak`) | `backend/processor.py.bak` (= kode iterasi 1) | L587/L606 |

Nomor L = baris (mulai 1) di file log JSONL di atas. Selain `backend/processor.py`,
`backend/processor.py.bak`, dan folder `catatan_pi/`, semua file sama persis dengan `Thesis Raspberry Pi.zip`.

## Yang TIDAK bisa dipulihkan

- Folder model hasil export NCNN (`best_ncnn_model/`, `triangle_ncnn_model/`).
- Path `.so` OpenBLAS persis yang dipakai `LD_PRELOAD` (perintah pencariannya ada, hasilnya tidak tercatat).
- `package.json`/lock frontend versi Pi (log menunjukkan Pi menjalankan Vite 8.2.1).
- Perubahan di Pi setelah 17-08-2026, dan **angka kecepatan nyata** (tidak pernah diukur/dicatat).
  Saran imgsz 416/256 di log (L639, L693) tidak tercatat dijalankan, jadi tidak dimasukkan.

## Perangkat dan cara menjalankan (di Pi)

Raspberry Pi 4 Model B 4 GB, Raspberry Pi OS Trixie (Debian 13, Python 3.13), proyek di `~/Illegal_Parking`,
venv `~/Illegal_Parking/parking`. Lihat `catatan_pi/setup_pi_commands.sh` lalu `catatan_pi/run_backend_pi.sh`.

**Jangan jalankan paket ini di laptop/mini PC x86 tanpa mengubah `ROTATE_180 = False`:** di x86, OpenCV sudah
menerapkan metadata orientasi video, sehingga rotasi tambahan justru membuat video terbalik.
