@echo off
rem ================================================================
rem  start_minipc.bat - AI Illegal Parking Detection, satu klik
rem  Mini PC: Intel i5-2400S (tanpa AVX2), RAM 8 GB, tanpa GPU.
rem
rem  Membuka dua jendela:
rem    "Backend - Illegal Parking"   : FastAPI + deteksi  (port 8000)
rem    "Dashboard - Illegal Parking" : dashboard build    (port 4173)
rem  lalu membuka browser ke http://localhost:4173.
rem  Untuk berhenti: tutup kedua jendela itu.
rem ================================================================

rem Pindah ke folder file ini (root project); path model relatif dibaca dari sini
cd /d "%~dp0"

rem Aktifkan virtual environment Python
call environments\Thesis\Scripts\activate.bat

rem ---------------- Konfigurasi ----------------
rem Model kendaraan: hasil fine-tune (pickup tampak depan dan belakang). Model lama
rem tetap ada: untuk kembali, isi MODEL_PT=best.pt dan MODEL_ONNX=best.onnx.
rem PENTING: hanya dua baris ini yang menentukan model. Variabel ini MENIMPA
rem default di backend\processor.py.
set MODEL_PT=best_ft1.pt
set MODEL_ONNX=best_ft1.onnx
rem Versi ONNX Runtime dipakai bila onnxruntime terpasang dan file .onnx ada:
rem deteksinya identik dengan versi .pt dan jauh lebih cepat di CPU ini
rem (best.pt 1928 ms vs best.onnx 1145 ms per tick, benchmark 14-10-2026).
rem onnxruntime tidak ikut requirements.txt: pip install onnxruntime onnx==1.18.0
python -c "import onnxruntime" 2>nul
if errorlevel 1 (
    echo [PERINGATAN] onnxruntime belum terpasang - backend memakai %MODEL_PT% yang lebih lambat.
    set PARKING_VEHICLE_MODEL=%MODEL_PT%
) else if exist "%MODEL_ONNX%" (
    set PARKING_VEHICLE_MODEL=%MODEL_ONNX%
) else (
    echo [PERINGATAN] %MODEL_ONNX% tidak ada - backend memakai %MODEL_PT% yang lebih lambat.
    set PARKING_VEHICLE_MODEL=%MODEL_PT%
)
rem Path model yang salah tidak menghentikan backend (ia diam-diam memakai best.pt),
rem jadi dicek di sini.
if not exist "%PARKING_VEHICLE_MODEL%" (
    echo [ERROR] File model %PARKING_VEHICLE_MODEL% tidak ada di %CD%. Salin modelnya ke folder ini.
    pause
    exit /b 1
)
echo [INFO] Model kendaraan: %PARKING_VEHICLE_MODEL%
rem Khusus FILE VIDEO: 1 tick = 2 detik video (1,26 detik/tick dibulatkan ke atas).
rem Durasi parkir naik 2 detik sekali. Saat sistem lengkap jalan, 1 tick makan
rem kira-kira 1,1-1,4 detik. Isi 1 untuk perilaku persis seperti di laptop
rem (video di dashboard lalu berjalan kira-kira 1,0-1,4x lebih lambat).
set PARKING_TICK_STEP=2
rem Tanpa cek internet / auto-install paket oleh Ultralytics saat runtime
rem (paket sudah terpasang: requirements.txt, plus onnxruntime untuk best.onnx).
set YOLO_OFFLINE=true
rem Suara alert. Kalimat baru butuh internet (edge-tts); yang pernah dibuat
rem tersimpan di outputs\tts_temp. Isi false kalau tanpa speaker.
set ENABLE_TTS=true
rem --------------------------------------------------------------------

rem Build dashboard kalau folder dist belum ada (sekali saja, butuh internet untuk npm install)
if not exist "parking-dashboard\dist\index.html" (
    echo [INFO] Dashboard belum di-build, menjalankan npm install dan npm run build ...
    pushd parking-dashboard
    if not exist node_modules call npm install --no-audit --no-fund
    call npm run build
    popd
)

rem Kalau file ini dijalankan lagi saat sistem masih hidup, backend/dashboard yang
rem sudah berjalan tidak dijalankan kedua kali (dua backend = CPU terbagi dua;
rem preview kedua pindah ke port 4174).

rem Backend (jendela 1). disable_quickedit.py mematikan QuickEdit khusus jendela ini
rem (klik di jendela tidak lagi membekukan deteksi), lalu menjalankan uvicorn.
rem --ulang: backend yang mati mendadak (mis. galat baca disk) dijalankan lagi
rem otomatis, dan sesi kamera yang sedang berjalan dilanjutkan (kamera, zona,
rem kendaraan beserta durasinya). Lihat outputs\sesi_kamera.
curl -s -o nul http://127.0.0.1:8000/status
if not errorlevel 1 (
    echo [INFO] Backend sudah berjalan di port 8000, tidak dijalankan lagi.
) else (
    start "Backend - Illegal Parking" cmd /k python tools\disable_quickedit.py --ulang uvicorn backend.main:app --host 0.0.0.0 --port 8000
)

rem Dashboard hasil build (jendela 2), lebih ringan dari npm run dev
curl -s -o nul http://localhost:4173/
if not errorlevel 1 (
    echo [INFO] Dashboard sudah berjalan di port 4173, tidak dijalankan lagi.
) else (
    start "Dashboard - Illegal Parking" /d "%~dp0parking-dashboard" cmd /k npm run preview
)

rem Tunggu backend menjawab (maks. kira-kira 3 menit), lalu buka browser
echo Menunggu backend siap di http://localhost:8000 ...
set /a COBA=0
:tunggu
set /a COBA+=1
ping -n 3 127.0.0.1 >nul
curl -s -o nul http://127.0.0.1:8000/status
if not errorlevel 1 goto siap
if %COBA% lss 90 goto tunggu
echo [PERINGATAN] Backend belum menjawab. Lihat jendela "Backend - Illegal Parking".
:siap
rem ?lite = mode ringan dashboard: tanpa animasi terus-menerus dan blur. Mesin ini
rem tanpa akselerasi GPU di browser, jadi animasi itu merebut CPU dari deteksi.
start "" "http://localhost:4173/?lite"
echo Dashboard dibuka di browser: http://localhost:4173/?lite
