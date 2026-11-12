import { useState, useEffect, useRef, useCallback } from 'react'
import VideoMonitor from './components/VideoMonitor'
import AlertSidebar from './components/AlertSidebar'
import SetupWizard from './components/SetupWizard'
import { Rambu, FaultGlyph } from './components/Glyphs'
import { useAlerts } from './hooks/useAlerts'
import { API_BASE } from './config'

// Catatan render: mini PC menggambar semua frame dengan CPU (tanpa GPU), jadi
// header ini hanya berisi warna datar, garis 1 px, teks, dan SVG kecil. Yang
// di-repaint tiap detik cukup teks jam dan, selama keadaan tunggu, angka detik
// di status sistem.

// ─── Jam ──────────────────────────────────────────────────────
// Diformat manual (bukan toLocale*) supaya hasilnya sama di semua browser:
// jam memakai titik "21.26.14", tanggal "Rabu, 14 Okt".
const HARI  = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
const pad2  = (n) => String(n).padStart(2, '0')

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const hh = pad2(now.getHours())
  const mm = pad2(now.getMinutes())
  const ss = pad2(now.getSeconds())
  // .clock memakai contain: layout paint, jadi update tiap detik tidak ikut
  // memicu repaint elemen header di sekitarnya
  return (
    <div className="clock">
      <span className="clock-date">{`${HARI[now.getDay()]}, ${now.getDate()} ${BULAN[now.getMonth()]}`}</span>
      <time className="clock-time" dateTime={`${hh}:${mm}:${ss}`}>{`${hh}.${mm}.${ss}`}</time>
    </div>
  )
}

// ─── Status processor (field "proc" dari WebSocket, boleh tidak ada) ──
// Pesan error processor, atau null kalau processor normal
function getProcError(proc) {
  if (!proc || (proc.state !== 'error' && !proc.error)) return null
  return proc.error || 'penyebab tidak diketahui'
}

// Lama proses tick terakhir: 2400 ms → "2,4 dtk/tick", 570 ms → "570 ms/tick"
function formatTick(proc) {
  const ms = proc?.tick_ms
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)} ms/tick`
  const seconds = (ms / 1000).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${seconds} dtk/tick`
}

// proc.state ke teks status. `waiting` = keadaan tunggu yang diberi penghitung
// detik; `strong` = ditulis dengan warna teks utama. State "error" tidak perlu
// ada di sini: getProcError() selalu mengembalikan pesan untuk state itu.
const PROC_STATE = {
  loading_models: { label: 'Memuat model deteksi',  waiting: true },
  waiting_source: { label: 'Menunggu sumber video', waiting: true },
  opening_source: { label: 'Membuka sumber video',  waiting: true },
  waiting_roi:    { label: 'Menunggu zona',         waiting: true },
  running:        { label: 'Deteksi berjalan' },
  paused:         { label: 'Deteksi ditunda selama video diunggah', waiting: true },
  reconnecting:   { label: 'Kamera terputus, menyambung ulang', waiting: true },
  stopped:        { label: 'Deteksi berhenti', strong: true },
}
const PROC_UNKNOWN = { label: 'Status deteksi belum diketahui' }

// hasOwnProperty: state aneh dari backend (mis. "toString") tidak ikut terbaca
function getProcInfo(state) {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(PROC_STATE, state)
    ? PROC_STATE[state]
    : PROC_UNKNOWN
}

// ─── Status sistem ────────────────────────────────────────────
// Teks keadaan tunggu + detik sejak keadaan itu dimulai. Komponen dipasang
// ulang (key = proc.state) setiap keadaannya berganti, jadi waktu mulainya
// cukup disimpan di ref, dan interval 1 dtk hanya hidup selama keadaan tunggu.
function WaitingStatus({ label }) {
  const startedAt = useRef(Date.now())
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))
  // Teks dibungkus satu span: .sys-status berupa flex dengan gap, jadi potongan
  // teks lepas akan terpisah 8 px satu sama lain
  return (
    <div className="sys-status text-text">
      <span className="min-w-0 truncate">{label} (<span className="tnum">{seconds}</span> dtk)</span>
    </div>
  )
}

