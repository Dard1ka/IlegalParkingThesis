import { useState, useRef, useEffect } from 'react'
import { API_BASE } from '../config'
import { useFirstFrame } from '../hooks/useFirstFrame'
import ZoneEditor from './ZoneEditor'
import Icon from './Icon'
import { Rambu, FaultGlyph } from './Glyphs'
import RuleLane from './RuleLane'

// Catatan render: mini PC tidak punya akselerasi GPU di browser, jadi wizard
// ini tanpa animasi, transisi, gradien, bayangan, atau efek kabur. Gaya dari
// kelas komponen di index.css. Nama kelas ditulis utuh (bukan dirangkai dari
// variabel) supaya tidak dibuang Tailwind saat build.

const VIDEO_TYPES = ['video/mp4', 'video/avi', 'video/quicktime', 'video/x-matroska', 'video/webm']
const NO_SERVER = 'Server deteksi tidak merespons. Jalankan server deteksi, lalu coba lagi.'

// Label sumber singkat ("input3.mp4" / "Kamera 0" / "Kamera IP 192.168.1.64:554")
function sourceLabelOf(info) {
  if (!info) return ''
  if (info.sourceType === 'camera') return `Kamera ${info.camIndex}`
  if (info.sourceType === 'rtsp') return `Kamera IP ${info.host}`
  return info.filename
}

// ─── Kamera IP (RTSP) ────────────────────────────────────────
// Stream utama kamera Hikvision (1080p). "192.168.1.64", "192.168.1.64:8554",
// atau alamat yang ditempel lengkap ("rtsp://…/…") → host:port saja.
const RTSP_PORT = 554
const RTSP_PATH = '/Streaming/Channels/101'

