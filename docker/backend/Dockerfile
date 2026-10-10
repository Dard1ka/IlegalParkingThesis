# ══════════════════════════════════════════════════════════════
# Backend Dockerfile — FastAPI + YOLO (Ultralytics) + OpenCV
# Image ini CPU-only: PyTorch dipasang dari index CPU, tanpa wheel CUDA.
# ══════════════════════════════════════════════════════════════
FROM python:3.11-slim

# ── System dependencies untuk OpenCV, pygame, ffmpeg ──────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libgomp1 \
        ffmpeg \
        libsdl2-2.0-0 \
        libsdl2-mixer-2.0-0 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# ── Environment ───────────────────────────────────────────────
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Pygame tidak punya audio hardware di container → pakai dummy driver
    SDL_AUDIODRIVER=dummy \
    # Driver dummy tidak bersuara → TTS default mati di Docker
    # (nyalakan lewat docker/.env kalau audio host sudah diteruskan)
    ENABLE_TTS=false \
    # Ultralytics: tanpa cek online, telemetri, dan auto-install paket saat
    # runtime. Aman karena semua dependency (termasuk lap) ada di requirements.txt
    YOLO_VERBOSE=False \
    YOLO_OFFLINE=True

WORKDIR /app

# ── PyTorch CPU-only (layer sendiri, sebelum requirements) ────
# Di Linux, wheel torch bawaan PyPI adalah build CUDA yang ikut menarik
# paket nvidia-* berukuran beberapa GB dan tidak terpakai tanpa GPU.
# Index di bawah hanya berisi build CPU. Karena sudah terpasang lebih dulu,
# `pip install -r` di layer berikutnya menganggap torch & torchvision sudah
# terpenuhi (jangan tambahkan --upgrade di sana), dan mengubah
# requirements.txt tidak lagi mengunduh ulang PyTorch.
# Rentang versi torch harus sama dengan yang ada di requirements.txt.
RUN pip install --upgrade pip && \
    pip install --index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.0.0,<3" torchvision

# ── Python deps (cache layer) ─────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Folder runtime (akan di-mount dari host kalau user mau persist)
RUN mkdir -p /app/uploads /app/outputs/tts_temp

# ── App source ────────────────────────────────────────────────
# Hanya backend code; model & video di-mount via volume supaya
# image tetap ringan.
COPY backend /app/backend

EXPOSE 8000

# ── Healthcheck ───────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/ || exit 1

# ── Entry ─────────────────────────────────────────────────────
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
