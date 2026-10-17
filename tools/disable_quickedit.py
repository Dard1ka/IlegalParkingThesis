"""
tools/disable_quickedit.py
─────────────────────────────────────────────────────────────────
Matikan QuickEdit HANYA untuk jendela konsol ini, lalu jalankan perintah
yang diberikan di jendela yang sama dan tunggu sampai selesai.

  python tools\\disable_quickedit.py uvicorn backend.main:app --host 0.0.0.0 --port 8000

Dipakai start_minipc.bat untuk jendela backend.

Kenapa: dengan QuickEdit aktif, satu klik di jendela backend memulai mode
"Select", dan setiap print() berikutnya tertahan sampai seleksi dilepas
(Esc / klik kanan). Thread deteksi ikut berhenti tanpa pesan error, stream
membeku, tetapi badge dashboard tetap "Live".

Kenapa sebagai peluncur, bukan dipanggil sebelum uvicorn: cmd.exe
mengembalikan mode konsol begitu program yang dijalankannya selesai, jadi
skrip ini harus tetap hidup selama perintahnya berjalan.

Ini bukan pengaturan Windows: yang diubah hanya mode jendela ini, dan hilang
begitu jendelanya ditutup. Pengaturan QuickEdit di Properties / registry
tidak disentuh. Di luar Windows hanya perintahnya yang dijalankan.
"""
import ctypes
import signal
import subprocess
import sys

ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS  = 0x0080
STD_INPUT_HANDLE       = -10


def disable_quickedit() -> None:
    if sys.platform != "win32":
        return
    k32    = ctypes.windll.kernel32
    handle = k32.GetStdHandle(STD_INPUT_HANDLE)
    mode   = ctypes.c_uint32()
    if k32.GetConsoleMode(handle, ctypes.byref(mode)):
        k32.SetConsoleMode(handle, (mode.value | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE)


if __name__ == "__main__":
    disable_quickedit()
    if len(sys.argv) > 1:
        # Ctrl+C sampai ke semua proses di jendela ini: biarkan perintahnya
        # (uvicorn) yang menangani dan berhenti dengan rapi, skrip ini menunggu.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        sys.exit(subprocess.call(sys.argv[1:]))