// Teks biasa, tanpa pil atau titik. Gangguan saja yang memakai pelat.
function SystemStatus({ connected, error, procError, procState }) {
  if (!connected) {
    return (
      <div className="sys-status" title={error || undefined}>
        <span className="plate-fault"><FaultGlyph />Terputus dari server deteksi</span>
        <span className="sys-status-hint">Menyambung ulang setiap 3 detik.</span>
      </div>
    )
  }
  if (procError) {
    return (
      <div className="sys-status">
        <span className="plate-fault" title={`Processor berhenti: ${procError}`}><FaultGlyph />Processor berhenti</span>
      </div>
    )
  }
  const info = getProcInfo(procState)
  if (info.waiting) return <WaitingStatus key={procState} label={info.label} />
  return (
    <div className={info.strong ? 'sys-status text-text' : 'sys-status'}>
      <span className="min-w-0 truncate">{info.label}</span>
    </div>
  )
}

// ─── Label setup (dari info wizard, boleh tidak ada) ──────────
// Nama sumber untuk toolbar video: "Kamera 0", "Kamera IP 192.168.1.64:554", atau nama file video
function getSourceLabel(setup) {
  if (setup?.sourceType === 'camera') return setup.camIndex != null ? `Kamera ${setup.camIndex}` : 'Kamera'
  if (setup?.sourceType === 'rtsp') return setup.host ? `Kamera IP ${setup.host}` : 'Kamera IP'
  if (setup?.sourceType === 'video') {
    if (setup.filename) return String(setup.filename)
    if (typeof setup.path === 'string') return setup.path.split(/[\\/]/).pop() || null
  }
  return null
}

// Jumlah zona aktif, null = tidak diketahui. Seluruh frame dihitung satu zona
// (backend membuat satu poligon selebar frame untuk roi_mode "auto").
function getZoneCount(zone) {
  if (zone?.roiMode === 'auto') return 1
  if (zone?.roiMode === 'manual' && Number.isInteger(zone.zoneCount) && zone.zoneCount > 0) return zone.zoneCount
  return null
}

// Nilai "Zona" di toolbar video
function getZoneValue(zone) {
  if (zone?.roiMode === 'auto') return 'Seluruh frame'
  if (zone?.roiMode === 'manual') {
    const n = getZoneCount(zone)
    return n !== null ? `${n} zona digambar` : 'Digambar'
  }
  return null
}

// ─── Main Dashboard ───────────────────────────────────────────
function Dashboard({ onReconfigure, setup = null }) {
  const { alerts, connected, error, proc } = useAlerts()
  const procError = getProcError(proc)

  // Zona yang disimpan lewat dialog "Ubah zona…" menggantikan zona dari wizard.
  // useCallback: VideoMonitor di-memo, jadi callback-nya harus tetap sama.
  const [savedZones, setSavedZones] = useState(null)
  const handleZonesSaved = useCallback((n) => setSavedZones({ roiMode: 'manual', zoneCount: n }), [])
  const zone      = savedZones ?? setup
  const zoneCount = getZoneCount(zone)
  // "Zona n" di baris kendaraan hanya kalau zonanya lebih dari satu
  const multiZone = zoneCount !== null
    ? zoneCount > 1
    : new Set(alerts.map((a) => a.zone)).size > 1

  // Kapan WebSocket terputus (dari tersambung ke putus); dihapus lagi saat tersambung
  // ulang. Disesuaikan saat render, bukan di effect, supaya daftar langsung
  // tampil basi pada render yang sama dengan putusnya koneksi.
  const [staleSince, setStaleSince] = useState(null)
  const [prevConnected, setPrevConnected] = useState(connected)
  if (connected !== prevConnected) {
    setPrevConnected(connected)
    setStaleSince(connected ? null : new Date())
  }

  // Diturunkan dari alerts (bukan stats) supaya pelat dan daftar selalu sama.
  // Saat terputus datanya basi: rambu kembali diam dan pelat disembunyikan.
  const violationCount = alerts.filter((a) => a.status === 'violation').length
  const alarm = connected && violationCount > 0

  // Nama kelas anak langsung .app-header jangan diganti: tata letak header
  // ringkas (<1100 px) disusun ulang di index.css lewat `order`.
  return (
    <div className="dash">
      <header className="app-header">
        <h1 className="brand"><Rambu lit={alarm} />Parking Guard</h1>
        {alarm && <span className="plate-alarm">{`${violationCount} pelanggaran`}</span>}
        <SystemStatus
          connected={connected}
          error={error}
          procError={procError}
          procState={proc?.state ?? null}
        />
        <div className="app-header-spacer" />
        <button type="button" className="btn btn-sm" onClick={onReconfigure}>Ganti sumber…</button>
        <div className="app-header-divider" aria-hidden="true" />
        <Clock />
      </header>

      <main className="dash-body">
        <VideoMonitor
          connected={connected}
          procError={procError}
          tickLabel={formatTick(proc)}
          tickCount={proc?.tick ?? null}
          sourceLabel={getSourceLabel(setup)}
          zoneValue={getZoneValue(zone)}
          onZonesSaved={handleZonesSaved}
        />
        <AlertSidebar
          alerts={alerts}
          multiZone={multiZone}
          connected={connected}
          staleSince={staleSince}
        />
      </main>

      {/* Pembaca layar diberi tahu saat koneksi benar-benar putus (staleSince
          diisi pada transisi tersambung → putus, bukan saat menyambung pertama
          kali). Selalu terpasang; hanya teksnya yang berubah. Di luar <header>
          supaya aturan urutan header versi sempit tidak berlaku padanya. */}
      <div className="sr-only" role="status">
        {!connected && staleSince ? 'Terputus dari server deteksi. Daftar kendaraan tidak diperbarui.' : ''}
      </div>
    </div>
  )
}

