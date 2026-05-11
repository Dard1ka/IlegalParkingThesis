// ─── Status config ────────────────────────────────────────────
const STATUS = {
  violation: {
    label:  'Pelanggaran',
    emoji:  '🚨',
    color:  'var(--red)',
    bg:     'rgba(248,113,113,0.06)',
    border: 'rgba(248,113,113,0.2)',
    strip:  'var(--red)',
    pulse:  true,
  },
  warning: {
    label:  'Peringatan',
    emoji:  '⚠️',
    color:  'var(--amber)',
    bg:     'rgba(251,191,36,0.05)',
    border: 'rgba(251,191,36,0.18)',
    strip:  'var(--amber)',
    pulse:  false,
  },
  safe: {
    label:  'Aman',
    emoji:  '✅',
    color:  'var(--green)',
    bg:     'rgba(74,222,128,0.05)',
    border: 'rgba(74,222,128,0.18)',
    strip:  'var(--green)',
    pulse:  false,
  },
  monitoring: {
    label:  'Memantau',
    emoji:  '👁',
    color:  'var(--text-dim)',
    bg:     'rgba(255,255,255,0.02)',
    border: 'var(--edge)',
    strip:  'var(--edge-bright)',
    pulse:  false,
  },
}

const VEHICLE_ICON  = { car: '🚗', truck: '🚛', bus: '🚌', motorcycle: '🏍️', motor: '🏍️' }
const VEHICLE_LABEL = { car: 'Mobil', truck: 'Truk', bus: 'Bus', motorcycle: 'Motor', motor: 'Motor' }

const COLOR_MAP = {
  black: '#374151', white: '#f9fafb', gray: '#9ca3af', red: '#f87171',
  orange: '#fb923c', yellow: '#facc15', brown: '#92400e', green: '#4ade80',
  cyan: '#22d3ee', blue: '#60a5fa', purple: '#a78bfa', pink: '#f472b6',
}

function fmt(s) {
  if (s >= 3600) return `${Math.floor(s/3600)}j ${Math.floor((s%3600)/60)}m`
  if (s >= 60) return `${Math.floor(s/60)}m ${s%60}s`
  return `${s}s`
}

// ─── Alert Card ───────────────────────────────────────────────
function AlertCard({ alert, index }) {
  const cfg = STATUS[alert.status] ?? STATUS.monitoring
  const vehicleColor = COLOR_MAP[alert.color?.toLowerCase()] ?? null

  return (
    <div
      className={`alert-enter relative rounded-2xl overflow-hidden ${cfg.pulse ? 'violation-pulse' : ''}`}
      style={{
        background:         cfg.bg,
        border:             `1px solid ${cfg.border}`,
        animationDelay:     `${index * 40}ms`,
      }}
    >
      {/* Left strip */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-full" style={{ background: cfg.strip }} />

      <div className="pl-4 pr-3 py-3 flex gap-3 items-start">
        {/* Icon block */}
        <div className="shrink-0 flex flex-col items-center gap-1.5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--edge)' }}
          >
            {VEHICLE_ICON[alert.type?.toLowerCase()] ?? '🚗'}
          </div>
          {/* Color dot */}
          {vehicleColor && (
            <div
              className="w-3 h-3 rounded-full ring-1 ring-black/20"
              style={{ background: vehicleColor }}
              title={alert.color}
            />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="font-semibold text-sm leading-tight" style={{ color: 'var(--text)' }}>
              {VEHICLE_LABEL[alert.type?.toLowerCase()] ?? alert.type}
              {alert.color && alert.color !== 'Unknown'
                ? <span className="font-normal ml-1" style={{ color: 'var(--text-dim)' }}>· {alert.color}</span>
                : null
              }
            </p>
            <span
              className="text-[9px] font-semibold px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1"
              style={{
                color:      cfg.color,
                background: cfg.bg,
                border:     `1px solid ${cfg.border}`,
              }}
            >
              {cfg.emoji} {cfg.label}
            </span>
          </div>

          {/* Meta row */}
          <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span className="font-mono">{alert.lid}</span>
            <span>·</span>
            <span>Zona {alert.zone}</span>
            {alert.triangle && (
              <>
                <span>·</span>
                <span style={{ color: 'var(--green)' }}>◆ Segitiga</span>
              </>
            )}
          </div>

          {/* Duration */}
          <div className="flex items-center gap-2 mt-2">
            <div
              className="flex-1 h-1 rounded-full overflow-hidden"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-1000"
                style={{
                  width: `${Math.min(100, (alert.duration / 300) * 100)}%`,
                  background: cfg.color,
                  opacity: 0.7,
                }}
              />
            </div>
            <span className="font-mono text-xs font-bold shrink-0" style={{ color: cfg.color }}>
              {fmt(alert.duration)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-40 gap-3 py-10">
      <span className="text-3xl opacity-40">🔍</span>
      <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
        Belum ada kendaraan terdeteksi di zona pantau
      </p>
    </div>
  )
}

// ─── Sidebar root ─────────────────────────────────────────────
export default function AlertSidebar({ alerts = [] }) {
  const violations = alerts.filter(a => a.status === 'violation').length
  const warnings   = alerts.filter(a => a.status === 'warning').length
  const safe       = alerts.filter(a => a.status === 'safe').length
  const monitoring = alerts.filter(a => a.status === 'monitoring').length

  const sorted = [...alerts].sort((a, b) => {
    const order = { violation: 0, warning: 1, monitoring: 2, safe: 3 }
    return (order[a.status] ?? 9) - (order[b.status] ?? 9)
  })

  const segments = [
    { count: violations, color: 'var(--red)' },
    { count: warnings,   color: 'var(--amber)' },
    { count: monitoring, color: 'var(--edge-bright)' },
    { count: safe,       color: 'var(--green)' },
  ].filter(s => s.count > 0)

  return (
    <div className="flex flex-col h-full gap-3">

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <span className="text-[10px] font-mono tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>
          Event Log
        </span>
        <div className="flex items-center gap-2 text-[10px] font-mono">
          {violations > 0 && <span style={{ color: 'var(--red)' }}>{violations} 🚨</span>}
          {warnings   > 0 && <span style={{ color: 'var(--amber)' }}>{warnings} ⚠️</span>}
          {safe       > 0 && <span style={{ color: 'var(--green)' }}>{safe} ✅</span>}
        </div>
      </div>

      {/* Progress bar */}
      {alerts.length > 0 && (
        <div className="shrink-0 h-1 rounded-full overflow-hidden flex gap-0.5" style={{ background: 'var(--edge)' }}>
          {segments.map((s, i) => (
            <div key={i} className="h-full rounded-full transition-all duration-700"
              style={{ width: `${(s.count / alerts.length) * 100}%`, background: s.color }} />
          ))}
        </div>
      )}

      {/* Cards */}
      <div className="flex-1 overflow-y-auto space-y-2 scroll-thin" style={{ minHeight: 0 }}>
        {alerts.length === 0
          ? <EmptyState />
          : sorted.map((alert, i) => <AlertCard key={alert.id} alert={alert} index={i} />)
        }
      </div>

      {/* Footer */}
      <div
        className="shrink-0 flex items-center justify-between pt-2 border-t"
        style={{ borderColor: 'var(--edge)' }}
      >
        <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
          {alerts.length} kendaraan terpantau
        </span>
        <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
          Refresh setiap 1 detik
        </span>
      </div>
    </div>
  )
}