function rtspHostOf(raw) {
  const h = raw.trim().replace(/^[a-z]+:\/\//i, '').replace(/^.*@/, '').replace(/\/.*$/, '')
  if (!h) return ''
  return /:\d+$/.test(h) ? h : `${h}:${RTSP_PORT}`
}

function rtspUrlOf(host, user, pass) {
  return `rtsp://${encodeURIComponent(user.trim())}:${encodeURIComponent(pass)}@${host}${RTSP_PATH}`
}

// 627 572 352 byte jadi "598,5" (format Indonesia, satu angka desimal)
function formatMB(bytes) {
  return (bytes / 1048576).toLocaleString('id-ID', { maximumFractionDigits: 1 })
}

// "Awal: pesan." Titik di akhir pesan server dibuang supaya tidak dobel;
// tanpa pesan cukup "Awal."
function withMessage(lead, message, next = '') {
  const m = String(message ?? '').trim().replace(/[.\s]+$/, '')
  return `${lead}${m ? `: ${m}` : ''}.${next ? ` ${next}` : ''}`
}

// Galat: catatan netral (tidak pernah merah), tepat di bawah kontrolnya
function ErrorNote({ className = '', children }) {
  return (
    <div className={className ? `note ${className}` : 'note'} role="alert">
      <FaultGlyph />
      <p>{children}</p>
    </div>
  )
}

// ─── Bar atas: rambu (diam) + nama, lalu dua langkah ─────────
// Menggambar zona termasuk langkah 2, jadi stepper hanya dua item.
function WizardBar({ step }) {
  return (
    <header className="wizard-bar">
      <div className="brand"><Rambu />Parking Guard</div>
      <ol className="stepper" aria-label="Langkah pengaturan">
        {step === 1 ? (
          <li aria-current="step">1 Sumber video</li>
        ) : (
          <li className="is-done">
            <Icon name="check" size={14} />
            1 Sumber video<span className="sr-only">, selesai</span>
          </li>
        )}
        {step === 2 ? <li aria-current="step">2 Zona larangan</li> : <li>2 Zona larangan</li>}
      </ol>
    </header>
  )
}

// ─── Sidik video: SHA-256 atas tiga potongan 1 MiB ───────────
// (awal, tengah, akhir; file ≤ 3 MiB di-hash utuh). Rumusnya harus sama
// dengan video_sample() di backend/main.py. crypto.subtle hanya ada di
// konteks aman (http://localhost ya, alamat IP LAN tidak); tanpa itu
// pemeriksaan dilewati dan video langsung diunggah.
const SAMPLE_BYTES = 1024 * 1024

async function videoSample(file) {
  if (!globalThis.crypto?.subtle) return null
  const size = file.size
  const mid = Math.floor(size / 2) - SAMPLE_BYTES / 2
  const ranges = size <= 3 * SAMPLE_BYTES
    ? [[0, size]]
    : [[0, SAMPLE_BYTES], [mid, mid + SAMPLE_BYTES], [size - SAMPLE_BYTES, size]]
  const parts = await Promise.all(ranges.map(([a, b]) => file.slice(a, b).arrayBuffer()))
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) { bytes.set(new Uint8Array(p), offset); offset += p.byteLength }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── GET /upload/check ────────────────────────────────────────
// Video yang isinya sama sudah ada di server deteksi (mis. dipilih lagi saat
// ganti sumber): jawaban { path, filename } dipakai langsung tanpa unggah
// ulang. null = tidak ada, atau pemeriksaan tidak bisa dilakukan / lewat
// CHECK_TIMEOUT (lalu diunggah seperti biasa). signal = batal oleh user.
const CHECK_TIMEOUT = 5000

async function findOnServer(file, signal) {
  const timer = new AbortController()
  const timeoutId = setTimeout(() => timer.abort(), CHECK_TIMEOUT)
  const stop = () => timer.abort()
  signal.addEventListener('abort', stop)
  try {
    const sample = await videoSample(file)
    if (!sample || timer.signal.aborted) return null
    const res = await fetch(`${API_BASE}/upload/check?size=${file.size}&sample=${sample}`,
      { cache: 'no-store', signal: timer.signal })
    const data = await res.json()
    return data?.status === 'ok' && data.found ? data : null
  } catch {
    return null      // gangguan / lewat batas waktu / dibatalkan
  } finally {
    clearTimeout(timeoutId)
    signal.removeEventListener('abort', stop)
  }
}

// ─── PUT /upload/stream lewat XHR ────────────────────────────
// Body = isi file apa adanya (bukan FormData): server menulisnya langsung ke
// uploads/ tanpa file sementara + salinan kedua. XHR karena fetch belum bisa
// melaporkan progres unggah. Jawaban bukan JSON (mis. 500 polos) dijadikan
// galat server, bukan "server tidak merespons".
function uploadVideo(xhr, file, onProgress) {
  return new Promise((resolve, reject) => {
    xhr.open('PUT', `${API_BASE}/upload/stream?filename=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total) }
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText))
      } catch {
        resolve({ status: 'error', message: `server menjawab HTTP ${xhr.status}` })
      }
    }
    xhr.onerror = () => reject(new Error('network'))
    xhr.onabort = () => reject(new DOMException('Unggahan dibatalkan', 'AbortError'))
    xhr.send(file)
  })
}

// ─── Langkah 1: sumber video ─────────────────────────────────
function StepSource({ initial, focusTitle, onNext }) {
  const [sourceType, setSourceType] = useState(initial?.sourceType ?? null)
  const [videoFile,  setVideoFile]  = useState(null)
  const [camIndex,   setCamIndex]   = useState(initial?.sourceType === 'camera' ? initial.camIndex : 0)
  // Kamera IP: diisi lagi saat kembali dari langkah 2 (hanya di memori, tidak disimpan)
  const ipInitial = initial?.sourceType === 'rtsp' ? initial : null
  const [camHost,    setCamHost]    = useState(ipInitial?.camHost ?? '')
  const [camUser,    setCamUser]    = useState(ipInitial?.camUser ?? 'admin')
  const [camPass,    setCamPass]    = useState(ipInitial?.camPass ?? '')
  const [dragOver,   setDragOver]   = useState(false)
  const [fileError,  setFileError]  = useState('')   // format file salah (di bawah dropzone)
  const [error,      setError]      = useState('')   // unggah / server (di bawah tombol)
  const [aborted,    setAborted]    = useState(false)
  const [uploading,  setUploading]  = useState(false)   // memeriksa atau mengunggah
  const [checking,   setChecking]   = useState(false)   // GET /upload/check (sebelum unggah)
  const [progress,   setProgress]   = useState({ loaded: 0, total: 0 })
  // Video yang sedang dipakai backend (dari GET /status). Bisa dipakai lagi
  // tanpa upload ulang (di mini PC upload ~600 MB makan waktu).
  const [activeVideo, setActiveVideo] = useState(null)   // { path, filename }
  const [useActive,   setUseActive]   = useState(false)
  const fileRef     = useRef(null)
  const xhrRef      = useRef(null)
  const checkRef    = useRef(null)    // AbortController pemeriksaan GET /upload/check
  const lastPct     = useRef(-1)
  const titleRef    = useRef(null)
  const nextRef     = useRef(null)
  const refocusNext = useRef(false)
  const changeBtnRef = useRef(null)

  useEffect(() => { if (focusTitle) titleRef.current?.focus() }, [focusTitle])

  // "Pilih file…" hilang bersama dropzone setelah file dipilih; kalau fokus
  // jatuh ke <body>, pindahkan ke "Ganti file…" yang menggantikan tempatnya
  useEffect(() => {
    if (videoFile && document.activeElement === document.body) changeBtnRef.current?.focus()
  }, [videoFile])

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/status`)
      .then(res => res.json())
      .then(data => {
        const src = data?.source
        if (cancelled || src?.type !== 'video' || !src.path) return
        setActiveVideo({ path: src.path, filename: src.path.split(/[\\/]/).pop() })
      })
      .catch(() => {})   // backend belum jalan, opsi ini tidak ditampilkan
    return () => { cancelled = true }
  }, [])

  // Pemeriksaan / unggahan yang masih berjalan ikut dibatalkan kalau wizard ditutup
  useEffect(() => () => {
    checkRef.current?.abort()
    xhrRef.current?.abort()
  }, [])

  // Blok unggah menggantikan tombol Lanjut. Setelah batal/gagal, fokus
  // keyboard dikembalikan ke Lanjut supaya tidak jatuh ke <body>.
  useEffect(() => {
    if (uploading || !refocusNext.current) return
    refocusNext.current = false
    nextRef.current?.focus()
  }, [uploading])

  const chooseType = (type) => {
    setSourceType(type)
    setFileError('')
    setError('')
    setAborted(false)
  }

  const handleFile = (f) => {
    if (!f) return
    if (!VIDEO_TYPES.includes(f.type) && !/\.(mp4|avi|mov|mkv|webm)$/i.test(f.name)) {
      setFileError('Format file tidak didukung. Pilih file MP4, AVI, MOV, MKV, atau WebM.')
      return
    }
    setVideoFile(f)
    setUseActive(false)
    setFileError('')
    setError('')
    setAborted(false)
  }

  const pickFile = () => fileRef.current?.click()

  // Drop juga diterima di baris file terpilih (mengganti file), supaya file
  // yang dilepas di sana tidak dibuka browser sebagai halaman
  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (!uploading) handleFile(e.dataTransfer.files[0])
  }

  // sourceInfo.reused: 'check' = ditemukan sebelum mengunggah (tidak diunggah),
  // 'upload' = sudah terunggah tetapi isinya sama dengan file di server
  // (pemeriksaan awal tidak bisa dilakukan), false = video baru
  const startUpload = async () => {
    const xhr = new XMLHttpRequest()
    const check = new AbortController()
    xhrRef.current = xhr
    checkRef.current = check
    lastPct.current = -1
    refocusNext.current = true
    setProgress({ loaded: 0, total: videoFile.size })
    setChecking(true)
    setUploading(true)
    try {
      // Video yang sama sudah ada di server deteksi: langsung dipakai
      const found = await findOnServer(videoFile, check.signal)
      if (check.signal.aborted) { setAborted(true); return }
      checkRef.current = null
      if (found) {
        onNext({ sourceType: 'video', path: found.path, filename: found.filename, reused: 'check' })
        return
      }
      setChecking(false)
      const data = await uploadVideo(xhr, videoFile, (loaded, total) => {
        // Render ulang hanya tiap naik 1 %: file ratusan MB memicu ribuan event
        const pct = Math.floor((loaded / total) * 100)
        if (pct === lastPct.current) return
        lastPct.current = pct
        setProgress({ loaded, total })
      })
      if (data.status !== 'ok') {
        setError(withMessage('Unggahan gagal', data.message, 'Coba lagi atau pilih file lain.'))
        return
      }
      onNext({ sourceType: 'video', path: data.path, filename: data.filename, reused: data.reused ? 'upload' : false })
    } catch (err) {
      if (err?.name === 'AbortError') setAborted(true)
      else setError(NO_SERVER)
    } finally {
      xhrRef.current = null
      checkRef.current = null
      setChecking(false)
      setUploading(false)
    }
  }

  // Saat memeriksa, XHR belum dikirim (abort() XHR tidak berefek): yang
  // dibatalkan pemeriksaannya; startUpload lalu berhenti sebelum mengunggah
  const cancelUpload = () => {
    if (checkRef.current) checkRef.current.abort()
    else xhrRef.current?.abort()
  }

  const handleNext = () => {
    setError('')
    setAborted(false)
    if (sourceType === 'camera') {
      onNext({ sourceType: 'camera', camIndex })
      return
    }
    if (sourceType === 'rtsp') {
      const host = rtspHostOf(camHost)
      onNext({ sourceType: 'rtsp', url: rtspUrlOf(host, camUser, camPass), host, camHost, camUser, camPass })
      return
    }
    if (useActive && activeVideo && !videoFile) {
      onNext({ sourceType: 'video', path: activeVideo.path, filename: activeVideo.filename })
      return
    }
    if (videoFile) startUpload()
  }

  // Alasan tombol nonaktif. Opsi "video yang sedang aktif" hanya disebut
  // kalau memang tersedia.
  const hasVideo = Boolean(videoFile) || (useActive && Boolean(activeVideo))
  let reason = ''
  if (!sourceType) reason = 'Pilih sumber video untuk melanjutkan.'
  else if (sourceType === 'video' && !hasVideo) {
    reason = activeVideo
      ? 'Pilih file video atau pakai video yang sedang aktif.'
      : 'Pilih file video untuk melanjutkan.'
  } else if (sourceType === 'rtsp' && (!rtspHostOf(camHost) || !camUser.trim() || !camPass)) {
    reason = 'Isi alamat IP, username, dan password kamera untuk melanjutkan.'
  }

  const pct = progress.total ? (progress.loaded / progress.total) * 100 : 0
  const sizeText = checking
    ? 'Mencari di server deteksi…'
    : `${formatMB(progress.loaded)} dari ${formatMB(progress.total)} MB`
  // Seluruh file sudah terkirim: server deteksi tetap menyimpannya walau
  // koneksi diputus, jadi "Batalkan" tidak lagi ditawarkan sebagai pembatalan
  const sent = progress.total > 0 && progress.loaded >= progress.total

  return (
    <>
      <h1 ref={titleRef} tabIndex={-1} className="wizard-title focus:outline-none">Pilih sumber video</h1>
      <p className="wizard-lead">Rekaman video, kamera USB, atau kamera IP yang terhubung ke komputer ini.</p>

      <fieldset className="opt-list wizard-group" disabled={uploading}>
        <legend className="sr-only">Sumber video</legend>
        <label className="opt">
          <input
            type="radio"
            name="source"
            value="video"
            checked={sourceType === 'video'}
            onChange={() => chooseType('video')}
          />
          <span>
            <span className="opt-title">File video</span>
            <span className="opt-desc">Rekaman MP4, AVI, MOV, MKV, atau WebM.</span>
          </span>
        </label>
        <label className="opt">
          <input
            type="radio"
            name="source"
            value="camera"
            checked={sourceType === 'camera'}
            onChange={() => chooseType('camera')}
          />
          <span>
            <span className="opt-title">Kamera</span>
            <span className="opt-desc">Kamera bawaan atau USB yang terhubung ke komputer ini.</span>
          </span>
        </label>
        <label className="opt">
          <input
            type="radio"
            name="source"
            value="rtsp"
            checked={sourceType === 'rtsp'}
            onChange={() => chooseType('rtsp')}
          />
          <span>
            <span className="opt-title">Kamera IP (CCTV)</span>
            <span className="opt-desc">Kamera jaringan lewat kabel LAN, mis. Hikvision (RTSP).</span>
          </span>
        </label>
      </fieldset>

      {sourceType === 'video' && (
        <div className="wizard-group">
          {videoFile ? (
            <div className="file-row" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
              <span className="file-row-name" title={videoFile.name}>{videoFile.name}</span>
              <span className="file-row-size">{formatMB(videoFile.size)} MB</span>
              <button ref={changeBtnRef} type="button" className="btn btn-sm" onClick={pickFile} disabled={uploading}>
                Ganti file…
              </button>
            </div>
          ) : (
            <div
              className={dragOver ? 'dropzone is-over' : 'dropzone'}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
              onDrop={handleDrop}
            >
              <div className="dropzone-line">
                Seret file video ke sini, atau
                <button type="button" className="btn btn-sm" onClick={pickFile}>Pilih file…</button>
              </div>
              <div className="dropzone-caption">MP4, AVI, MOV, MKV, atau WebM</div>
            </div>
          )}
          {/* Input asli tetap di DOM (sr-only, bukan hidden); keyboard memakai tombolnya.
              value dikosongkan supaya file yang sama bisa dipilih lagi. */}
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => { handleFile(e.target.files[0]); e.target.value = '' }}
          />
          {fileError && <ErrorNote className="mt-2">{fileError}</ErrorNote>}

          {activeVideo && !videoFile && (
            <label className="check-row mt-3">
              <input
                type="checkbox"
                checked={useActive}
                onChange={(e) => { setUseActive(e.target.checked); setError('') }}
              />
              <span>
                <span className="check-row-title">Pakai video yang sedang aktif: {activeVideo.filename}</span>
                <span className="check-row-help">Sudah ada di server deteksi, tidak perlu diunggah ulang.</span>
              </span>
            </label>
          )}
        </div>
      )}

      {sourceType === 'camera' && (
        <div className="wizard-group">
          <span className="field-label" id="cam-label">Indeks kamera</span>
          {/* Radio asli (sr-only) di dalam label: panah kiri/kanan tetap berfungsi */}
          <div className="seg flex mt-2" role="radiogroup" aria-labelledby="cam-label">
            {[0, 1, 2, 3].map(i => (
              <label key={i}>
                <input
                  type="radio"
                  className="sr-only"
                  name="camera"
                  value={i}
                  checked={camIndex === i}
                  onChange={() => setCamIndex(i)}
                />
                {i}
              </label>
            ))}
          </div>
          <p className="help mt-2">Kamera bawaan biasanya 0. Kamera USB biasanya 1 atau lebih.</p>
        </div>
      )}

      {sourceType === 'rtsp' && (
        <div className="wizard-group grid gap-4">
          <div>
            <label className="field-label" htmlFor="cam-host">Alamat IP kamera</label>
            <input
              id="cam-host"
              className="text-input mt-2"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="192.168.1.64"
              value={camHost}
              onChange={(e) => setCamHost(e.target.value)}
            />
            <p className="help mt-2">IP kamera terlihat di SADP Tool. Port bawaan 554.</p>
          </div>
          <div className="field-grid">
            <div>
              <label className="field-label" htmlFor="cam-user">Username</label>
              <input
                id="cam-user"
                className="text-input mt-2"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={camUser}
                onChange={(e) => setCamUser(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="cam-pass">Password</label>
              <input
                id="cam-pass"
                className="text-input mt-2"
                type="password"
                autoComplete="new-password"
                value={camPass}
                onChange={(e) => setCamPass(e.target.value)}
              />
            </div>
          </div>
          <p className="help">
            Password yang dibuat saat aktivasi kamera. Dipakai stream utama
            (1080p, {RTSP_PATH}); selama sesi berjalan disimpan terenkripsi di
            komputer ini hanya untuk menyambung ulang otomatis.
          </p>
        </div>
      )}

      {uploading ? (
        <div className="wizard-group upload">
          <div className="upload-head">
            <span className="upload-name" title={videoFile.name}>
              {checking ? 'Memeriksa' : 'Mengunggah'} {videoFile.name}
            </span>
            <span className="upload-size">{sizeText}</span>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-label={`${checking ? 'Memeriksa' : 'Mengunggah'} ${videoFile.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
            aria-valuetext={sizeText}
          >
            {/* Lebar diset per event (tiap 1 %), tanpa transisi */}
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div>
            {/* aria-disabled (bukan disabled) supaya fokus keyboard tidak jatuh ke <body> */}
            <button
              type="button"
              className="btn btn-sm"
              autoFocus
              aria-disabled={sent}
              onClick={() => { if (!sent) cancelUpload() }}
            >
              Batalkan
            </button>
            {sent && <p className="help mt-2" role="status">Menyimpan di server deteksi…</p>}
          </div>
        </div>
      ) : (
        <div className="wizard-group grid gap-2">
          <button
            ref={nextRef}
            type="button"
            className="btn btn-primary w-full"
            disabled={Boolean(reason)}
            onClick={handleNext}
          >
            Lanjut
          </button>
          {reason && <p className="reason">{reason}</p>}
          {error && <ErrorNote>{error}</ErrorNote>}
          {aborted && (
            <div className="note" role="status"><p>Unggahan dibatalkan.</p></div>
          )}
        </div>
      )}
    </>
  )
}

// ─── POST /configure ──────────────────────────────────────────
// Dipakai langkah 2 dan tombol "Coba lagi" di halaman gambar zona.
// Mengembalikan JSON jawaban backend ({ status, message?, ... }).
async function sendConfigure(sourceInfo, roiMode) {
  const body = {
    source_type: sourceInfo.sourceType,
    roi_mode:    roiMode,
  }
  if (sourceInfo.sourceType === 'video') body.path = sourceInfo.path
  else if (sourceInfo.sourceType === 'rtsp') body.url = sourceInfo.url
  else body.camera_index = sourceInfo.camIndex

  const res = await fetch(`${API_BASE}/configure`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  return res.json()
}

// ─── Langkah 2: cara menentukan zona ─────────────────────────
function StepZoneMode({ sourceInfo, initialMode, focusTitle, onNext, onBack }) {
  const [roiMode, setRoiMode] = useState(initialMode ?? null)   // 'auto' | 'manual'
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const titleRef = useRef(null)

  useEffect(() => { if (focusTitle) titleRef.current?.focus() }, [focusTitle])

  const handleNext = async () => {
    if (!roiMode) return
    setLoading(true)
    setError('')
    try {
      const data = await sendConfigure(sourceInfo, roiMode)
      if (data.status !== 'ok') { setError(withMessage('Sumber video tidak bisa dibuka', data.message)); return }
      onNext(roiMode)
    } catch {
      setError(NO_SERVER)
    } finally {
      setLoading(false)
    }
  }

  const name = sourceLabelOf(sourceInfo)

  return (
    <>
      <h1 ref={titleRef} tabIndex={-1} className="wizard-title focus:outline-none">Tentukan zona larangan parkir</h1>
      <p className="wizard-lead">Kendaraan yang berhenti di dalam zona dihitung lama berhentinya.</p>
      <div className="mt-3 flex min-w-0">
        <span className="meta">
          <span className="meta-label">Sumber</span>
          <span className="meta-value" title={name}>{name}</span>
        </span>
      </div>
      {sourceInfo?.reused === 'check' && (
        <p className="help mt-2">Video yang sama sudah ada di server deteksi, jadi tidak diunggah ulang.</p>
      )}
      {sourceInfo?.reused === 'upload' && (
        <p className="help mt-2">Isi video ini sama dengan {name} yang sudah ada di server deteksi, jadi file itu yang dipakai.</p>
      )}

      {/* "Seluruh frame" (roi_mode 'auto') sengaja di urutan pertama: pilihan yang disarankan */}
      <fieldset className="opt-list wizard-group" disabled={loading}>
        <legend className="sr-only">Cara menentukan zona</legend>
        <label className="opt">
          <input
            type="radio"
            name="roi-mode"
            value="auto"
            checked={roiMode === 'auto'}
            onChange={() => setRoiMode('auto')}
          />
          <span>
            <span className="opt-title">Seluruh frame</span>
            <span className="opt-tag">Disarankan</span>
            <span className="opt-desc">
              Semua kendaraan yang berhenti di mana pun dalam gambar dihitung lama berhentinya.
            </span>
          </span>
        </label>
        <label className="opt">
          <input
            type="radio"
            name="roi-mode"
            value="manual"
            checked={roiMode === 'manual'}
            onChange={() => setRoiMode('manual')}
          />
          <span>
            <span className="opt-title">Gambar zona</span>
            <span className="opt-desc">
              Tandai satu atau beberapa area pada frame. Kendaraan di luar area tidak dihitung.
            </span>
          </span>
        </label>
      </fieldset>

      <section className="wizard-group" aria-labelledby="wz-rule-title">
        <h2 id="wz-rule-title" className="block-title">Aturan waktu</h2>
        <RuleLane className="mt-3" />
      </section>

      <div className="wizard-group">
        <div className="wizard-actions">
          <button type="button" className="btn" onClick={onBack} disabled={loading}>Kembali</button>
          <button type="button" className="btn btn-primary" disabled={!roiMode || loading} onClick={handleNext}>
            {loading ? 'Menyiapkan sumber…' : roiMode === 'manual' ? 'Lanjut ke gambar zona' : 'Mulai pemantauan'}
          </button>
        </div>
        {!roiMode && <p className="reason mt-2">Pilih cara menentukan zona untuk melanjutkan.</p>}
        {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      </div>
    </>
  )
}

// Hitungan detik 1 Hz selama frame pertama ditunggu, tanda sistem masih
// bekerja (di mini PC membuka sumber bisa beberapa menit). Komponen sendiri
// supaya tiap detik hanya teks ini yang dirender ulang; mulai dari 0 lagi
// setiap kali dipasang (mis. setelah "Coba lagi").
function FrameWait({ slow }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const id = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="well-msg z-[15]">
      <p className="well-msg-title">Mengambil frame pertama… <span className="tnum">{secs}</span> dtk</p>
      {slow && (
        <p>Server deteksi masih membuka sumber video. Di komputer ini bisa beberapa menit. Tidak perlu diulang.</p>
      )}
    </div>
  )
}

// ─── Langkah 2b: gambar zona ─────────────────────────────────
// Area gambar = ZoneEditor (klik dikunci ke piksel video + kaca pembesar).
// Panel samping lebarnya tetap 300px supaya kotak frame tidak berubah
// ukuran selama menggambar.
function StepDrawZones({ sourceInfo, onDone, onBack }) {
  const [zones,      setZones]      = useState([])     // zona selesai
  const [current,    setCurrent]    = useState([])     // titik zona yang sedang digambar
  const [cleared,    setCleared]    = useState(null)   // { zones, current } sebelum "Hapus semua"
  const [saving,     setSaving]     = useState(false)
  const [retrying,   setRetrying]   = useState(false)  // "Coba lagi" sedang mengirim /configure
  const [error,      setError]      = useState(null)   // { at: 'finish' | 'save', text }
  const [retryError, setRetryError] = useState('')
  const stageRef     = useRef(null)
  const clearBtnRef  = useRef(null)
  const refocusClear = useRef(false)

  // Frame pertama milik sumber yang BARU dikonfigurasi (polling sampai siap)
  const { frame, slow, procError, noSource, reload } = useFirstFrame()
  const failed  = Boolean(procError) || noSource     // frame tidak akan datang
  const loading = !frame && !failed

  // Tombol yang sedang difokus keyboard bisa jadi nonaktif setelah dipakai;
  // fokus dipindah ke kotak frame supaya tidak jatuh ke <body>
  const focusEditor = () => stageRef.current?.querySelector('.zone-box')?.focus()

  // Setelah "Hapus semua" diurungkan, baris sebaris hilang; fokus ke tombolnya lagi
  useEffect(() => {
    if (cleared || !refocusClear.current) return
    refocusClear.current = false
    clearBtnRef.current?.focus()
  }, [cleared])

  // p sudah ternormalisasi (0..1) dan dikunci ke pusat piksel video oleh ZoneEditor
  const addPoint = (p) => {
    setCurrent(prev => [...prev, p])
    setCleared(null)   // keadaan sudah berubah, "Hapus semua" tidak bisa diurungkan lagi
    setError(null)
  }

  const finishZone = () => {
    if (saving) return
    if (current.length < 3) { setError({ at: 'finish', text: 'Satu zona butuh minimal 3 titik.' }); return }
    setZones(prev => [...prev, current])
    setCurrent([])
    setError(null)
  }

  const undoPoint = () => {
    if (saving) return
    if (current.length > 0) setCurrent(prev => prev.slice(0, -1))
    else if (zones.length > 0) setZones(prev => prev.slice(0, -1))
  }

  const clearAll = () => {
    setCleared({ zones, current })
    setZones([])
    setCurrent([])
    setError(null)
  }

  const restoreCleared = () => {
    if (!cleared) return
    setZones(cleared.zones)
    setCurrent(cleared.current)
    refocusClear.current = true
    setCleared(null)
  }

  // e.detail === 0: diaktifkan dari keyboard (Enter/Spasi), bukan klik mouse
  const handleFinishClick = (e) => {
    finishZone()
    if (e.detail === 0) focusEditor()
  }

  const handleUndoClick = (e) => {
    const emptyAfter = current.length + zones.length === 1
    undoPoint()
    if (emptyAfter && e.detail === 0) focusEditor()
  }

  // "Coba lagi": processor tidak membuka ulang sumber yang gagal dengan
  // sendirinya, jadi konfigurasinya dikirim ulang dulu (POST /configure,
  // isi sama dengan langkah 2) baru polling frame diulang.
  const handleRetry = async () => {
    setRetrying(true)
    setRetryError('')
    try {
      const data = await sendConfigure(sourceInfo, 'manual')
      if (data.status !== 'ok') { setRetryError(withMessage('Sumber video tidak bisa dibuka', data.message)); return }
      reload()
    } catch {
      setRetryError(NO_SERVER)
    } finally {
      setRetrying(false)
    }
  }

  const handleSave = async () => {
    const finalZones = current.length >= 3 ? [...zones, current] : zones
    if (finalZones.length === 0) { setError({ at: 'save', text: 'Gambar minimal 1 zona.' }); return }

    setSaving(true)
    setError(null)
    try {
      const roisPayload = finalZones.map(roi => roi.map(p => [p.x, p.y]))
      const res = await fetch(`${API_BASE}/set_roi`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rois: roisPayload }),
      })
      const data = await res.json()
      if (data.status !== 'ok') { setError({ at: 'save', text: withMessage('Zona tidak tersimpan', data.message) }); return }
      onDone(finalZones.length)
    } catch {
      setError({ at: 'save', text: NO_SERVER })
    } finally {
      setSaving(false)
    }
  }

  const nothingDrawn = current.length === 0 && zones.length === 0
  const saveCount    = zones.length + (current.length >= 3 ? 1 : 0)
  const name         = sourceLabelOf(sourceInfo)

  return (
    <div className="editor-page">
      <WizardBar step={2} />
      <main className="editor-body">
        {/* Pembungkus hitam. Border/padding TIDAK dipasang di ZoneEditor: rumus
            klik ke piksel butuh <img> dan <canvas> mengisi kotak yang sama.
            Kolom flex supaya ZoneEditor tetap setinggi pembungkus di layar sempit
            (tinggi baris auto, min-height 360). */}
        <div ref={stageRef} className="editor-stage flex flex-col">
          <ZoneEditor
            frame={frame}
            zones={zones}
            current={current}
            onAddPoint={addPoint}
            onUndo={undoPoint}
            onFinish={finishZone}
            autoFocus
            disabled={saving}
            className="flex-1 min-h-0"
          />

          {frame && nothingDrawn && (
            <div className="plate-video absolute top-3 left-1/2 -translate-x-1/2 z-[15] whitespace-nowrap">
              Klik frame untuk menambah titik zona
            </div>
          )}

          {loading && <FrameWait slow={slow} />}

          {/* Frame tidak akan datang (processor gagal membuka sumber, atau backend
              belum punya sumber): tampilkan penyebabnya + jalan keluar */}
          {failed && (
            <div className="absolute inset-0 z-[15] grid place-items-center p-4">
              <div className="note note-frame" role="alert">
                <FaultGlyph />
                <div>
                  <p>
                    <strong>
                      {procError
                        ? `Processor berhenti: ${procError}`
                        : 'Server deteksi belum punya sumber video, mungkin karena baru dijalankan ulang.'}
                    </strong>
                  </p>
                  <p>Pilih Coba lagi setelah sumber siap, atau Kembali untuk mengganti sumber atau cara menentukan zona.</p>
                  <div className="note-actions">
                    <button type="button" className="btn btn-sm" onClick={onBack}>Kembali</button>
                    <button type="button" className="btn btn-sm btn-primary" onClick={handleRetry} disabled={retrying}>
                      {retrying ? 'Mengirim ulang…' : 'Coba lagi'}
                    </button>
                  </div>
                  {retryError && <p className="mt-3">{retryError}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="editor-side" aria-labelledby="wz-draw-title">
          {/* Bagian atas bisa digulir kalau daftar zona panjang; tombol tetap terlihat */}
          <div className="editor-side-scroll scroll-thin">
            <h1 id="wz-draw-title" className="side-title">Gambar zona larangan parkir</h1>
            <span className="meta">
              <span className="meta-label">Sumber</span>
              <span className="meta-value" title={name}>{name}</span>
            </span>
            <ol className="steps">
              <li>Klik sudut-sudut zona pada frame.</li>
              <li>Pilih Selesaikan zona setelah minimal 3 titik. Ulangi untuk zona lain.</li>
              <li>Pilih Simpan dan mulai.</li>
            </ol>
            <p className="side-note">
              Kaca pembesar menunjukkan piksel video di bawah kursor. Titik disimpan tepat pada koordinat X dan Y yang tertera.
            </p>
            <p className="side-note-dim">
              Keyboard: panah menggeser 1 piksel, Shift dan panah 10 piksel, Enter menambah titik, Backspace mengurungkan.
            </p>

            <section aria-labelledby="wz-zone-list-title">
              <div className="zone-list-head">
                <h2 id="wz-zone-list-title" className="zone-list-title">Zona</h2>
                <span className="zone-list-count">{zones.length} selesai</span>
              </div>
              {nothingDrawn ? (
                <p className="zone-empty">Belum ada zona. Klik frame untuk menaruh titik pertama.</p>
              ) : (
                <ul>
                  {zones.map((zone, i) => (
                    <li key={i} className="zone-row">
                      <span className="zone-row-name">Zona {i + 1}</span>
                      <span className="zone-row-count">{zone.length} titik</span>
                    </li>
                  ))}
                  {current.length > 0 && (
                    <li className="zone-row is-draft">
                      <span className="zone-row-name">Zona {zones.length + 1} sedang digambar</span>
                      <span className="zone-row-count">{current.length} titik</span>
                    </li>
                  )}
                </ul>
              )}
            </section>
          </div>

          <div className="editor-actions">
            <button
              type="button"
              className="btn w-full"
              disabled={current.length < 3 || saving}
              onClick={handleFinishClick}
            >
              Selesaikan zona {zones.length + 1}
            </button>
            {current.length < 3 && <p className="reason">Butuh minimal 3 titik (sekarang {current.length}).</p>}
            {error?.at === 'finish' && <ErrorNote>{error.text}</ErrorNote>}

            <div className="btn-pair">
              <button
                type="button"
                className="btn btn-sm"
                title="Urungkan titik terakhir (Backspace)"
                disabled={nothingDrawn || saving}
                onClick={handleUndoClick}
              >
                Urungkan
              </button>
              <button
                ref={clearBtnRef}
                type="button"
                className="btn btn-sm"
                disabled={nothingDrawn || saving}
                onClick={clearAll}
              >
                Hapus semua
              </button>
            </div>
            {cleared && (
              <div className="inline-line" role="status">
                <span>Semua zona dihapus.</span>
                <button type="button" className="btn btn-sm" autoFocus onClick={restoreCleared}>Urungkan</button>
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={saving || saveCount === 0}
              onClick={handleSave}
            >
              {saving ? 'Menyimpan…' : `Simpan ${saveCount} zona dan mulai`}
            </button>
            {saveCount === 0 && !saving && <p className="reason">Gambar minimal 1 zona.</p>}
            {error?.at === 'save' && <ErrorNote>{error.text}</ErrorNote>}

            <button type="button" className="btn w-full" disabled={saving} onClick={onBack}>Kembali</button>
          </div>
        </aside>
      </main>
    </div>
  )
}

// ─── Wizard ──────────────────────────────────────────────────
// onComplete(info): info = { ...sourceInfo, roiMode: 'auto' | 'manual', zoneCount? }
// sourceInfo video = { sourceType: 'video', path, filename },
//            kamera = { sourceType: 'camera', camIndex },
//         kamera IP = { sourceType: 'rtsp', url, host, camHost, camUser, camPass }
// zoneCount (jumlah zona yang disimpan) hanya ada untuk mode manual.
export default function SetupWizard({ onComplete }) {
  const [step,       setStep]       = useState('source')   // 'source' | 'zone' | 'draw'
  const [sourceInfo, setSourceInfo] = useState(null)
  const [roiMode,    setRoiMode]    = useState(null)       // diingat saat kembali dari gambar zona
  // Judul langkah difokus hanya setelah berpindah langkah (tombol yang ditekan
  // ikut hilang), bukan saat wizard pertama dibuka
  const [moved,      setMoved]      = useState(false)

  const go = (next) => { setMoved(true); setStep(next) }

  const handleSourceNext = (info) => { setSourceInfo(info); go('zone') }
  const handleModeNext = (mode) => {
    setRoiMode(mode)
    if (mode === 'auto') onComplete({ ...sourceInfo, roiMode: 'auto' })   // seluruh frame: langsung ke dashboard
    else go('draw')
  }

  if (step === 'draw') {
    return (
      <StepDrawZones
        sourceInfo={sourceInfo}
        onDone={(n) => onComplete({ ...sourceInfo, roiMode: 'manual', zoneCount: n })}
        onBack={() => go('zone')}
      />
    )
  }

  return (
    <div className="wizard-shell">
      <WizardBar step={step === 'source' ? 1 : 2} />
      <main className="wizard-col">
        {step === 'source' ? (
          <StepSource initial={sourceInfo} focusTitle={moved} onNext={handleSourceNext} />
        ) : (
          <StepZoneMode
            sourceInfo={sourceInfo}
            initialMode={roiMode}
            focusTitle={moved}
            onNext={handleModeNext}
            onBack={() => go('source')}
          />
        )}
      </main>
    </div>
  )
}