// ─── Sesi kamera yang sedang berjalan (GET /status) ──────────
// Halaman dimuat ulang (atau browser dibuka lagi) saat backend masih memantau
// kamera: dashboard langsung tampil tanpa wizard, supaya sesi (kendaraan dan
// durasinya) tidak diulang dari nol karena kamera dipilih lagi.
const RESUME_STATES = new Set(['running', 'reconnecting', 'opening_source'])
const STATUS_TIMEOUT_MS = 2500

// "rtsp://admin:***@192.168.1.64:554/Streaming/..." → "192.168.1.64:554"
function rtspHost(url) {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?([^/]+)/i.exec(String(url || ''))
  return m ? m[1] : null
}

// Info "setup" dari /status, atau null bila tidak ada sesi kamera yang berjalan
function liveSetupFromStatus(status) {
  const src = status?.source
  if (!status?.running || !src || !RESUME_STATES.has(status?.proc?.state)) return null
  const roiMode = status.roi_mode === 'manual' ? 'manual' : 'auto'
  const zoneCount = Number.isInteger(status.session?.zones) ? status.session.zones : undefined
  if (src.type === 'rtsp') return { sourceType: 'rtsp', host: rtspHost(src.url), roiMode, zoneCount }
  if (src.type === 'camera') return { sourceType: 'camera', camIndex: src.index ?? 0, roiMode, zoneCount }
  return null
}

// ─── Root ─────────────────────────────────────────────────────
export default function App() {
  // "checking" = cek sesi kamera yang sedang berjalan, "setup" = tampil wizard,
  // "dashboard" = tampil main UI
  const [view, setView] = useState('checking')
  // Info dari wizard ({ sourceType, path/filename | camIndex | url/host, roiMode, zoneCount? }), boleh null
  const [setup, setSetup] = useState(null)

  useEffect(() => {
    let alive = true
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS)
    fetch(`${API_BASE}/status`, { cache: 'no-store', signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((status) => {
        if (!alive) return
        const live = liveSetupFromStatus(status)
        if (live) setSetup(live)
        setView(live ? 'dashboard' : 'setup')
      })
      .finally(() => clearTimeout(timer))
    return () => { alive = false; ctrl.abort(); clearTimeout(timer) }
  }, [])

  if (view === 'checking') return null

  // Dashboard sengaja di-UNMOUNT saat kembali ke wizard: WebSocket & koneksi
  // MJPEG ikut ditutup (jangan diganti jadi overlay di atas dashboard).
  return view === 'setup'
    ? <SetupWizard onComplete={(info) => { setSetup(info ?? null); setView('dashboard') }} />
    : <Dashboard onReconfigure={() => setView('setup')} setup={setup} />
}
