import { memo, useRef, useState, useEffect, useCallback } from 'react'
import { API_BASE, STREAM_URL } from '../config'
import { useFirstFrame } from '../hooks/useFirstFrame'
import { getImageRect, clientToNormalized, normalizedToCanvas } from '../lib/roiGeometry'

const STREAM_RETRY_DELAY = 3000   // ms sebelum mencoba menyambung ulang stream

// ─── Corner brackets ──────────────────────────────────────────
function Corners() {
  const s = 'absolute w-5 h-5 pointer-events-none'
  const c = { borderColor: 'rgba(34,211,238,0.35)', zIndex: 20 }
  return (
    <>
      <div className={`${s} top-2 left-2  border-t border-l`} style={c} />
      <div className={`${s} top-2 right-2 border-t border-r`} style={c} />
      <div className={`${s} bottom-2 left-2  border-b border-l`} style={c} />
      <div className={`${s} bottom-2 right-2 border-b border-r`} style={c} />
    </>
  )
}

// ─── Offline placeholder ──────────────────────────────────────
function OfflinePlaceholder() {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-5"
      style={{
        background: 'radial-gradient(ellipse at center, #0d0f1a 0%, #08090f 100%)',
        zIndex: 2,
      }}
    >
      <div className="relative w-16 h-16 flex items-center justify-center">
        {[0, 1, 2].map(i => (
          <div
            key={i}
            className="absolute inset-0 rounded-full border"
            style={{
              borderColor: 'rgba(34,211,238,0.12)',
              animation: `livePulse ${2.5 + i * 0.7}s ease-in-out ${i * 0.35}s infinite`,
            }}
          />
        ))}
        <div
          className="w-11 h-11 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.15)' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="rgba(34,211,238,0.5)" strokeWidth="1.4" strokeLinecap="round">
            <path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
        </div>
      </div>
      <div className="text-center space-y-1">
        <p className="font-mono text-xs" style={{ color: 'var(--text-dim)' }}>
          Menghubungkan ke stream...
        </p>
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {STREAM_URL}
        </p>
      </div>
    </div>
  )
}

