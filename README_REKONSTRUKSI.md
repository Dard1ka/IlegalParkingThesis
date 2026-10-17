# Iterasi 4 — Mini PC, perbaikan sebelum fine-tune (REKONSTRUKSI)

**Ini bukan salinan asli dari satu titik waktu.** Tidak ada arsip yang menyimpan keadaan iterasi 4 secara
terpisah: semua salinan yang sudah berisi perbaikan iterasi 4 juga sudah memakai model fine-tune
`best_ft1` (iterasi 5), dan semua salinan dengan model lama `best.pt` belum berisi perbaikan itu.
Paket ini disusun ulang pada 10-11-2026 dari `Thesis_sistem_lengkap_20261110.zip` (sistem akhir, iterasi 5)
dengan **mengembalikan model kendaraan ke `best.pt`**, sesuai keputusan pengguna.

## Isi iterasi 4 (dikerjakan di mini PC i5-2400S, 15-25 Oktober 2026)

Sumber: `HANDOVER_PENGEMBANGAN.md` dan `PERUBAHAN_IMPLEMENTASI_BAB4.md` (paket mini PC 1-11-2026).

| Aspek | Perbaikan | Waktu |
|---|---|---|
| Pengelolaan record kendaraan | Satu kendaraan dua ID (`dedupe_tracked_boxes`), kelas car/truck bergantian (`class_compatible` + label voting), kotak parkir loncat ke kendaraan lewat (`spills_outside`), record hantu (`hidden_ttl_seconds`) | 15 Okt |
| Klasifikasi warna | Algoritma HSV baru + voting 5 suara sejak kendaraan mulai parkir (`vote_vehicle_color`) | 15 Okt |
| Tampilan dashboard | Redesain "Rambu Menyala": tanpa animasi/blur (browser mini PC tanpa GPU), tema ikut Windows, mode `?lite` | 15 Okt |
| Unggah video | Cek sidik file (`/upload/check`) + unggah streaming (`/upload/stream`), tick ditunda saat mengunggah | 16 Okt |
| Peringatan suara | Satu kalimat untuk semua pelanggar yang terlihat | 25 Okt |

## Yang diubah dari sistem akhir (iterasi 5)

| File | Sistem akhir | Paket ini |
|---|---|---|
| `backend/processor.py` baris 102 | default `"best_ft1.pt"` | default `"best.pt"` (sama dengan kode iterasi 3) |
| `start_minipc.bat` baris 20-25 | `MODEL_PT=best_ft1.pt`, `MODEL_ONNX=best_ft1.onnx` | `MODEL_PT=best.pt`, `MODEL_ONNX=best.onnx` |
| `SETUP.md` baris 186 | menyebut `best_ft1.onnx` | menyebut `best.onnx` |
| Model | `best_ft1.pt`, `best_ft1.onnx` | `best.pt` (YOLO11m, 12-04-2026; md5 97384f70...) |
| `PANDUAN_REMODEL_UI.md` | ada (paket remodel UI 10-11-2026) | dihapus (bukan bagian iterasi) |

Semua file lain sama persis dengan `Thesis_sistem_lengkap_20261110.zip`.

## Catatan

- `best.onnx` tidak disertakan (sesuai keputusan pengguna). `start_minipc.bat` otomatis memakai `best.pt`
  bila `best.onnx` tidak ada; di mini PC ini lebih lambat (benchmark 14-10-2026: `.pt` ±1,93 dtk vs `.onnx`
  ±1,14 dtk per inferensi, deteksi identik). Untuk membuat `best.onnx`:
  `pip install onnxruntime onnx==1.18.0` lalu
  `python -c "from ultralytics import YOLO; YOLO('best.pt').export(format='onnx', dynamic=True, imgsz=960, simplify=False)"`.
- Karena perubahan TTS satu kalimat dibuat pada hari yang sama dengan penggantian model (25-10-2026), paket
  ini memuat TTS satu kalimat sebagai bagian "peringatan suara" iterasi 4.
- Dua masalah yang disebut di iterasi 3 (video unggahan tetap tersimpan di `uploads/`, model sudah dimuat saat
  backend start sebelum ada video) **masih ada** di paket ini, sama seperti di sistem akhir.
