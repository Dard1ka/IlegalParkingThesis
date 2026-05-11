import { useState, useRef, useEffect, useCallback } from 'react'

const API = 'http://localhost:8000'

// ─── Step indicator ───────────────────────────────────────────
function StepDot({ active, done, label }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300"
        style={{
          background: done
            ? 'var(--cyan)'
            : active
            ? 'rgba(34,211,238,0.15)'
            : 'rgba(255,255,255,0.04)',
          border: `1.5px solid ${done ? 'var(--cyan)' : active ? 'rgba(34,211,238,0.5)' : 'var(--edge)'}`,
          color: done ? '#08090f' : active ? 'var(--cyan)' : 'var(--text-muted)',
        }}
      >
        {done ? '✓' : ''}
      </div>
      <span
        className="text-[10px] tracking-wide whitespace-nowrap"
        style={{ color: active ? 'var(--text-dim)' : 'var(--text-muted)' }}
      >
        {label}
      </span>
    </div>
  )
}

function StepBar({ step }) {
  const steps = ['Pilih Sumber', 'Zona Parkir', 'Mulai']
  return (
    <div className="flex items-start gap-3">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center gap-3">
          <StepDot active={step === i} done={step > i} label={label} />
          {i < steps.length - 1 && (
            <div
              className="w-12 h-px mb-5 transition-all duration-500"
              style={{ background: step > i ? 'var(--cyan)' : 'var(--edge)' }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Option Card ──────────────────────────────────────────────
function OptionCard({ selected, onClick, icon, title, desc, badge }) {
  return (
    <button
      onClick={onClick}
      className="relative w-full text-left p-4 rounded-2xl transition-all duration-200"
      style={{
        background: selected ? 'rgba(34,211,238,0.07)' : 'rgba(255,255,255,0.02)',
        border: `1.5px solid ${selected ? 'rgba(34,211,238,0.45)' : 'var(--edge)'}`,
        boxShadow: selected ? '0 0 24px rgba(34,211,238,0.06)' : 'none',
        transform: selected ? 'scale(1.01)' : 'scale(1)',
      }}
    >
      {badge && (
        <span
          className="absolute top-3 right-3 text-[9px] font-semibold px-2 py-0.5 rounded-full tracking-wider uppercase"
          style={{ background: 'var(--purple-soft)', color: 'var(--purple)', border: '1px solid rgba(167,139,250,0.2)' }}
        >
          {badge}
        </span>
      )}
      <div className="flex gap-3 items-start">
        <span className="text-2xl mt-0.5 shrink-0">{icon}</span>
        <div>
          <p className="font-semibold text-sm" style={{ color: selected ? 'var(--text)' : 'var(--text-dim)' }}>
            {title}
          </p>
          <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {desc}
          </p>
        </div>
      </div>
      {selected && (
        <div
          className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
          style={{ background: 'var(--cyan)', color: '#08090f' }}
        >
          ✓
        </div>
      )}
    </button>
  )
}

// ─── Step 0: Pilih Sumber Video ───────────────────────────────
function StepSource({ onNext }) {
  const [sourceType, setSourceType] = useState(null)
  const [videoFile, setVideoFile]   = useState(null)
  const [camIndex,  setCamIndex]    = useState(0)
  const [uploading, setUploading]   = useState(false)
  const [error,     setError]       = useState('')
  const [dragOver,  setDragOver]    = useState(false)
  const fileRef = useRef(null)

  const handleFile = (f) => {
    if (!f) return
    const allowed = ['video/mp4', 'video/avi', 'video/quicktime', 'video/x-matroska', 'video/webm']
    if (!allowed.includes(f.type) && !f.name.match(/\.(mp4|avi|mov|mkv|webm)$/i)) {
      setError('Format tidak didukung. Pakai MP4, AVI, MOV, MKV, atau WebM ya.')
      return
    }
    setVideoFile(f)
    setError('')
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }

  const handleNext = async () => {
    setError('')
    if (!sourceType) { setError('Pilih sumber video dulu ya!'); return }

    if (sourceType === 'video') {
      if (!videoFile) { setError('Upload file video dulu dong.'); return }
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append('file', videoFile)
        const res = await fetch(`${API}/upload`, { method: 'POST', body: fd })
        const data = await res.json()
        if (data.status !== 'ok') { setError(data.message || 'Upload gagal.'); return }
        onNext({ sourceType: 'video', path: data.path, filename: data.filename })
      } catch {
        setError('Gagal konek ke backend. Pastiin backend sudah jalan ya.')
      } finally {
        setUploading(false)
      }
    } else {
      onNext({ sourceType: 'camera', camIndex })
    }
  }

  return (
    <div className="wizard-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
          Dari mana sumber videonya? 📹
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>
          Bisa dari file video yang udah ada, atau langsung dari kamera
        </p>
      </div>

      <div className="space-y-3">
        <OptionCard
          selected={sourceType === 'video'}
          onClick={() => setSourceType('video')}
          icon="🎬"
          title="Upload File Video"
          desc="MP4, AVI, MOV, MKV, WebM — cocok buat testing atau analisis rekaman"
        />
        <OptionCard
          selected={sourceType === 'camera'}
          onClick={() => setSourceType('camera')}
          icon="📷"
          title="Kamera Langsung"
          desc="Pantau real-time langsung dari webcam atau kamera IP"
          badge="Live"
        />
      </div>

      {/* File upload area */}
      {sourceType === 'video' && (
        <div className="space-y-3 fade-in">
          <div
            className="relative rounded-xl p-6 text-center transition-all duration-200 cursor-pointer"
            style={{
              border: `2px dashed ${dragOver ? 'var(--cyan)' : videoFile ? 'rgba(34,211,238,0.4)' : 'var(--edge)'}`,
              background: dragOver ? 'rgba(34,211,238,0.04)' : videoFile ? 'rgba(34,211,238,0.03)' : 'rgba(255,255,255,0.01)',
            }}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files[0])}
            />
            {videoFile ? (
              <div className="space-y-1">
                <span className="text-2xl">✅</span>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{videoFile.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {(videoFile.size / 1024 / 1024).toFixed(1)} MB — klik untuk ganti
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <span className="text-3xl">📂</span>
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
                  Drag & drop video di sini, atau <span style={{ color: 'var(--cyan)' }}>klik untuk browse</span>
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>MP4, AVI, MOV, MKV, WebM</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Camera index selector */}
      {sourceType === 'camera' && (
        <div className="space-y-2 fade-in">
          <label className="text-xs" style={{ color: 'var(--text-dim)' }}>Index Kamera</label>
          <div className="flex gap-2">
            {[0, 1, 2, 3].map(i => (
              <button
                key={i}
                onClick={() => setCamIndex(i)}
                className="w-11 h-11 rounded-xl text-sm font-bold transition-all duration-150"
                style={{
                  background: camIndex === i ? 'rgba(34,211,238,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1.5px solid ${camIndex === i ? 'rgba(34,211,238,0.45)' : 'var(--edge)'}`,
                  color: camIndex === i ? 'var(--cyan)' : 'var(--text-dim)',
                }}
              >
                {i}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Biasanya webcam bawaan = 0, kamera eksternal = 1, 2, dst
          </p>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid rgba(248,113,113,0.2)' }}>
          ⚠️ {error}
        </div>
      )}

      <button
        onClick={handleNext}
        disabled={!sourceType || uploading}
        className="w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
        style={{
          background: 'linear-gradient(135deg, rgba(34,211,238,0.2), rgba(34,211,238,0.1))',
          border: '1px solid rgba(34,211,238,0.4)',
          color: 'var(--cyan)',
        }}
      >
        {uploading ? '⏳ Uploading...' : 'Lanjut →'}
      </button>
    </div>
  )
}

// ─── Step 1: Pilih Mode ROI ───────────────────────────────────
function StepROIMode({ sourceInfo, onNext, onBack }) {
  const [roiMode, setRoiMode] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const handleNext = async () => {
    if (!roiMode) { setError('Pilih dulu mode zona parkir nya ya!'); return }
    setLoading(true)
    setError('')
    try {
      const body = {
        source_type: sourceInfo.sourceType,
        roi_mode:    roiMode,
      }
      if (sourceInfo.sourceType === 'video') body.path = sourceInfo.path
      else body.camera_index = sourceInfo.camIndex

      const res = await fetch(`${API}/configure`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (data.status !== 'ok') { setError(data.message || 'Konfigurasi gagal.'); return }

      onNext({ roiMode })
    } catch {
      setError('Gagal konek ke backend.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wizard-enter space-y-5">
      <div>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
          Tentuin zona larangan parkir 🗺️
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>
          Zona ini yang bakal dipantau sistem — kendaraan yang parkir di sini bakalan ke-detect
        </p>
      </div>

      <div className="space-y-3">
        <OptionCard
          selected={roiMode === 'manual'}
          onClick={() => setRoiMode('manual')}
          icon="✏️"
          title="Gambar Sendiri"
          desc="Kamu gambar polygon zona larangan langsung di frame videonya — bisa buat lebih dari 1 zona"
        />
        <OptionCard
          selected={roiMode === 'auto'}
          onClick={() => setRoiMode('auto')}
          icon="🤖"
          title="Otomatis"
          desc="Sistem pakai seluruh frame sebagai zona pantau — cocok kalau mau monitor semua area"
          badge="Rekomendasi"
        />
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid rgba(248,113,113,0.2)' }}>
          ⚠️ {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="py-3 px-5 rounded-xl text-sm transition-all duration-200"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--edge)', color: 'var(--text-dim)' }}
        >
          ← Balik
        </button>
        <button
          onClick={handleNext}
          disabled={!roiMode || loading}
          className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(135deg, rgba(34,211,238,0.2), rgba(34,211,238,0.1))',
            border: '1px solid rgba(34,211,238,0.4)',
            color: 'var(--cyan)',
          }}
        >
          {loading ? '⏳ Menghubungkan...' : roiMode === 'auto' ? 'Langsung Mulai 🚀' : 'Lanjut Gambar Zona →'}
        </button>
      </div>
    </div>
  )
}

// ─── Canvas ROI drawing ───────────────────────────────────────
function drawCanvas(canvas, allRois, currentPoints, imgW, imgH) {
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)

  const toCanvas = (pts) => pts.map(p => ({ x: p.x * W, y: p.y * H }))

  const colors = ['#22d3ee', '#fbbf24', '#4ade80', '#a78bfa', '#f87171']

  // Draw completed ROIs
  allRois.forEach((roi, idx) => {
    const px = toCanvas(roi)
    const color = colors[idx % colors.length]
    ctx.beginPath()
    ctx.moveTo(px[0].x, px[0].y)
    px.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
    ctx.closePath()
    ctx.fillStyle = color + '18'
    ctx.fill()
    ctx.strokeStyle = color + 'bb'
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    ctx.stroke()

    // Label
    const cx = px.reduce((s, p) => s + p.x, 0) / px.length
    const cy = px.reduce((s, p) => s + p.y, 0) / px.length
    ctx.font = 'bold 11px DM Sans, sans-serif'
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.fillText(`Zona ${idx + 1}`, cx, cy)
    ctx.textAlign = 'left'

    px.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()
    })
  })

  // Draw current in-progress polygon
  if (currentPoints.length > 0) {
    const px = toCanvas(currentPoints)
    ctx.beginPath()
    ctx.moveTo(px[0].x, px[0].y)
    px.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
    if (currentPoints.length >= 3) {
      ctx.closePath()
      ctx.fillStyle = 'rgba(34,211,238,0.07)'
      ctx.fill()
    }
    ctx.strokeStyle = 'rgba(34,211,238,0.75)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([7, 4])
    ctx.stroke()
    ctx.setLineDash([])

    px.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 6 : 4, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#fbbf24' : '#22d3ee'
      ctx.fill()
      ctx.font = '600 9px Share Tech Mono, monospace'
      ctx.fillStyle = i === 0 ? '#fbbf24' : '#22d3ee'
      ctx.fillText(`P${i + 1}`, p.x + 8, p.y - 5)
    })
  }
}

// ─── Step 2: Gambar ROI Manual ────────────────────────────────
function StepDrawROI({ onDone, onBack }) {
  const canvasRef    = useRef(null)
  const containerRef = useRef(null)
  const [allRois,    setAllRois]    = useState([])   // completed polygons
  const [current,    setCurrent]    = useState([])   // points being drawn
  const [firstFrame, setFirstFrame] = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  // Fetch first frame from backend
  useEffect(() => {
    let attempts = 0
    const maxAttempts = 30
    const poll = async () => {
      try {
        const res = await fetch(`${API}/first_frame`)
        if (res.status === 204) {
          if (attempts++ < maxAttempts) setTimeout(poll, 500)
          return
        }
        const blob = await res.blob()
        setFirstFrame(URL.createObjectURL(blob))
        setLoading(false)
      } catch {
        if (attempts++ < maxAttempts) setTimeout(poll, 500)
      }
    }
    poll()
  }, [])

  const redraw = useCallback(() => {
    const c = canvasRef.current
    if (c) drawCanvas(c, allRois, current)
  }, [allRois, current])

  useEffect(() => { redraw() }, [redraw])

  useEffect(() => {
    const obs = new ResizeObserver(() => {
      const c = canvasRef.current, d = containerRef.current
      if (!c || !d) return
      const r = d.getBoundingClientRect()
      c.width = r.width; c.height = r.height
      redraw()
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [redraw])

  const handleClick = (e) => {
    const c = canvasRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    setCurrent(prev => [...prev, { x, y }])
    setError('')
  }

  const finishPolygon = () => {
    if (current.length < 3) { setError('Minimal 3 titik buat satu zona ya!'); return }
    setAllRois(prev => [...prev, current])
    setCurrent([])
  }

  const undoPoint = () => {
    if (current.length > 0) setCurrent(prev => prev.slice(0, -1))
    else if (allRois.length > 0) setAllRois(prev => prev.slice(0, -1))
  }

  const clearAll = () => { setAllRois([]); setCurrent([]) }

  const handleSave = async () => {
    const finalRois = current.length >= 3 ? [...allRois, current] : allRois
    if (finalRois.length === 0) { setError('Gambar minimal 1 zona dulu ya!'); return }

    setSaving(true)
    setError('')
    try {
      const roisPayload = finalRois.map(roi => roi.map(p => [p.x, p.y]))
      const res = await fetch(`${API}/set_roi`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rois: roisPayload }),
      })
      const data = await res.json()
      if (data.status !== 'ok') { setError(data.message || 'Gagal simpan ROI.'); return }
      onDone()
    } catch {
      setError('Gagal konek ke backend.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wizard-enter flex flex-col h-full gap-4">
      <div className="shrink-0">
        <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
          Gambar zona larangan parkir ✏️
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>
          Klik titik-titik di frame untuk bikin polygon. Bisa buat lebih dari 1 zona.
        </p>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="relative flex-1 rounded-xl overflow-hidden scanline-wrap"
        style={{
          background: '#000',
          border: '1px solid var(--edge)',
          minHeight: '300px',
        }}
      >
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ zIndex: 5 }}>
            <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--cyan)', borderTopColor: 'transparent' }} />
            <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Mengambil frame pertama...</p>
          </div>
        )}
        {firstFrame && (
          <img
            src={firstFrame}
            alt="First Frame"
            className="absolute inset-0 w-full h-full object-contain"
            style={{ zIndex: 1 }}
          />
        )}
        <canvas
          ref={canvasRef}
          onClick={!loading ? handleClick : undefined}
          className="absolute inset-0 w-full h-full"
          style={{ zIndex: 10, cursor: loading ? 'wait' : 'crosshair' }}
        />

        {/* Floating hints */}
        {!loading && current.length === 0 && allRois.length === 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none" style={{ zIndex: 15 }}>
            <div
              className="px-4 py-2 rounded-full text-xs whitespace-nowrap"
              style={{ background: 'rgba(8,9,15,0.85)', border: '1px solid var(--edge)', color: 'var(--text-dim)', backdropFilter: 'blur(8px)' }}
            >
              Klik di frame buat nambahin titik zona
            </div>
          </div>
        )}

        {/* Zone badges */}
        {allRois.length > 0 && (
          <div className="absolute top-3 right-3 pointer-events-none" style={{ zIndex: 15 }}>
            <div
              className="px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{ background: 'rgba(8,9,15,0.85)', border: '1px solid rgba(34,211,238,0.3)', color: 'var(--cyan)', backdropFilter: 'blur(8px)' }}
            >
              {allRois.length} zona tersimpan
            </div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="shrink-0 flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={finishPolygon}
            disabled={current.length < 3}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-30"
            style={{
              background: current.length >= 3 ? 'rgba(74,222,128,0.1)' : 'rgba(255,255,255,0.02)',
              border: `1.5px solid ${current.length >= 3 ? 'rgba(74,222,128,0.35)' : 'var(--edge)'}`,
              color: current.length >= 3 ? 'var(--green)' : 'var(--text-muted)',
            }}
          >
            + Selesaikan Zona {allRois.length + 1} ({current.length} titik)
          </button>
          <button
            onClick={undoPoint}
            disabled={current.length === 0 && allRois.length === 0}
            className="px-4 py-2.5 rounded-xl text-sm transition-all disabled:opacity-30"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--edge)', color: 'var(--text-dim)' }}
            title="Undo titik terakhir"
          >
            ↩
          </button>
          <button
            onClick={clearAll}
            disabled={current.length === 0 && allRois.length === 0}
            className="px-4 py-2.5 rounded-xl text-sm transition-all disabled:opacity-30"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--edge)', color: 'var(--text-dim)' }}
            title="Hapus semua"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid rgba(248,113,113,0.2)' }}>
            ⚠️ {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onBack}
            className="py-3 px-5 rounded-xl text-sm transition-all"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--edge)', color: 'var(--text-dim)' }}
          >
            ← Balik
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (allRois.length === 0 && current.length < 3)}
            className="flex-1 py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-30"
            style={{
              background: 'linear-gradient(135deg, rgba(34,211,238,0.2), rgba(34,211,238,0.1))',
              border: '1px solid rgba(34,211,238,0.4)',
              color: 'var(--cyan)',
            }}
          >
            {saving ? '⏳ Menyimpan...' : `Simpan ${allRois.length + (current.length >= 3 ? 1 : 0)} Zona & Mulai 🚀`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main wizard ──────────────────────────────────────────────
export default function SetupWizard({ onComplete }) {
  const [step,       setStep]       = useState(0)
  const [sourceInfo, setSourceInfo] = useState(null)
  const [roiInfo,    setRoiInfo]    = useState(null)

  const handleSourceNext = (info) => { setSourceInfo(info); setStep(1) }
  const handleROIModeNext = (info) => {
    setRoiInfo(info)
    if (info.roiMode === 'auto') {
      onComplete()   // auto mode → langsung ke dashboard
    } else {
      setStep(2)     // manual → lanjut gambar ROI
    }
  }

  return (
    <div
      className="h-screen flex items-center justify-center bg-noise p-4"
      style={{ background: 'var(--void)' }}
    >
      <div
        className="w-full max-w-lg glass rounded-3xl p-7 flex flex-col gap-6"
        style={{
          maxHeight: step === 2 ? '90vh' : 'auto',
          boxShadow: '0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px var(--edge)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
              style={{ background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.2)' }}
            >
              🅿️
            </div>
            <div>
              <p className="font-bold text-sm" style={{ color: 'var(--text)' }}>Parking Guard</p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Setup konfigurasi</p>
            </div>
          </div>
          <StepBar step={step} />
        </div>

        {/* Step content */}
        <div className={`flex-1 ${step === 2 ? 'overflow-hidden flex flex-col' : ''}`}>
          {step === 0 && <StepSource onNext={handleSourceNext} />}
          {step === 1 && (
            <StepROIMode
              sourceInfo={sourceInfo}
              onNext={handleROIModeNext}
              onBack={() => setStep(0)}
            />
          )}
          {step === 2 && (
            <StepDrawROI
              onDone={onComplete}
              onBack={() => setStep(1)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