// ─── Update ROI panel (tersembunyi, muncul saat user klik tombol) ──
function ROIUpdatePanel({ onClose }) {
  const canvasRef    = useRef(null)
  const containerRef = useRef(null)
  const redrawRef    = useRef(null)   // fungsi gambar terbaru, dibaca ResizeObserver

  const [points,   setPoints]   = useState([])
  const [allRois,  setAllRois]  = useState([])
  const [saving,   setSaving]   = useState(false)
  const [result,   setResult]   = useState(null)

  // Frame diambil SEKALI saat panel dibuka (bukan tiap render)
  const { frame, slow, procError, noSource } = useFirstFrame()

  const COLORS = ['#22d3ee', '#fbbf24', '#4ade80', '#a78bfa']

  const redraw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)

    // Kotak frame yang benar-benar tampil di canvas (lihat lib/roiGeometry.js)
    const imgRect = frame ? getImageRect(c.width, c.height, frame.width, frame.height) : null
    if (!imgRect) return

    const toC = pts => pts.map(p => normalizedToCanvas(p, imgRect))

    allRois.forEach((roi, idx) => {
      const px = toC(roi)
      const col = COLORS[idx % COLORS.length]
      ctx.beginPath()
      ctx.moveTo(px[0].x, px[0].y)
      px.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
      ctx.closePath()
      ctx.fillStyle = col + '18'; ctx.fill()
      ctx.strokeStyle = col + 'aa'; ctx.lineWidth = 1.5
      ctx.setLineDash([]); ctx.stroke()
      px.forEach(p => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = col; ctx.fill()
      })
    })

    if (points.length > 0) {
      const px = toC(points)
      ctx.beginPath()
      ctx.moveTo(px[0].x, px[0].y)
      px.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
      if (points.length >= 3) { ctx.closePath(); ctx.fillStyle = 'rgba(34,211,238,0.07)'; ctx.fill() }
      ctx.strokeStyle = 'rgba(34,211,238,0.7)'; ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([])
      px.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 5 : 3.5, 0, Math.PI * 2)
        ctx.fillStyle = i === 0 ? '#fbbf24' : '#22d3ee'; ctx.fill()
      })
    }
  }, [allRois, points, frame])

  useEffect(() => {
    redrawRef.current = redraw
    redraw()
  }, [redraw])

  // ResizeObserver dibuat sekali saja (bukan tiap klik); fungsi gambar terbaru lewat ref
  useEffect(() => {
    const c = canvasRef.current, d = containerRef.current
    if (!c || !d) return
    const obs = new ResizeObserver(() => {
      c.width = c.clientWidth; c.height = c.clientHeight
      redrawRef.current?.()
    })
    obs.observe(d)
    return () => obs.disconnect()
  }, [])

  const handleClick = e => {
    const c = canvasRef.current
    if (!c || !frame) return
    // Dinormalisasi terhadap kotak GAMBAR (bukan kotak canvas), di-clamp ke 0..1
    const p = clientToNormalized(e.clientX, e.clientY, c.getBoundingClientRect(), frame.width, frame.height)
    if (!p) return
    setPoints(prev => [...prev, p])
    setResult(null)
  }

  const finishZone = () => {
    if (points.length < 3) return
    setAllRois(prev => [...prev, points])
    setPoints([])
  }

  const save = async () => {
    const final = points.length >= 3 ? [...allRois, points] : allRois
    if (final.length === 0) { setResult({ ok: false, msg: 'Gambar minimal 1 zona.' }); return }
    setSaving(true)
    try {
      const res = await fetch(`${API_BASE}/set_roi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rois: final.map(r => r.map(p => [p.x, p.y])) }),
      })
      const d = await res.json()
      setResult(d.status === 'ok'
        ? { ok: true, msg: `${final.length} zona berhasil diperbarui!` }
        : { ok: false, msg: d.message || 'Gagal.' })
    } catch { setResult({ ok: false, msg: 'Backend tidak bisa dijangkau.' }) }
    finally { setSaving(false) }
  }

  return (
    <div
      className="absolute inset-0 flex flex-col gap-2 p-3"
      style={{ background: 'rgba(8,9,15,0.95)', zIndex: 30, backdropFilter: 'blur(8px)' }}
    >
      <div className="flex items-center justify-between shrink-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          Update Zona Pantau
        </p>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded-lg"
          style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)', border: '1px solid var(--edge)' }}
        >
          ✕ Tutup
        </button>
      </div>

      <div ref={containerRef} className="relative flex-1 rounded-xl overflow-hidden" style={{ background: '#000', border: '1px solid var(--edge)', minHeight: 0 }}>
        {frame && (
          <img
            src={frame.url}
            alt="frame"
            className="absolute inset-0 w-full h-full object-contain"
            style={{ zIndex: 1 }}
          />
        )}
        <canvas
          ref={canvasRef}
          onClick={frame ? handleClick : undefined}
          className={`absolute inset-0 w-full h-full ${frame ? 'cursor-crosshair' : 'cursor-default'}`}
          style={{ zIndex: 10 }}
        />

        {/* Frame belum ada: backend masih menyiapkannya, atau frame tidak akan
            datang (processor melapor error / backend belum punya sumber).
            Panel ini tidak menyimpan konfigurasi sumber dan processor tidak
            mencoba ulang sendiri, jadi jalan keluarnya lewat "Ganti Setup". */}
        {!frame && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center" style={{ zIndex: 15 }}>
            {(procError || noSource) ? (
              <>
                <p className="text-xs" style={{ color: 'var(--red)' }}>
                  ⚠️ {procError
                    ? `Processor berhenti: ${procError}`
                    : 'Backend belum punya sumber video (mungkin baru di-restart).'}
                </p>
                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Klik ⚙ Ganti Setup di kanan atas untuk mengonfigurasi ulang sumbernya.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Mengambil frame...</p>
                {slow && (
                  <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Backend masih membuka sumber videonya — masih ditunggu.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 flex gap-2">
        <button onClick={finishZone} disabled={points.length < 3}
          className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-30"
          style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', color: 'var(--green)' }}>
          + Selesaikan Zona ({points.length}pt)
        </button>
        <button onClick={() => { setPoints([]); setAllRois([]) }}
          className="px-3 py-2 rounded-xl text-xs transition-all"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--edge)', color: 'var(--text-dim)' }}>
          Reset
        </button>
        <button onClick={save} disabled={saving || (allRois.length === 0 && points.length < 3)}
          className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-30"
          style={{ background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.35)', color: 'var(--cyan)' }}>
          {saving ? 'Menyimpan...' : 'Simpan Zona'}
        </button>
      </div>

      {result && (
        <div className="shrink-0 text-xs px-3 py-2 rounded-lg text-center"
          style={{
            background: result.ok ? 'var(--green-soft)' : 'var(--red-soft)',
            color: result.ok ? 'var(--green)' : 'var(--red)',
            border: `1px solid ${result.ok ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
          }}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────
// Props (semua opsional):
//   connected  — status WebSocket, dipakai untuk menyambung ulang stream
//   procError  — pesan error processor (null = normal)
//   tickLabel  — teks lama proses tick terakhir, mis. "2,4 dtk/tick"
function VideoMonitor({ connected = false, procError = null, tickLabel = null }) {
  const imgRef       = useRef(null)
  const retryTimer   = useRef(null)    // timer sambung ulang stream
  const wasConnected = useRef(false)   // WebSocket sudah pernah tersambung?
  const [streamOk,    setStreamOk]    = useState(false)
  const [showUpdate,  setShowUpdate]  = useState(false)

  // Pasang ulang src → browser membuka koneksi MJPEG baru. Parameter `r` hanya
  // membuat URL-nya berbeda dari yang gagal; backend mengabaikannya.
  const reconnectStream = useCallback(() => {
    clearTimeout(retryTimer.current)
    retryTimer.current = null
    if (imgRef.current) imgRef.current.src = `${STREAM_URL}?r=${Date.now()}`
  }, [])

  // src dipasang lewat effect (bukan atribut JSX) supaya koneksi MJPEG
  // benar-benar ditutup saat komponen di-unmount (mis. "Ganti Setup").
  useEffect(() => {
    const img = imgRef.current
    img.src = STREAM_URL
    return () => {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
      img.removeAttribute('src')
    }
  }, [])

  // <img> gagal memuat stream → coba lagi setelah jeda, jangan dibiarkan rusak
  const handleStreamError = () => {
    setStreamOk(false)
    if (retryTimer.current) return
    retryTimer.current = setTimeout(reconnectStream, STREAM_RETRY_DELAY)
  }

  // Event error <img> tidak dijamin muncul saat stream terputus (mis. backend
  // di-restart: gambarnya hanya membeku). Begitu WebSocket tersambung LAGI,
  // stream ikut disambung ulang.
  useEffect(() => {
    if (!connected) return
    if (wasConnected.current) reconnectStream()
    wasConnected.current = true
  }, [connected, reconnectStream])

  return (
    <div className="flex flex-col h-full gap-2">

      {/* Label row */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>
            Live Feed
          </span>
          <span
            className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{
              color:      streamOk ? 'var(--cyan)'    : 'var(--text-dim)',
              background: streamOk ? 'rgba(34,211,238,0.06)' : 'rgba(255,255,255,0.02)',
              border:    `1px solid ${streamOk ? 'rgba(34,211,238,0.25)' : 'var(--edge)'}`,
            }}
          >
            {streamOk ? '● Streaming' : '○ Standby'}
          </span>
          {tickLabel && (
            <span
              className="text-[10px] font-mono"
              style={{ color: 'var(--text-muted)' }}
              title="Lama proses tick terakhir di backend"
            >
              {tickLabel}
            </span>
          )}
        </div>

        <button
          onClick={() => setShowUpdate(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-mono tracking-wide transition-all duration-150"
          style={{
            background: showUpdate ? 'rgba(251,191,36,0.08)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${showUpdate ? 'rgba(251,191,36,0.3)' : 'var(--edge)'}`,
            color: showUpdate ? 'var(--amber)' : 'var(--text-dim)',
          }}
        >
          {showUpdate ? '✕ Batal' : '✏ Update Zona'}
        </button>
      </div>

      {/* Video + overlay */}
      <div
        className="relative flex-1 rounded-2xl scanline-wrap"
        style={{
          background: '#000',
          border: '1px solid var(--edge)',
          minHeight: 0,
          boxShadow: '0 0 40px rgba(0,0,0,0.5)',
        }}
      >
        <img
          ref={imgRef}
          alt="Live Feed"
          className="absolute inset-0 w-full h-full object-contain"
          style={{ zIndex: 1 }}
          onLoad={() => setStreamOk(true)}
          onError={handleStreamError}
        />

        {!streamOk && <OfflinePlaceholder />}

        <Corners />

        {/* Processor berhenti / melapor error */}
        {procError && (
          <div
            role="alert"
            className="absolute top-3 left-3 right-3 px-3 py-2 rounded-xl text-xs font-semibold break-words"
            style={{
              background: 'linear-gradient(var(--red-soft), var(--red-soft)), rgba(8,9,15,0.92)',
              border: '1px solid rgba(248,113,113,0.5)',
              color: 'var(--red)',
              zIndex: 25,
            }}
          >
            ⚠️ Processor berhenti: {procError}
          </div>
        )}

        {/* Update ROI panel */}
        {showUpdate && <ROIUpdatePanel onClose={() => setShowUpdate(false)} />}
      </div>
    </div>
  )
}

// memo: Dashboard render ulang tiap pesan WebSocket, sedangkan komponen ini
// hanya perlu ikut render kalau props-nya (semuanya nilai primitif) berubah.
export default memo(VideoMonitor)
