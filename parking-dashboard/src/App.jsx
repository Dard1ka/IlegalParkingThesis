import { useState, useEffect } from 'react'
import VideoMonitor from './components/VideoMonitor'
import AlertSidebar from './components/AlertSidebar'
import SetupWizard from './components/SetupWizard'
import { useAlerts } from './hooks/useAlerts'

// ─── Live Clock ───────────────────────────────────────────────
function LiveClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="text-right select-none hidden sm:block">
      <div className="font-mono text-sm tracking-widest glow-cyan" style={{ color: 'var(--cyan)' }}>
        {now.toLocaleTimeString('id-ID', { hour12: false })}
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
        {now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' })}
      </div>
    </div>
  )
}

// ─── Metric Card — lebih minimal, lebih breathable ────────────
function MetricCard({ title, value, icon, accentColor, softBg }) {
  return (
    <div
      className="flex-1 rounded-2xl px-4 py-4 flex items-center gap-3"
      style={{
        background: softBg,
        border: `1px solid ${accentColor}25`,
      }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
        style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}20` }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div
          className="font-mono text-3xl font-bold leading-none stat-enter"
          style={{ color: accentColor }}
        >
          {String(value).padStart(2, '0')}
        </div>
        <p className="text-[11px] mt-1 leading-tight truncate" style={{ color: 'var(--text-dim)' }}>
          {title}
        </p>
      </div>
    </div>
  )
}

// ─── Connection badge ─────────────────────────────────────────
function ConnectionBadge({ connected, error }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-full"
      style={{
        background: connected ? 'rgba(34,211,238,0.06)' : 'rgba(248,113,113,0.06)',
        border: `1px solid ${connected ? 'rgba(34,211,238,0.2)' : 'rgba(248,113,113,0.2)'}`,
      }}
      title={!connected ? (error || 'Mencoba reconnect...') : 'Terhubung'}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? 'live-dot' : 'animate-pulse'}`}
        style={{ background: connected ? 'var(--cyan)' : 'var(--red)' }}
      />
      <span
        className="font-mono text-[10px] tracking-widest uppercase"
        style={{ color: connected ? 'var(--cyan)' : 'var(--red)' }}
      >
        {connected ? 'Live' : 'Offline'}
      </span>
    </div>
  )
}

// ─── Reconfigure button ───────────────────────────────────────
function ReconfigureBtn({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono tracking-wide uppercase transition-all duration-150"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--edge)',
        color: 'var(--text-dim)',
      }}
      title="Ganti sumber / konfigurasi ulang"
    >
      ⚙ Ganti Setup
    </button>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────
function Dashboard({ onReconfigure }) {
  const { alerts, stats, connected, error } = useAlerts()

  return (
    <div
      className="h-screen flex flex-col bg-noise select-none"
      style={{ background: 'var(--void)' }}
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <header
        className="shrink-0 flex items-center justify-between px-5 py-3 border-b"
        style={{
          background: 'rgba(8,9,15,0.9)',
          borderColor: 'var(--edge)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center text-base shrink-0"
            style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.2)' }}
          >
            🅿️
          </div>
          <div>
            <h1 className="font-bold text-sm" style={{ color: 'var(--text)' }}>
              Parking Guard
            </h1>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Deteksi parkir liar real-time
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ReconfigureBtn onClick={onReconfigure} />
          <ConnectionBadge connected={connected} error={error} />
          <LiveClock />
        </div>
      </header>

      {/* ── Metric cards ────────────────────────────────────── */}
      <div className="shrink-0 flex gap-3 px-5 py-3">
        <MetricCard
          title="Kendaraan terpantau"
          value={stats.total}
          icon="🚗"
          accentColor="var(--cyan)"
          softBg="rgba(34,211,238,0.04)"
        />
        <MetricCard
          title="Peringatan (60–300s)"
          value={stats.warning}
          icon="⚠️"
          accentColor="var(--amber)"
          softBg="rgba(251,191,36,0.04)"
        />
        <MetricCard
          title="Pelanggaran (>300s)"
          value={stats.violation}
          icon="🚨"
          accentColor="var(--red)"
          softBg="rgba(248,113,113,0.04)"
        />
      </div>

      {/* ── Main content ─────────────────────────────────────── */}
      <div className="flex flex-1 gap-3 px-5 pb-5 min-h-0">
        <div className="flex-[7] min-w-0">
          <VideoMonitor />
        </div>
        <div className="flex-[3] min-w-0">
          <AlertSidebar alerts={alerts} />
        </div>
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────
export default function App() {
  // "setup" = tampil wizard, "dashboard" = tampil main UI
  const [view, setView] = useState('setup')

  return view === 'setup'
    ? <SetupWizard onComplete={() => setView('dashboard')} />
    : <Dashboard  onReconfigure={() => setView('setup')} />
}
