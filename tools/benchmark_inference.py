"""
tools/benchmark_inference.py
─────────────────────────────────────────────────────────────────
Benchmark inferensi di MESIN TARGET (mis. mini PC i5-2400).

Skrip ini mengukur berapa lama satu "tick" backend di mesin tempat ia
dijalankan, dengan cara yang sama seperti backend/processor.py:
  • frame diambil dari file video, satu frame per detik video
    (grab() berurutan + read(), sama seperti _read_video_frame),
  • model kendaraan dipanggil lewat .track() dengan conf 0.25, iou 0.50,
    satu frame per panggilan, memakai tracker default backend (botsort.yaml),
  • frame hasil di-encode JPEG kualitas 78.

Yang TIDAK diukur: model segitiga (hanya jalan sekali per kendaraan yang
parkir >= 60 detik), TTS, dan pekerjaan FastAPI/browser.

Hanya butuh paket aplikasi (requirements.txt). psutil opsional. Model hasil
export hanya diuji kalau runtime-nya ter-install:
  • file    *.onnx            → butuh paket  onnxruntime (dan onnx)
  • folder  *_openvino_model  → butuh paket  openvino (jangan dipakai di CPU
                                tanpa AVX2 — lihat SETUP.md bagian "PC Lambat")
Skrip ini TIDAK meng-install apa pun.

Contoh (jalankan dari root project, di environment aplikasi):
  python tools/benchmark_inference.py
  python tools/benchmark_inference.py --model best.pt --model best.onnx --sizes 960 640
  python tools/benchmark_inference.py --video input4.mp4 --frames 12 --threads 4
"""

from __future__ import annotations
import argparse, importlib.util, json, math, os, platform, statistics, sys, time
from importlib import metadata
from pathlib import Path

# Ultralytics tidak boleh pip-install sendiri di tengah benchmark
os.environ.setdefault("YOLO_AUTOINSTALL", "false")


