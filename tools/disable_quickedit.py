"""
tools/disable_quickedit.py
─────────────────────────────────────────────────────────────────
Matikan QuickEdit HANYA untuk jendela konsol ini, lalu jalankan perintah
yang diberikan di jendela yang sama dan tunggu sampai selesai.

  python tools\\disable_quickedit.py uvicorn backend.main:app --host 0.0.0.0 --port 8000
  python tools\\disable_quickedit.py --ulang uvicorn backend.main:app ...

Dipakai start_minipc.bat untuk jendela backend.

Kenapa: dengan QuickEdit aktif, satu klik di jendela backend memulai mode
"Select", dan setiap print() berikutnya tertahan sampai seleksi dilepas
(Esc / klik kanan). Thread deteksi ikut berhenti tanpa pesan error, stream
membeku, tetapi badge dashboard tetap "Live".

Kenapa sebagai peluncur, bukan dipanggil sebelum uvicorn: cmd.exe
mengembalikan mode konsol begitu program yang dijalankannya selesai, jadi
skrip ini harus tetap hidup selama perintahnya berjalan.

--ulang: perintah yang berhenti TIDAK normal (mis. proses Python mati mendadak
karena galat baca disk 0xC0000006) dijalankan lagi otomatis setelah jeda
singkat. Tidak diulang: berhenti normal (kode 0), Ctrl+C (0xC000013A), dan
kegagalan startup uvicorn (kode 3, mis. port sudah dipakai). Sebelum
mengulang, bila port --port sudah dijawab backend lain, peluncur berhenti
(jangan ada dua backend berebut CPU). Untuk berhenti total: tutup jendelanya,
atau Ctrl+C saat jeda.

Ini bukan pengaturan Windows: yang diubah hanya mode jendela ini, dan hilang
begitu jendelanya ditutup. Pengaturan QuickEdit di Properties / registry
tidak disentuh. Di luar Windows hanya perintahnya yang dijalankan.
"""
import ctypes
import signal
import socket
import subprocess
import sys
import time

ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS  = 0x0080
STD_INPUT_HANDLE       = -10

RESTART_WAIT_MIN = 5       # detik jeda sebelum perintah dijalankan lagi
RESTART_WAIT_MAX = 60      # jeda digandakan bila perintah mati lagi dalam STABLE_SECONDS
STABLE_SECONDS   = 120     # perintah yang sempat hidup selama ini: jeda kembali ke minimum
# Kode keluar yang berarti "jangan diulang": normal, startup uvicorn gagal (port
# dipakai, error impor), Ctrl+C / jendela ditutup (STATUS_CONTROL_C_EXIT)
FINAL_CODES      = {0, 3, 0xC000013A}


def disable_quickedit() -> None:
    if sys.platform != "win32":
        return
    k32    = ctypes.windll.kernel32
    handle = k32.GetStdHandle(STD_INPUT_HANDLE)
    mode   = ctypes.c_uint32()
    if k32.GetConsoleMode(handle, ctypes.byref(mode)):
        k32.SetConsoleMode(handle, (mode.value | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE)


def run(cmd) -> int:
    # Ctrl+C sampai ke semua proses di jendela ini: biarkan perintahnya
    # (uvicorn) yang menangani dan berhenti dengan rapi, skrip ini menunggu.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    return subprocess.call(cmd)


def _port_of(cmd) -> int:
    """Nilai --port pada perintah uvicorn (default 8000)."""
    for i, arg in enumerate(cmd[:-1]):
        if arg == "--port":
            try:
                return int(cmd[i + 1])
            except ValueError:
                break
    return 8000


def _port_busy(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def run_forever(cmd) -> int:
    wait = RESTART_WAIT_MIN
    port = _port_of(cmd)
    while True:
        started = time.monotonic()
        code = run(cmd)
        if (code & 0xFFFFFFFF) in FINAL_CODES:
            return code
        if _port_busy(port):
            print(f"\n[ULANG] Backend berhenti (kode {code & 0xFFFFFFFF:#010x}), tetapi port {port} "
                  f"sudah dipakai backend lain: tidak dijalankan lagi.", flush=True)
            return code
        if time.monotonic() - started >= STABLE_SECONDS:
            wait = RESTART_WAIT_MIN
        print(f"\n[ULANG] {time.strftime('%Y-%m-%d %H:%M:%S')} Backend berhenti mendadak "
              f"(kode keluar {code} / {code & 0xFFFFFFFF:#010x}). Dijalankan lagi dalam {wait} detik; "
              f"sesi kamera dilanjutkan otomatis. Ctrl+C sekarang atau tutup jendela untuk berhenti.",
              flush=True)
        signal.signal(signal.SIGINT, signal.default_int_handler)
        try:
            time.sleep(wait)
        except KeyboardInterrupt:
            return code
        wait = min(RESTART_WAIT_MAX, wait * 2)


if __name__ == "__main__":
    disable_quickedit()
    args = sys.argv[1:]
    restart = bool(args) and args[0] == "--ulang"
    if restart:
        args = args[1:]
    if args:
        code = run_forever(args) if restart else run(args)
        # Kode NTSTATUS Windows (mis. 0xC000013A) tidak muat di sys.exit() 32-bit bertanda
        sys.exit(code if 0 <= code <= 255 else 1)
