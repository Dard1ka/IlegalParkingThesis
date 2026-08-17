#!/usr/bin/env bash
# REPLIKA (direkonstruksi dari log sesi laptop b3cbe55e, 16-18 Agu 2026) urutan perintah
# yang dijalankan/diberikan untuk Raspberry Pi 4B 4GB, Raspberry Pi OS Trixie (Debian 13),
# Python 3.13, venv ~/Illegal_Parking/parking, proyek ~/Illegal_Parking.
# Nomor Lxxx = baris JSONL di C:/Users/darrr/.claude/projects/D--Thesis/b3cbe55e-*.jsonl
# Bukan file asli dari Pi - file asli di Pi tidak pernah disalin balik ke laptop.

# --- 16 Agu: apt (L251-L420) ---------------------------------------------------------
sudo apt update && sudo apt upgrade -y               # requirements-rpi.txt langkah 1; Pi reboot sendiri (L273)
sudo apt install -y python3-venv python3-pip \
     libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 libgomp1 \
     ffmpeg libatlas-base-dev libopenblas-dev \
     libsdl2-2.0-0 libsdl2-mixer-2.0-0 libportaudio2
vcgencmd get_throttled        # hasil user: throttled=0x0 (L291)
vcgencmd measure_temp         # hasil user: 50,6 C (L304)
# pemulihan upgrade terputus (L395) - 4 baris ini juga ditempel di akhir requirements-rpi.txt versi zip
sudo dpkg --configure -a
sudo apt --fix-broken install
sudo apt update
sudo apt full-upgrade
# dphys-swapfile tidak ada di Trixie (L401); swap 2 GB sudah ada -> dilewati
# apt macet 7% via IPv6 (L414/L420):
echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99force-ipv4

# --- 17 Agu: venv + pip (L451) ----------------------------------------------------------
# venv bernama "parking" di ~/Illegal_Parking (nama dari traceback /home/pi/Illegal_Parking/parking/...)
# INFERENSI: perintah pembuatan venv yang persis tidak tercatat di log (requirements-rpi.txt menyarankan ~/parking-env)
python3 -m venv ~/Illegal_Parking/parking
source ~/Illegal_Parking/parking/bin/activate
pip install -r requirements-rpi.txt   # hasil: torch 2.13.0+cpu, ultralytics 8.4.121, ncnn 1.0.20260526,
                                      # numpy 1.26.4, opencv-python 4.11.0.86, onnxruntime 1.28.0 (L451)
sudo apt install -y libopenblas0-pthread libopenblas-dev   # sudah terpasang 0.3.29+ds-3 (L451)
python3 -c "import torch; print('Torch OK', torch.__version__)"  # OK sendirian, tapi yolo/uvicorn: sbgemm_

# --- LD_PRELOAD (L468 gagal -> L500 berhasil) -------------------------------------------
# gagal: OpenBLAS sistem /lib/aarch64-linux-gnu/libopenblas.so.0 juga tanpa sbgemm_ (L477/L486)
# berhasil ("oke backend nya kebuka", L506):
export LD_PRELOAD=$(for f in $(find ~/Illegal_Parking/parking -name "*.so*" 2>/dev/null); do nm -D "$f" 2>/dev/null | grep -qE ' [TWtw] sbgemm_' && echo "$f" && break; done)
# path .so persis hasil echo $LD_PRELOAD TIDAK tercatat di log.

# --- export NCNN (L458 Fix A; user mengonfirmasi sudah terkonversi di L532) -------------
python3 -c "import torch; from ultralytics import YOLO; YOLO('best.pt').export(format='ncnn')"
python3 -c "import torch; from ultralytics import YOLO; YOLO('triangle.pt').export(format='ncnn')"
# (L625 menyarankan export ulang imgsz=320 bila folder belum ada - tidak tercatat apakah dijalankan)

# --- frontend (L526, L532) --------------------------------------------------------------
sudo apt install -y nodejs npm        # Node v20.19.2, npm 9.2.0 (L714)
cd ~/Illegal_Parking/parking-dashboard && npm install && npm run dev   # log Pi: VITE v8.2.1 (L532)
