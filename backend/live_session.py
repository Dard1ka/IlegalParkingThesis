"""
backend/live_session.py
─────────────────────────────────────────────────────────────────
Sesi kamera (webcam / kamera IP): dimulai saat deteksi kamera mulai berjalan
dan berakhir saat sumbernya diganti dari dashboard. Satu sesi = satu folder
outputs/sesi_kamera/<tanggal_jam mulai>/ berisi:

  log_deteksi_<tanggal_jam>.txt   satu baris per kendaraan yang selesai berhenti
                                  di zona (pergi, bergerak lagi, zona diubah,
                                  sesi berakhir), plus kejadian sesi (kamera
                                  terputus / tersambung lagi, backend hidup lagi)
  screenshot\pelanggaran_*.jpg    frame hasil deteksi selama ada pelanggar

Selain itu outputs/sesi_kamera/sesi_aktif.json menyimpan state sesi yang sedang
berjalan (diperbarui tiap beberapa detik). Backend yang mati mendadak lalu
dijalankan lagi memakai file ini untuk melanjutkan sesi yang sama: kamera
disambung ulang, dan kendaraan beserta durasinya tidak hilang. Alamat kamera IP
(berisi password) di file itu dienkripsi Windows DPAPI: hanya bisa dibuka akun
Windows yang sama di komputer ini.

Modul ini tidak tahu apa-apa tentang deteksi: processor.py yang menghitung
durasi dan status, modul ini hanya menulis file. Semua akses disk dikerjakan
SATU thread penulis (urutan tetap: baris log, screenshot, lalu state), jadi disk
yang lambat / bermasalah tidak pernah menahan tick deteksi, dan gagal menulis
cukup satu baris peringatan.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

import cv2

SESSION_ROOT  = Path("outputs/sesi_kamera")
STATE_FILE    = SESSION_ROOT / "sesi_aktif.json"
STATE_VERSION = 1

SCREENSHOT_JPEG_QUALITY = 85
FLUSH_WAIT = 5.0        # detik paling lama menunggu thread penulis saat sesi ditutup / state dibaca

# Status saat kendaraan keluar → teks di log (kunci sama dengan status dashboard)
STATUS_TEXT = {
    "violation":  "PELANGGARAN",
    "warning":    "PERINGATAN",
    "safe":       "AMAN (segitiga)",
    "monitoring": "MEMANTAU",
}

# Lebar kolom tabel log (teks yang lebih panjang tetap ditulis utuh)
COLUMNS = (("No", 4), ("LID", 6), ("Kendaraan", 26), ("Zona", 4), ("Mulai berhenti", 19),
           ("Selesai berhenti", 19), ("Durasi berhenti", 28), ("Status saat keluar", 18),
           ("Segitiga", 10), ("Keterangan", 0))


def _stamp(wall: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(wall))


def _folder_name(wall: float) -> str:
    return time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(wall))


def format_duration(seconds: int) -> str:
    """1405 → '1405 dtk (23 mnt 25 dtk)'; di bawah semenit cukup '45 dtk'."""
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds} dtk"
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    parts = (f"{h} jam " if h else "") + f"{m} mnt {s} dtk"
    return f"{seconds} dtk ({parts})"


def _row(values) -> str:
    cells = [str(v).ljust(width) if width else str(v) for v, (_, width) in zip(values, COLUMNS)]
    return " | ".join(cells).rstrip()


# ── Thread penulis ─────────────────────────────────────────────
class _Writer:
    """Satu thread daemon yang mengerjakan tugas tulis berurutan (FIFO)."""

    def __init__(self):
        self._q: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._state_gen = 0         # simpan-state yang sudah disusul simpanan lebih baru dilewati

    def submit(self, task: Callable[[], None]) -> None:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True, name="SesiWriter")
                self._thread.start()
        self._q.put(task)

    def submit_state(self, write: Callable[[], None]) -> None:
        """Simpan state; bila simpanan yang lebih baru sudah antre, yang ini dilewati."""
        with self._lock:
            self._state_gen += 1
            gen = self._state_gen

        def task():
            if gen == self._state_gen:
                write()
        self.submit(task)

    def flush(self, timeout: float = FLUSH_WAIT) -> bool:
        """Tunggu semua tugas yang sudah antre selesai. False bila waktunya habis (disk macet)."""
        if self._thread is None:
            return True
        done = threading.Event()
        self.submit(done.set)
        if done.wait(timeout):
            return True
        print(f"[SESI] Penulisan file sesi belum selesai setelah {timeout:.0f} detik (disk lambat?).")
        return False

    def _run(self) -> None:
        while True:
            task = self._q.get()
            try:
                task()
            except Exception as e:                       # tugas sudah menangkap OSError-nya sendiri
                print(f"[SESI] Penulisan file sesi gagal: {type(e).__name__}: {e}")


_writer = _Writer()


# ── Enkripsi alamat kamera (Windows DPAPI, tanpa paket tambahan) ─────────
def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    buf      = ctypes.create_string_buffer(data, len(data))
    blob_in  = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if not fn(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise OSError(f"DPAPI gagal (kode {ctypes.GetLastError()})")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))


def protect_secret(text: str) -> Optional[str]:
    """Teks rahasia → base64 terenkripsi DPAPI; None bila tidak bisa (bukan Windows / gagal)."""
    if sys.platform != "win32":
        return None
    try:
        return base64.b64encode(_dpapi(text.encode("utf-8"), True)).decode("ascii")
    except Exception as e:
        print(f"[SESI] Alamat kamera tidak bisa dienkripsi ({e}); sesi tidak bisa dilanjutkan otomatis.")
        return None


def unprotect_secret(blob: str) -> Optional[str]:
    if sys.platform != "win32" or not blob:
        return None
    try:
        return _dpapi(base64.b64decode(blob), False).decode("utf-8")
    except Exception as e:
        print(f"[SESI] Alamat kamera tersimpan tidak bisa dibuka ({e}).")
        return None


class LiveSession:
    """
    File milik satu sesi kamera. Semua waktu kendaraan dalam "detik logika":
    detik sejak sesi dimulai (sumber langsung: detik nyata), jadi jam dinding
    sebuah detik logika = started_wall + detik itu.

    Penghitung (logged, counts, shots) diperbarui langsung di thread pemanggil,
    jadi state yang disimpan selalu cocok dengan baris yang SUDAH diantrekan ke
    log; penulisannya sendiri dikerjakan thread penulis sesuai urutan antre.
    """

    def __init__(self, folder: Path, started_wall: float, logged: int = 0,
                 counts: Optional[Dict[str, int]] = None, shots: int = 0):
        self.folder       = folder
        self.started_wall = started_wall
        self.log_path     = folder / f"log_deteksi_{_folder_name(started_wall)}.txt"
        self.shot_dir     = folder / "screenshot"
        self.logged       = logged                       # baris kendaraan yang sudah ditulis
        self.counts       = dict(counts or {})           # status → jumlah kendaraan
        self.shots        = shots                        # screenshot yang sudah disimpan
        # Path absolut dihitung sekali di sini (tanpa menyentuh disk): info() murni di memori
        self._info_paths  = {"folder": os.path.abspath(folder), "log_file": os.path.abspath(self.log_path)}

    # ── Membuat / membuka sesi ────────────────────────────────
    @classmethod
    def start(cls, source_text: str, zone_text: str, rules_text: str) -> "LiveSession":
        """Sesi baru: folder baru + kepala log."""
        started = time.time()
        folder  = SESSION_ROOT / _folder_name(started)
        n = 2
        try:
            while folder.exists():                       # dua sesi dalam detik yang sama
                folder = SESSION_ROOT / f"{_folder_name(started)}_{n}"
                n += 1
        except OSError:
            pass
        session = cls(folder, started)
        session._write([
            "LOG DETEKSI PARKIR LIAR - SESI KAMERA",
            f"Sesi dimulai : {_stamp(started)}",
            f"Sumber       : {source_text}",
            f"Zona         : {zone_text}",
            f"Aturan       : {rules_text}",
            "Dicatat      : setiap kendaraan yang sudah berhenti di zona, saat ia pergi, bergerak lagi,",
            "               zonanya diubah, atau sesi berakhir. Durasi = lama kendaraan terlacak berhenti di zona.",
            "",
            _row(name for name, _ in COLUMNS),
            "-" * 196,
        ])
        print(f"[SESI] Sesi kamera baru: {session.log_path}")
        return session

    @classmethod
    def reopen(cls, state: Dict) -> "LiveSession":
        """Sesi dari state tersimpan (backend dijalankan lagi)."""
        return cls(Path(state["folder"]), float(state["started_wall"]), int(state.get("logged", 0)),
                   state.get("counts") or {}, int(state.get("shots", 0)))

    # ── Isi log ───────────────────────────────────────────────
    def wall(self, logic_second: int) -> float:
        return self.started_wall + logic_second

    def event(self, text: str) -> None:
        """Kejadian sesi (bukan kendaraan), diberi jam saat ini."""
        self._write([f"[{_stamp(time.time())}] {text}"])

    def log_vehicle(self, lid: int, vehicle: str, zone: int, start_second: int, end_second: int,
                    status: str, triangle: str, reason: str) -> None:
        self.logged += 1
        self.counts[status] = self.counts.get(status, 0) + 1
        self._write([_row((
            self.logged, f"LID-{lid:02d}", vehicle, zone,
            _stamp(self.wall(start_second)), _stamp(self.wall(end_second)),
            format_duration(end_second - start_second), STATUS_TEXT.get(status, status),
            triangle, reason))])

    def close(self, reason: str) -> None:
        """Penutup log: alasan + ringkasan, lalu tunggu semua tulisan sesi selesai."""
        parts = [f"{self.counts[k]} {STATUS_TEXT[k].lower()}" for k in STATUS_TEXT if self.counts.get(k)]
        summary = f"{self.logged} kendaraan tercatat" + (f": {', '.join(parts)}" if parts else "")
        self._write([f"[{_stamp(time.time())}] Sesi berakhir: {reason}.",
                     f"Ringkasan: {summary}; {self.shots} screenshot pelanggaran.", ""])
        _writer.flush()
        print(f"[SESI] Sesi kamera ditutup ({reason}): {self.log_path}")

    def _write(self, lines: List[str]) -> None:
        folder, path, text = self.folder, self.log_path, "\n".join(lines) + "\n"

        def task():
            try:
                folder.mkdir(parents=True, exist_ok=True)
                with open(path, "a", encoding="utf-8") as f:
                    f.write(text)
            except OSError as e:
                print(f"[SESI] Log {path} tidak bisa ditulis: {e}")
        _writer.submit(task)

    # ── Screenshot ────────────────────────────────────────────
    def screenshot(self, image, lines: List[str]) -> None:
        """
        Simpan salinan `image` + keterangan di bawahnya (pemanggil boleh terus
        menggambar di `image`: yang disimpan salinannya). JPEG dibuat dan ditulis
        di thread penulis.
        """
        now   = time.time()
        path  = self.shot_dir / f"pelanggaran_{_folder_name(now)}.jpg"
        shot  = image.copy()
        text  = [f"PELANGGARAN PARKIR - {_stamp(now)}"] + lines
        self.shots += 1
        self.event(f"Screenshot pelanggaran ({len(lines)} baris): {path.name}")
        shot_dir = self.shot_dir

        def task():
            try:
                h = shot.shape[0]
                line_h = 30
                top = max(0, h - line_h * len(text) - 14)
                band = shot[top:h]
                band[:] = (band * 0.35).astype(band.dtype)      # latar gelap supaya teks terbaca
                for i, t in enumerate(text):
                    cv2.putText(shot, t, (16, top + 28 + i * line_h), cv2.FONT_HERSHEY_SIMPLEX,
                                0.75 if i == 0 else 0.62, (0, 0, 255) if i == 0 else (255, 255, 255),
                                2, cv2.LINE_AA)
                ok, buf = cv2.imencode(".jpg", shot, [cv2.IMWRITE_JPEG_QUALITY, SCREENSHOT_JPEG_QUALITY])
                if not ok:
                    raise OSError("JPEG gagal dibuat")
                shot_dir.mkdir(parents=True, exist_ok=True)
                target, n = path, 2
                while target.exists():                   # dua screenshot dalam detik yang sama
                    target = path.with_name(f"{path.stem}_{n}.jpg")
                    n += 1
                target.write_bytes(buf.tobytes())
                print(f"[SESI] Screenshot pelanggaran: {target}")
            except Exception as e:
                print(f"[SESI] Screenshot {path} tidak bisa disimpan: {e}")
        _writer.submit(task)

    # ── State untuk dilanjutkan ───────────────────────────────
    def save_state(self, payload: Dict) -> None:
        """
        Antrekan state sesi (dibuat SEKARANG, ditulis atomik oleh thread penulis
        setelah baris log yang sudah antre). File lama tetap utuh bila gagal.
        """
        data = {**payload, "version": STATE_VERSION, "folder": str(self.folder),
                "started_wall": self.started_wall, "saved_wall": time.time(),
                "logged": self.logged, "counts": dict(self.counts), "shots": self.shots}
        try:
            # default: angka numpy (mis. dari kotak deteksi) disimpan sebagai angka biasa
            text = json.dumps(data, ensure_ascii=False,
                              default=lambda o: o.item() if hasattr(o, "item") else str(o))
        except (TypeError, ValueError) as e:
            print(f"[SESI] State sesi tidak bisa dibuat: {e}")
            return
        target = STATE_FILE

        def write():
            tmp = target.with_suffix(".tmp")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_text(text, encoding="utf-8")
                os.replace(tmp, target)
            except OSError as e:
                print(f"[SESI] State sesi tidak bisa disimpan: {e}")
        _writer.submit_state(write)

    @staticmethod
    def load_state() -> Optional[Dict]:
        """State sesi tersimpan, atau None bila tidak ada / rusak / versi lain."""
        _writer.flush()
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            print(f"[SESI] State sesi {STATE_FILE} tidak bisa dibaca ({e}), diabaikan.")
            return None
        if not isinstance(data, dict) or data.get("version") != STATE_VERSION:
            return None
        return data

    @staticmethod
    def discard_state() -> None:
        """Hapus state (setelah semua simpanan yang sudah antre), lalu tunggu selesai."""
        target = STATE_FILE

        def task():
            try:
                target.unlink(missing_ok=True)
            except OSError as e:
                print(f"[SESI] State sesi {target} tidak bisa dihapus: {e}")
        _writer.submit_state(task)        # menyusul simpan-state yang masih antre
        _writer.flush()

    @staticmethod
    def flush() -> None:
        """Tunggu semua tulisan sesi yang sudah antre selesai (mis. sebelum backend berhenti)."""
        _writer.flush()

    def info(self) -> Dict:
        """Ringkasan untuk GET /status (tanpa akses disk)."""
        return {"started": _stamp(self.started_wall), **self._info_paths,
                "logged": self.logged, "screenshots": self.shots}