def _safe_stdout() -> None:
    """
    Tabel memakai karakter garis (═ ─ •). Kalau keluaran dialihkan ke file /
    pipe di Windows, encoding bawaannya (cp1252) tidak mengenal karakter itu
    dan print() gagal. Di konsol biasa tidak ada yang berubah.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════
# ARGUMEN
# ══════════════════════════════════════════════════════════════
ROOT = Path(__file__).resolve().parent.parent      # root project (induk folder tools/)

# Sama dengan backend/processor.py
VEHICLE_CONF = 0.25
IOU          = 0.50
JPEG_QUALITY = 78
WARMUP_CALLS = 3

# Default PARKING_TRACKER di backend: BoT-SORT bawaan Ultralytics (dengan GMC)
DEFAULT_TRACKER = "botsort.yaml"


def parse_args():
    ap = argparse.ArgumentParser(
        description="Benchmark inferensi model kendaraan di mesin ini (median ms per konfigurasi).")
    ap.add_argument("--video", default="input4.mp4",
                    help="File video uji (default: input4.mp4)")
    ap.add_argument("--model", action="append", default=None,
                    help="Model yang diuji; boleh diulang. File .pt, file .onnx, atau folder "
                         "hasil export (mis. best_openvino_model). Default: best.pt")
    ap.add_argument("--sizes", type=int, nargs="+", default=[960, 736, 640, 512, 416],
                    help="Daftar imgsz yang diuji (default: 960 736 640 512 416)")
    ap.add_argument("--frames", type=int, default=12,
                    help="Jumlah frame yang diukur per konfigurasi, berjarak 1 detik video (default: 12)")
    ap.add_argument("--threads", type=int, default=None,
                    help="Paksa jumlah thread (PyTorch, OpenVINO, ONNX Runtime) — HANYA untuk "
                         "pembanding. Backend tidak punya pengaturan thread: model .pt selalu "
                         "berjalan dengan default Ultralytics (jumlah CPU logis dikurangi satu, "
                         "paling banyak 8), runtime lain dengan default-nya sendiri. "
                         "Tanpa opsi ini skrip memakai default yang sama dengan backend.")
    ap.add_argument("--tracker", default=DEFAULT_TRACKER,
                    help="Tracker untuk .track(): botsort.yaml / bytetrack.yaml (bawaan Ultralytics), "
                         "path file YAML (mis. backend/botsort_static.yaml), atau 'none' = hanya "
                         "deteksi (.predict). Default: botsort.yaml, sama dengan default backend")
    ap.add_argument("--start", type=float, default=5.0,
                    help="Detik video pertama yang dipakai (default: 5)")
    ap.add_argument("--out", default=None,
                    help="Nama file JSON hasil (default: benchmark_inference_<waktu>.json di folder kerja)")
    args = ap.parse_args()
    if not args.model:
        args.model = ["best.pt"]
    args.video = _resolve(args.video)
    args.model = [_resolve(m) for m in args.model]
    # Sama seperti PARKING_TRACKER di backend: nama polos "botsort_static.yaml"
    # berarti file bawaan backend/botsort_static.yaml, dari folder mana pun
    if args.tracker == "botsort_static.yaml":
        args.tracker = str(ROOT / "backend" / "botsort_static.yaml")
    args.sizes = [((s + 31) // 32) * 32 for s in args.sizes]      # kelipatan 32, seperti backend
    return args


def _resolve(raw: str) -> str:
    """
    Path relatif yang tidak ada di folder kerja dicoba lagi terhadap root
    project, supaya skrip tetap jalan kalau dipanggil dari folder lain
    (mis. dari dalam tools/). Path yang ada / absolut tidak diubah.
    """
    path = Path(raw)
    if not path.is_absolute() and not path.exists() and (ROOT / path).exists():
        return str(ROOT / path)
    return raw


# ══════════════════════════════════════════════════════════════
# INFO MESIN
# ══════════════════════════════════════════════════════════════
def cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        except Exception:
            pass
    else:
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
    return platform.processor() or platform.machine()


def cpu_flags() -> dict:
    """AVX / AVX2 / AVX-512F menurut sistem operasi (None = tidak bisa dideteksi)."""
    flags = {"sse4_2": None, "avx": None, "avx2": None, "avx512f": None}
    if sys.platform == "win32":
        try:
            import ctypes
            present = ctypes.windll.kernel32.IsProcessorFeaturePresent
            for name, code in (("sse4_2", 38), ("avx", 39), ("avx2", 40), ("avx512f", 41)):
                flags[name] = bool(present(code))
        except Exception:
            pass
    else:
        try:
            txt = Path("/proc/cpuinfo").read_text()
            words = set()
            for line in txt.splitlines():
                if line.startswith("flags"):
                    words = set(line.split(":", 1)[1].split())
                    break
            for name in flags:
                flags[name] = name in words
        except Exception:
            pass
    return flags


def machine_info() -> dict:
    info = {
        "nama": cpu_name(),
        "os": f"{platform.system()} {platform.release()} ({platform.version()})",
        "cpu_logis": os.cpu_count(),
    }
    info.update(cpu_flags())
    try:
        import psutil
        info["cpu_fisik"] = psutil.cpu_count(logical=False)
        vm = psutil.virtual_memory()
        info["ram_total_gb"]    = round(vm.total / 2**30, 1)
        info["ram_tersedia_gb"] = round(vm.available / 2**30, 1)
        fr = psutil.cpu_freq()
        if fr:
            info["mhz"] = round(fr.current)
    except Exception:
        info["cpu_fisik"] = None
    return info


def package_versions() -> dict:
    vers = {"python": platform.python_version()}
    for mod in ("ultralytics", "torch", "torchvision", "cv2", "numpy"):
        try:
            m = __import__(mod)
            vers[mod] = str(getattr(m, "__version__", "?")).split("-")[0]
        except Exception:
            vers[mod] = None          # tidak ter-install
    # Paket opsional TIDAK di-import di sini. Runtime hasil export bisa mematikan
    # proses begitu DLL-nya dimuat di CPU yang tidak didukungnya, dan itu baru boleh
    # terjadi setelah hasil model sebelumnya tersimpan (lihat main). Versinya cukup
    # dibaca dari metadata instalasi.
    for name in ("lap", "openvino", "onnxruntime", "onnx", "psutil"):
        try:
            vers[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            # ter-install dengan nama distribusi lain (mis. onnxruntime-gpu)?
            vers[name] = "?" if importlib.util.find_spec(name) else None
    return vers


# ══════════════════════════════════════════════════════════════
# STATISTIK
# ══════════════════════════════════════════════════════════════
def stats(ms: list) -> dict:
    xs = sorted(ms)
    if not xs:
        return {"median": None, "p90": None, "min": None, "n": 0}
    p90 = xs[min(len(xs) - 1, int(round(0.9 * (len(xs) - 1))))]
    return {"median": round(statistics.median(xs), 1), "p90": round(p90, 1),
            "min": round(xs[0], 1), "n": len(xs)}


def expected_hw(frame_h: int, frame_w: int, imgsz: int, stride: int = 32) -> str:
    """Ukuran tensor untuk letterbox persegi panjang (model .pt / export dynamic)."""
    r = min(imgsz / frame_h, imgsz / frame_w)
    h, w = round(frame_h * r), round(frame_w * r)
    return f"{math.ceil(h / stride) * stride}x{math.ceil(w / stride) * stride}"


# ══════════════════════════════════════════════════════════════
# FRAME VIDEO  (sama seperti backend: grab() berurutan + read())
# ══════════════════════════════════════════════════════════════
def load_frames(cv2, path: str, start: float, count: int):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        # input*.mp4 tidak ikut di git, jadi di mesin target file ini sering belum ada
        raise SystemExit(
            f"[BENCH] Video tidak bisa dibuka: {path}\n"
            f"        Salin video uji ke folder project, atau tunjuk file lain dengan --video <file>\n"
            f"        (video yang di-upload lewat dashboard tersimpan di folder uploads).")
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not (math.isfinite(fps) and fps > 0):
        fps = 25.0
    total   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    targets = [int(round((start + i) * fps)) for i in range(count + 1)]
    if total > 0:
        targets = [t for t in targets if t < total]
    if len(targets) < 2:
        raise SystemExit(f"[BENCH] Video terlalu pendek untuk --start {start} --frames {count}")

    # Cara backend sekarang: lewati frame dengan grab(), lalu read()
    cap.set(cv2.CAP_PROP_POS_FRAMES, targets[0])
    cap.read()
    pos = targets[0] + 1
    frames, grab_ms = [], []
    for tg in targets[1:]:
        t0 = time.perf_counter()
        while pos < tg:
            if not cap.grab():
                break
            pos += 1
        ok, fr = cap.read()
        pos += 1
        grab_ms.append((time.perf_counter() - t0) * 1000.0)
        if not ok:
            break
        frames.append(fr)

    # Cara lama: cap.set() ke frame target (seek) lalu read() — hanya pembanding
    seek_ms = []
    for tg in targets[1:len(frames) + 1]:
        t0 = time.perf_counter()
        cap.set(cv2.CAP_PROP_POS_FRAMES, tg)
        ok, _ = cap.read()
        seek_ms.append((time.perf_counter() - t0) * 1000.0)
        if not ok:
            break
    cap.release()
    if not frames:
        raise SystemExit(f"[BENCH] Tidak ada frame yang terbaca dari {path}")
    return frames, fps, stats(grab_ms), stats(seek_ms)


# ══════════════════════════════════════════════════════════════
# RUNTIME MODEL
# ══════════════════════════════════════════════════════════════
def runtime_of(path: Path) -> str:
    if path.is_dir() or path.suffix.lower() == ".xml":
        return "openvino"
    if path.suffix.lower() == ".onnx":
        return "onnxruntime"
    return "pytorch"


def runtime_available(runtime: str, vers: dict) -> str | None:
    """Return None kalau siap, atau pesan kenapa model ini dilewati."""
    if runtime == "openvino" and not vers.get("openvino"):
        return "paket openvino belum ter-install (pip install openvino)"
    if runtime == "onnxruntime" and not vers.get("onnxruntime"):
        return "paket onnxruntime belum ter-install (pip install onnxruntime onnx)"
    if runtime == "onnxruntime" and not vers.get("onnx"):
        return "paket onnx belum ter-install (pip install onnx)"
    return None


def force_runtime_threads(threads: int, runtime: str) -> None:
    """
    --threads untuk runtime non-PyTorch. Ultralytics tidak punya argumen
    jumlah thread untuk OpenVINO / ONNX Runtime, jadi konfigurasinya
    disisipkan saat model di-compile / sesi dibuat. Hanya aktif kalau
    --threads diberikan dan paketnya ada. Dipanggil sekali per runtime, tepat
    sebelum model pertamanya diuji (bukan di awal skrip: meng-import runtime
    itu saja sudah bisa mematikan proses di CPU yang tidak didukungnya).
    """
    try:
        if runtime == "openvino":
            import openvino as ov
            _compile = ov.Core.compile_model

            def compile_model(self, model, device_name=None, config=None, **kw):
                config = dict(config or {})
                config["INFERENCE_NUM_THREADS"] = threads
                return _compile(self, model, device_name, config, **kw)

            ov.Core.compile_model = compile_model
        elif runtime == "onnxruntime":
            import onnxruntime as ort
            _Session = ort.InferenceSession

            def session(path, sess_options=None, providers=None, **kw):
                so = sess_options or ort.SessionOptions()
                so.intra_op_num_threads = threads
                return _Session(path, so, providers=providers, **kw)

            ort.InferenceSession = session
    except Exception:
        pass


def runtime_threads(model, runtime: str, torch, forced=None):
    """
    Jumlah thread yang dipakai runtime (None = default runtime, tidak diketahui).
    Perangkat OpenVINO "AUTO" (yang dipakai Ultralytics) meneruskan
    INFERENCE_NUM_THREADS ke CPU tetapi tidak bisa ditanya balik; di situ
    yang dilaporkan adalah nilai --threads yang diminta (forced).
    """
    try:
        backend = model.predictor.model
        if runtime == "openvino":
            return int(backend.ov_compiled_model.get_property("INFERENCE_NUM_THREADS"))
        if runtime == "onnxruntime":
            n = int(backend.session.get_session_options().intra_op_num_threads)
            return n or None        # 0 = otomatis (jumlah core fisik)
    except Exception:
        return forced
    return torch.get_num_threads()


def runtime_device(model, runtime: str) -> str:
    """Perangkat yang benar-benar menjalankan model (OpenVINO 'AUTO' bisa memilih GPU Intel)."""
    try:
        backend = model.predictor.model
        if runtime == "openvino":
            return ",".join(backend.ov_compiled_model.get_property("EXECUTION_DEVICES"))
        if runtime == "onnxruntime":
            return backend.session.get_providers()[0].replace("ExecutionProvider", "")
    except Exception:
        return "?"
    return "CPU"


# ══════════════════════════════════════════════════════════════
# BENCHMARK SATU MODEL
# ══════════════════════════════════════════════════════════════
def bench_model(YOLO, torch, model_path: Path, runtime: str, frames, args, overhead_ms: float):
    print(f"\n[BENCH] Memuat {model_path} ({runtime}) ...")
    model = YOLO(str(model_path), task="detect")
    use_track = args.tracker.lower() != "none"
    shapes: list = []
    hooked = False
    rows = []
    fh, fw = frames[0].shape[:2]

    def call(frame, imgsz):
        if use_track:
            return model.track(source=frame, imgsz=imgsz, conf=VEHICLE_CONF, iou=IOU,
                               persist=True, tracker=args.tracker, verbose=False)
        return model.predict(source=frame, imgsz=imgsz, conf=VEHICLE_CONF, iou=IOU, verbose=False)

    for imgsz in args.sizes:
        try:
            for i in range(WARMUP_CALLS):
                call(frames[i % len(frames)], imgsz)
        except Exception as e:
            print(f"[BENCH]   imgsz {imgsz}: GAGAL ({type(e).__name__}: {str(e)[:160]})")
            rows.append({"model": str(model_path), "runtime": runtime, "imgsz": imgsz, "error": str(e)[:300]})
            continue

        # Catat ukuran tensor yang benar-benar masuk ke model
        if not hooked:
            try:
                predictor = model.predictor
                original  = predictor.preprocess

                def preprocess(im, _original=original):
                    out = _original(im)
                    shapes.append(f"{int(out.shape[2])}x{int(out.shape[3])}")
                    return out

                predictor.preprocess = preprocess
            except Exception:
                pass
            hooked = True

        # Ultralytics mengatur ulang jumlah thread PyTorch saat predictor dibuat,
        # jadi --threads baru dipasang SETELAH warm-up.
        if args.threads:
            torch.set_num_threads(args.threads)

        shapes.clear()
        times, ndet = [], []
        for frame in frames:
            t0 = time.perf_counter()
            res = call(frame, imgsz)
            times.append((time.perf_counter() - t0) * 1000.0)
            boxes = res[0].boxes
            ndet.append(len(boxes) if boxes is not None else 0)

        st = stats(times)
        hw = max(set(shapes), key=shapes.count) if shapes else "~" + expected_hw(fh, fw, imgsz)
        device = runtime_device(model, runtime)
        row = {
            "model": str(model_path), "runtime": runtime, "imgsz": imgsz, "input_hw": hw,
            "threads_torch": torch.get_num_threads(),
            # --threads hanya berarti di CPU; kalau AUTO memilih GPU, kolom thread tetap "auto"
            "threads_runtime": runtime_threads(model, runtime, torch, args.threads if device == "CPU" else None),
            "perangkat": device,
            "median_ms": st["median"], "p90_ms": st["p90"], "min_ms": st["min"], "n": st["n"],
            "deteksi_per_frame": round(sum(ndet) / len(ndet), 2),
            "detik_per_tick": round((st["median"] + overhead_ms) / 1000.0, 3),
        }
        rows.append(row)
        print(f"[BENCH]   imgsz {imgsz:>4} ({hw:>9}) : median {st['median']:>8.1f} ms | "
              f"p90 {st['p90']:>8.1f} ms | {row['detik_per_tick']:.2f} detik/tick"
              + ("" if row["perangkat"] == "CPU" else f" | perangkat: {row['perangkat']}"))

        # Tracker dikosongkan antar ukuran supaya tiap ukuran mulai dari keadaan yang sama
        try:
            for tr in getattr(model.predictor, "trackers", []) or []:
                tr.reset()
        except Exception:
            pass
    return rows


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════
def main():
    _safe_stdout()
    args = parse_args()
    line = "═" * 78

    print(line)
    print(" BENCHMARK INFERENSI — Illegal Parking Detection")
    print(line)

    info = machine_info()
    vers = package_versions()

    import cv2
    import torch
    from ultralytics import YOLO

    try:
        info["torch_capability"] = torch.backends.cpu.get_cpu_capability()
    except Exception:
        info["torch_capability"] = None

    def yn(v):
        return "?" if v is None else ("ya" if v else "TIDAK")

    print(f" CPU        : {info['nama']}")
    print(f" Core       : {info.get('cpu_fisik') or '?'} fisik / {info['cpu_logis']} logis"
          + (f" @ ~{info['mhz']} MHz" if info.get("mhz") else ""))
    print(f" Instruksi  : SSE4.2 {yn(info['sse4_2'])} | AVX {yn(info['avx'])} | "
          f"AVX2 {yn(info['avx2'])} | AVX-512F {yn(info['avx512f'])} | PyTorch pakai: {info['torch_capability']}")
    if info.get("ram_total_gb"):
        print(f" RAM        : {info['ram_total_gb']} GB total, {info['ram_tersedia_gb']} GB tersedia")
    print(f" OS         : {info['os']}")
    print(" Paket      : " + ", ".join(f"{k} {v}" for k, v in vers.items() if v))
    missing = [k for k in ("openvino", "onnxruntime") if not vers.get(k)]
    if missing:
        print(f" (opsional, tidak ter-install: {', '.join(missing)})")
    print(line)

    # ── Frame uji + biaya non-inferensi ───────────────────────
    frames, fps, grab_st, seek_st = load_frames(cv2, args.video, args.start, args.frames)
    h, w = frames[0].shape[:2]
    jpeg_ms = []
    for frame in frames:
        t0 = time.perf_counter()
        cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        jpeg_ms.append((time.perf_counter() - t0) * 1000.0)
    jpeg_st = stats(jpeg_ms)
    overhead_ms = grab_st["median"] + jpeg_st["median"]

    print(f" Video      : {args.video} ({w}x{h} @ {fps:.2f} fps), {len(frames)} frame berjarak 1 detik")
    print(f" Ambil frame: grab+read {grab_st['median']} ms/tick (cara backend) | "
          f"seek+read {seek_st['median']} ms/tick (cara lama)")
    print(f" JPEG q{JPEG_QUALITY}   : {jpeg_st['median']} ms/frame")
    print(f" Tracker    : {args.tracker}")
    print(f" Thread     : {'default' if not args.threads else args.threads} "
          f"(default PyTorch di mesin ini = min(8, CPU logis - 1) = "
          f"{min(8, max(1, (os.cpu_count() or 1) - 1))})")

    # ── JSON: ditulis ulang sebelum tiap model diuji ──────────
    # Runtime hasil export bisa mematikan proses secara paksa di CPU yang tidak
    # didukungnya ("Illegal instruction" / kode 0xC000001D). Itu tidak bisa
    # ditangkap try/except, jadi hasil model sebelumnya harus sudah tersimpan.
    out_name = args.out or f"benchmark_inference_{time.strftime('%Y%m%d_%H%M%S')}.json"
    out_path = Path.cwd() / out_name
    results = []
    payload = {
        "waktu": time.strftime("%Y-%m-%d %H:%M:%S"),
        "cpu": info,
        "versi": vers,
        "argumen": {"video": args.video, "model": args.model, "sizes": args.sizes,
                    "frames": args.frames, "threads": args.threads, "tracker": args.tracker},
        "video": {"lebar": w, "tinggi": h, "fps": round(fps, 3), "frame_diukur": len(frames)},
        "baca_frame_grab_ms": grab_st,
        "baca_frame_seek_ms": seek_st,
        "jpeg_q78_ms": jpeg_st,
        "hasil": results,
    }

    def save() -> None:
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    # ── Benchmark tiap model ──────────────────────────────────
    forced = set()      # runtime yang --threads-nya sudah dipasang
    for raw in args.model:
        save()
        path = Path(raw)
        if not path.exists():
            print(f"\n[BENCH] {raw}: tidak ditemukan, dilewati.")
            results.append({"model": raw, "error": "tidak ditemukan"})
            continue
        runtime = runtime_of(path)
        reason  = runtime_available(runtime, vers)
        if reason:
            print(f"\n[BENCH] {raw}: dilewati — {reason}.")
            results.append({"model": raw, "runtime": runtime, "error": reason})
            continue
        if runtime != "pytorch":
            print(f"\n[BENCH] Catatan: kalau proses berhenti mendadak saat menguji {path.name} "
                  f"(Illegal instruction / kode 0xC000001D),\n"
                  f"        runtime {runtime} tidak cocok dengan CPU ini: tetap pakai model .pt. "
                  f"Hasil sejauh ini sudah ada di {out_path.name}.")
            if args.threads and runtime not in forced:
                forced.add(runtime)
                force_runtime_threads(args.threads, runtime)
        try:
            results += bench_model(YOLO, torch, path, runtime, frames, args, overhead_ms)
        except Exception as e:
            print(f"[BENCH] {raw}: GAGAL ({type(e).__name__}: {str(e)[:200]})")
            results.append({"model": raw, "runtime": runtime, "error": f"{type(e).__name__}: {str(e)[:300]}"})

    # ── Tabel ringkasan ───────────────────────────────────────
    ok_rows = [r for r in results if "median_ms" in r]
    print("\n" + line)
    print(" HASIL  (median per panggilan .track(); detik/tick = median + ambil frame + JPEG)")
    print(line)
    print(f" {'model':<28} {'runtime':<11} {'imgsz':>5} {'tensor':>9} {'thr':>5} "
          f"{'median ms':>10} {'p90 ms':>9} {'detik/tick':>10}")
    print(" " + "─" * 76)
    for r in ok_rows:
        thr = r["threads_runtime"] if r["threads_runtime"] else "auto"
        print(f" {Path(r['model']).name[:28]:<28} {r['runtime']:<11} {r['imgsz']:>5} {r['input_hw']:>9} "
              f"{str(thr):>5} {r['median_ms']:>10.1f} {r['p90_ms']:>9.1f} {r['detik_per_tick']:>10.2f}")
    print(" " + "─" * 76)
    if ok_rows:
        best = min(ok_rows, key=lambda r: r["median_ms"])
        print(f" Tercepat: {Path(best['model']).name} imgsz {best['imgsz']} "
              f"→ {best['detik_per_tick']:.2f} detik/tick")
    print()
    print(" Cara membaca:")
    print("  • Untuk FILE VIDEO satu tick = satu detik video (PARKING_TICK_STEP=1).")
    print("    detik/tick <= 1.0  → pemrosesan mengikuti kecepatan asli video.")
    print("    detik/tick  > 1.0  → video di dashboard berjalan lebih lambat dari aslinya;")
    print("    PARKING_TICK_STEP=2 (atau 3) membagi dua (tiga) pekerjaan per detik video.")
    print("  • Untuk KAMERA satu tick = satu frame; dashboard mendapat ~1/(detik/tick) frame per detik.")
    print("  • Angka ini belum termasuk model segitiga (sesekali) dan menggambar/anotasi (beberapa ms).")
    print("  • imgsz lebih kecil = lebih cepat, tetapi kendaraan kecil/jauh bisa tidak terdeteksi.")

    # ── JSON (versi akhir) ────────────────────────────────────
    save()
    print(f"\n[BENCH] Hasil lengkap disimpan ke: {out_path}")


if __name__ == "__main__":
    main()
