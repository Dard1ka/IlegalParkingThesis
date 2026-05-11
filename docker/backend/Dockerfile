# ══════════════════════════════════════════════════════════════
# Backend Dockerfile — FastAPI + YOLOv8 + OpenCV
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
    # Ultralytics tidak perlu cek update online
    YOLO_VERBOSE=False \
    YOLO_OFFLINE=True

WORKDIR /app

# ── Python deps (cache layer) ─────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && \
    pip install -r /app/requirements.txt

# ── App source ────────────────────────────────────────────────
# Hanya backend code; model & video di-mount via volume supaya
# image tetap ringan.
COPY backend /app/backend

# Folder runtime (akan di-mount dari host kalau user mau persist)
RUN mkdir -p /app/uploads /app/outputs/tts_temp

EXPOSE 8000

# ── Healthcheck ───────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/ || exit 1

# ── Entry ─────────────────────────────────────────────────────
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
