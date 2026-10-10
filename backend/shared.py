"""
backend/shared.py
─────────────────────────────────────────────────────────────────
Thread-safe shared state antara VideoProcessor (thread biasa)
dan FastAPI (async event loop).
"""

import threading
from typing import Optional, List, Dict


def _empty_stats() -> Dict:
    return {"total": 0, "warning": 0, "violation": 0, "safe": 0}


def _fresh_proc(state: str) -> Dict:
    return {"state": state, "tick": 0, "tick_ms": None, "error": None}


class SharedState:
    """
    Aturan "data basi": sejak /configure baru masuk (set_source) sampai
    processor mengambilnya (take_source), processor masih mengerjakan sumber
    LAMA. Semua yang ia tulis pada jeda itu (frame, frame pertama, alert)
    dibuang, supaya data sumber lama tidak muncul lagi setelah dikosongkan.
    """

    def __init__(self):
        self._lock = threading.Lock()

        # ── Frame terakhir sebagai bytes JPEG ──────────────────
        self._frame_jpeg: Optional[bytes] = None

        # ── Daftar alert aktif ────────────────────────────────
        self._alerts: List[Dict] = []
        self._stats: Dict = _empty_stats()

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
        self._running: bool = False   # thread processor hidup?

        # state   : loading_models | waiting_source | opening_source |
        #           waiting_roi | running | error | stopped
        # tick    : jumlah tick yang sudah selesai untuk sumber saat ini
        # tick_ms : lama tick terakhir (milidetik jam nyata), None bila belum ada
        # error   : pesan singkat bila state == "error" (atau thread berhenti
        #           karena error), selain itu None
        self._proc: Dict = _fresh_proc("stopped")

    # ── Frame ─────────────────────────────────────────────────
    def set_frame(self, jpeg: bytes) -> None:
        with self._lock:
            if self._source_pending is None:      # aturan "data basi"
                self._frame_jpeg = jpeg

    def get_frame(self) -> Optional[bytes]:
        with self._lock:
            return self._frame_jpeg

    # ── First frame (untuk ROI drawing di frontend) ───────────
    def set_first_frame(self, jpeg: bytes) -> None:
        with self._lock:
            if self._source_pending is None:      # aturan "data basi"
                self._first_frame_jpeg = jpeg

    def get_first_frame(self) -> Optional[bytes]:
        """None sampai frame pertama sumber yang SEKARANG dikonfigurasi tersimpan."""
        with self._lock:
            return self._first_frame_jpeg

    # ── Alerts & Stats ────────────────────────────────────────
    def set_alerts(self, alerts: List[Dict], stats: Dict) -> None:
        with self._lock:
            if self._source_pending is None:      # aturan "data basi"
                self._alerts = alerts
                self._stats = stats

    def clear_alerts(self) -> None:
        with self._lock:
            self._alerts = []
            self._stats = _empty_stats()

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
    def set_source(self, config: Dict, roi_mode: str = "manual") -> None:
        """
        Dipanggil FastAPI saat frontend POST /configure.

        Sumber dan mode ROI disimpan dalam satu kuncian, dan semua data milik
        sumber lama dikosongkan saat itu juga: /first_frame menjawab 204 sampai
        frame pertama sumber BARU tersimpan, dan frame / alert / stats lama
        tidak disiarkan lagi (lihat aturan "data basi" di docstring kelas).
        """
        with self._lock:
            self._source_config    = config
            self._source_pending   = config
            self._roi_mode         = roi_mode
            self._roi_pending      = None      # ROI yang belum diambil = milik sumber lama
            self._first_frame_jpeg = None
            self._frame_jpeg       = None
            self._alerts           = []
            self._stats            = _empty_stats()

    def take_source(self) -> Optional[Dict]:
        """Processor ambil source baru; reset pending setelah diambil."""
        with self._lock:
            src = self._source_pending
            self._source_pending = None
            if src is not None:
                # Sumber baru mulai dikerjakan: tick / error sumber lama dibuang
                self._proc = _fresh_proc("opening_source")
            return src

    def has_source_pending(self) -> bool:
        """Ada /configure baru yang belum diambil processor? (tidak mengambilnya)"""
        with self._lock:
            return self._source_pending is not None

    def get_source(self) -> Optional[Dict]:
        with self._lock:
            return self._source_config

    # ── ROI mode ──────────────────────────────────────────────
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

    # ── Status processor ("proc") ─────────────────────────────
    def set_proc_state(self, state: str, error: Optional[str] = None) -> None:
        """Ganti state; error hanya diisi untuk "error" (atau "stopped" karena error)."""
        with self._lock:
            self._proc["state"] = state
            self._proc["error"] = error

    def set_proc_tick(self, tick: int, tick_ms: float) -> None:
        with self._lock:
            self._proc["tick"] = tick
            self._proc["tick_ms"] = tick_ms

    def get_proc(self) -> Dict:
        """Salinan {"state", "tick", "tick_ms", "error"} untuk /status dan WebSocket."""
        with self._lock:
            # /configure baru sudah masuk tetapi belum diambil processor: status
            # (termasuk error) sumber lama jangan terbaca sebagai status sumber baru.
            if (self._source_pending is not None
                    and self._proc["state"] not in ("loading_models", "stopped")):
                return _fresh_proc("opening_source")
            return dict(self._proc)
