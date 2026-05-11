"""
backend/shared.py
─────────────────────────────────────────────────────────────────
Thread-safe shared state antara VideoProcessor (thread biasa)
dan FastAPI (async event loop).
"""

import threading
from typing import Optional, List, Dict


class SharedState:
    def __init__(self):
        self._lock = threading.Lock()

        # ── Frame terakhir sebagai bytes JPEG ──────────────────
        self._frame_jpeg: Optional[bytes] = None

        # ── Daftar alert aktif ────────────────────────────────
        self._alerts: List[Dict] = []
        self._stats: Dict = {"total": 0, "warning": 0, "violation": 0, "safe": 0}

        # ── ROI (multi-polygon) yang belum diambil processor ──
        # Format: list of polygons → [[[x,y],...], [[x,y],...]]
        # Koordinat ternormalisasi [0,1]
        self._roi_pending: Optional[List[List]] = None

        # ── Konfigurasi sumber video ──────────────────────────
        # {"type": "video", "path": "..."}  atau
        # {"type": "camera", "index": 0}
        self._source_config: Optional[Dict] = None
        self._source_pending: Optional[Dict] = None   # belum diambil processor

        # ── Mode ROI ─────────────────────────────────────────
        # "manual" = tunggu ROI dari frontend
        # "auto"   = gunakan seluruh frame
        self._roi_mode: str = "manual"

        # ── Frame pertama (untuk drawing ROI di frontend) ─────
        self._first_frame_jpeg: Optional[bytes] = None

        # ── Status processor ──────────────────────────────────
        self._running: bool = False

    # ── Frame ─────────────────────────────────────────────────
    def set_frame(self, jpeg: bytes) -> None:
        with self._lock:
            self._frame_jpeg = jpeg

    def get_frame(self) -> Optional[bytes]:
        with self._lock:
            return self._frame_jpeg

    # ── First frame (untuk ROI drawing di frontend) ───────────
    def set_first_frame(self, jpeg: bytes) -> None:
        with self._lock:
            self._first_frame_jpeg = jpeg

    def get_first_frame(self) -> Optional[bytes]:
        with self._lock:
            return self._first_frame_jpeg

    # ── Alerts & Stats ────────────────────────────────────────
    def set_alerts(self, alerts: List[Dict], stats: Dict) -> None:
        with self._lock:
            self._alerts = alerts
            self._stats = stats

    def get_alerts(self) -> List[Dict]:
        with self._lock:
            return list(self._alerts)

    def get_stats(self) -> Dict:
        with self._lock:
            return dict(self._stats)

    # ── ROI (multi-polygon) ───────────────────────────────────
    def set_roi(self, rois: List[List]) -> None:
        """
        rois = list of polygons.
        Tiap polygon = list of [x_norm, y_norm] pairs.
        """
        with self._lock:
            self._roi_pending = rois

    def take_roi(self) -> Optional[List[List]]:
        with self._lock:
            roi = self._roi_pending
            self._roi_pending = None
            return roi

    def has_roi_pending(self) -> bool:
        with self._lock:
            return self._roi_pending is not None

    # ── Source config ─────────────────────────────────────────
    def set_source(self, config: Dict) -> None:
        """Dipanggil FastAPI saat frontend POST /configure."""
        with self._lock:
            self._source_config = config
            self._source_pending = config

    def take_source(self) -> Optional[Dict]:
        """Processor ambil source baru; reset pending setelah diambil."""
        with self._lock:
            src = self._source_pending
            self._source_pending = None
            return src

    def get_source(self) -> Optional[Dict]:
        with self._lock:
            return self._source_config

    def has_source(self) -> bool:
        with self._lock:
            return self._source_config is not None

    # ── ROI mode ──────────────────────────────────────────────
    def set_roi_mode(self, mode: str) -> None:
        with self._lock:
            self._roi_mode = mode

    def get_roi_mode(self) -> str:
        with self._lock:
            return self._roi_mode

    # ── Running state ─────────────────────────────────────────
    def set_running(self, value: bool) -> None:
        with self._lock:
            self._running = value

    def is_running(self) -> bool:
        with self._lock:
            return self._running
