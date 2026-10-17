import { memo, useRef, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { API_BASE, STREAM_URL } from '../config'
import { useFirstFrame } from '../hooks/useFirstFrame'
import ZoneEditor from './ZoneEditor'
import { FaultGlyph, InfoGlyph } from './Glyphs'
import Icon from './Icon'

const STREAM_RETRY_DELAY = 3000   // ms sebelum mencoba menyambung ulang stream

// Catatan render: mini PC menggambar semua frame dengan CPU (tanpa GPU), dan
// stream MJPEG sudah memaksa repaint area video tiap frame baru. Karena itu di
// file ini tidak ada animasi berulang, blur, bayangan, maupun transisi. Legenda
// sengaja di kotak `contain` sendiri di bawah video, jadi repaint MJPEG tidak
// ikut mengecatnya.

// ─── Legenda kotak di video ───────────────────────────────────
// Warna swatch (index.css, --cv-*) sama persis dengan kotak yang digambar
// backend di frame; `en` = kata yang ikut tercetak di frame. Kelas ditulis
// utuh supaya tidak dibuang saat build Tailwind.
const LEGEND = [
  { swatch: 'legend-swatch sw-zona',        label: 'Zona',         en: '(No Parking Zone)' },
  { swatch: 'legend-swatch sw-memantau',    label: 'Memantau',     en: '(monitoring)' },
  { swatch: 'legend-swatch sw-peringatan',  label: 'Peringatan',   en: '(warning)' },
  { swatch: 'legend-swatch sw-aman',        label: 'Aman',         en: '(aman / mogok)' },
  { swatch: 'legend-swatch sw-pelanggaran', label: 'Pelanggaran',  en: '(ILEGAL PARKING)' },
  { swatch: 'legend-swatch sw-luar',        label: 'Di luar zona', en: null },
]

// ─── Dialog "Ubah zona" ───────────────────────────────────────
// <dialog> asli lewat showModal(): fokus terkunci di dalam, halaman di
// belakangnya inert, latar ::backdrop opak datar (tanpa blur). Tetap dirender
// lewat portal ke <body> seperti sebelumnya.

// Zona / titik yang belum tersimpan di server deteksi. Dibandingkan isinya
// (bukan referensi array) dengan zona yang terakhir berhasil disimpan.
function countUnsaved(zones, draft, saved) {
  const savedKeys = new Set(saved.map(z => JSON.stringify(z)))
  const all = draft.length >= 3 ? [...zones, draft] : zones
  return {
    zones:  all.filter(z => !savedKeys.has(JSON.stringify(z))).length,
    points: draft.length >= 3 ? 0 : draft.length,
  }
}

// Pesan backend disisipkan ke kalimat yang sudah diakhiri titik
const stripDot = (s) => String(s).replace(/[\s.]+$/, '')

function ROIUpdatePanel({ onClose, onSaved, procError = null }) {
  const dlgRef       = useRef(null)
  const returnFocus  = useRef(null)   // elemen yang fokus sebelum dialog dibuka
  const confirmFrom  = useRef(null)   // elemen yang fokus sebelum konfirmasi tutup muncul
  const keepDrawRef  = useRef(null)
  const undoClearRef = useRef(null)
  const primaryRef   = useRef(null)

  const [points,     setPoints]     = useState([])
  const [allRois,    setAllRois]    = useState([])
  const [savedZones, setSavedZones] = useState([])     // zona yang terakhir berhasil disimpan
  const [saving,     setSaving]     = useState(false)
  const [result,     setResult]     = useState(null)   // { ok: true, n } | { ok: false, msg }
  const [cleared,    setCleared]    = useState(null)   // isi sebelum "Hapus semua", untuk Urungkan
  const [confirming, setConfirming] = useState(false)  // konfirmasi buang gambar saat menutup
  const [waitSec,    setWaitSec]    = useState(0)

  // Frame diambil SEKALI saat dialog dibuka (bukan tiap render)
  const { frame, slow, procError: frameError, noSource } = useFirstFrame()
  const frameFailed = !frame && (Boolean(frameError) || noSource)
  const waiting     = !frame && !frameFailed

  // Fokus kembali ke tombol pemicu saat dialog ditutup. Harus berjalan SEBELUM
  // effect showModal() di bawah, dan hanya diisi sekali: pada putaran kedua
  // StrictMode fokus sudah berada di dalam dialog.
  useEffect(() => {
    if (!returnFocus.current) returnFocus.current = document.activeElement
    return () => {
      const prev = returnFocus.current
      if (prev && typeof prev.focus === 'function') prev.focus({ preventScroll: true })
    }
  }, [])

  // Penjaga `open`: StrictMode menjalankan effect dua kali, dan showModal()
  // pada dialog yang sudah terbuka melempar error
  useEffect(() => {
    const d = dlgRef.current
    if (!d || d.open) return
    d.showModal()
    // autoFocus ZoneEditor berjalan sebelum showModal(), saat dialog masih
    // tersembunyi, jadi fokus awal ke kotak editor dipasang lagi di sini
    d.querySelector('.zone-box')?.focus({ preventScroll: true })
  }, [])

  // Penghitung detik selama frame belum datang (hanya teks, sekali per detik)
  useEffect(() => {
    if (!waiting) return
    const startedAt = Date.now()
    setWaitSec(0)
    const id = setInterval(() => setWaitSec(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [waiting])

  // Tombol yang difokus diganti / dinonaktifkan → fokus dipindah ke pilihan
  // berikutnya yang masuk akal, supaya pengguna keyboard tidak kehilangan tempat
  useEffect(() => { if (confirming) keepDrawRef.current?.focus() }, [confirming])
  useEffect(() => { if (cleared) undoClearRef.current?.focus() }, [cleared])
  useEffect(() => { if (result?.ok) primaryRef.current?.focus() }, [result])
  // Simpan gagal: tombol sempat nonaktif selama menyimpan sehingga fokus jatuh
  // ke <body>; kembalikan ke tombol simpan (kecuali fokus masih di dalam dialog)
  useEffect(() => {
    if (result && !result.ok && !dlgRef.current?.contains(document.activeElement)) primaryRef.current?.focus()
  }, [result])

  // Fokus ke kotak editor, dipakai saat tombol yang difokus hilang / nonaktif
  const focusEditor = () => dlgRef.current?.querySelector('.zone-box')?.focus({ preventScroll: true })

  const hasAny     = points.length > 0 || allRois.length > 0
  const hasDrawing = allRois.length > 0 || points.length >= 3
  const saved      = result?.ok === true

  // Setiap perubahan gambar membatalkan hasil simpan, tawaran urungkan
  // "Hapus semua", dan konfirmasi tutup yang sedang tampil
  const touched = () => { setResult(null); setCleared(null); setConfirming(false) }

  // Titik dari ZoneEditor sudah dikunci ke piksel video (0..1 terhadap gambar)
  const addPoint = (p) => {
    if (saving) return
    setPoints(prev => [...prev, p])
    touched()
  }

  const finishZone = () => {
    if (saving || points.length < 3) return
    setAllRois(prev => [...prev, points])
    setPoints([])
    touched()
  }

  // Urungkan titik terakhir; kalau zona yang dibuat belum punya titik, zona
  // terakhir yang dihapus (perilaku lama)
  const undoPoint = () => {
    if (saving) return
    if (points.length > 0) setPoints(prev => prev.slice(0, -1))
    else if (allRois.length > 0) setAllRois(prev => prev.slice(0, -1))
    else return
    touched()
  }

  const clearAll = () => {
    if (saving || !hasAny) return
    setCleared({ zones: allRois, points })
    setAllRois([])
    setPoints([])
    setResult(null)
  }

  const restoreCleared = () => {
    if (!cleared) return
    setAllRois(cleared.zones)
    setPoints(cleared.points)
    setCleared(null)
    setResult(null)
    focusEditor()   // tombol Urungkan yang difokus ikut hilang
  }

  const save = async () => {
    const final = points.length >= 3 ? [...allRois, points] : allRois
    if (final.length === 0) { setResult({ ok: false, msg: 'Gambar minimal 1 zona.' }); return }
    setSaving(true)
    setResult(null)
    try {
      const res = await fetch(`${API_BASE}/set_roi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rois: final.map(r => r.map(p => [p.x, p.y])) }),
      })
      const d = await res.json()
      if (d.status === 'ok') {
        // Backend hanya mengantrekan zona; processor memakainya di tick berikutnya.
        // Zona yang sedang digambar (>= 3 titik) ikut tersimpan, jadi dipindah ke daftar.
        setAllRois(final)
        if (points.length >= 3) setPoints([])
        setSavedZones(final)
        setResult({ ok: true, n: final.length })
        onSaved?.(final.length)
      } else {
        setResult({ ok: false, msg: `Zona tidak tersimpan: ${stripDot(d.message || 'penyebab tidak diketahui')}.` })
      }
    } catch {
      setResult({ ok: false, msg: 'Server deteksi tidak merespons. Zona belum tersimpan.' })
    } finally {
      setSaving(false)
    }
  }

  const keepDrawing = () => {
    setConfirming(false)
    const el = confirmFrom.current
    confirmFrom.current = null
    if (el && el !== document.body && el.isConnected && typeof el.focus === 'function') {
      el.focus({ preventScroll: true })
    } else {
      focusEditor()
    }
  }

  // Tutup lewat Esc atau tombol Tutup. Ada gambar yang belum tersimpan →
  // konfirmasi muncul menggantikan tombol, gambar tidak langsung dibuang.
  // Esc saat konfirmasi tampil = batal menutup.
  const requestClose = (fromEsc) => {
    if (confirming) {
      if (fromEsc) keepDrawing()
      return
    }
    const u = countUnsaved(allRois, points, savedZones)
    if (u.zones > 0 || u.points > 0) {
      confirmFrom.current = document.activeElement
      setConfirming(true)
      return
    }
    onClose()
  }

  // Esc juga ditangkap di keydown, bukan hanya lewat event cancel: Chrome hanya
  // mengizinkan cancel dibatalkan sekali sampai ada klik lagi, sehingga Esc kedua
  // (mis. untuk membatalkan konfirmasi) akan menutup paksa dan membuang gambar.
  // preventDefault di keydown mencegah permintaan tutup bawaan itu.
  const handleKeyDown = (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (!e.repeat) requestClose(true)
  }

  // Penjaga yang sama untuk Esc saat fokus berada di luar dialog (mis. jatuh ke
  // <body> setelah tombol yang difokus hilang): keydown itu tidak melewati
  // onKeyDown dialog, dan tanpa ini Esc ketiga menutup dialog dan membuang
  // gambar tanpa konfirmasi. Kalau onKeyDown dialog sudah menanganinya,
  // defaultPrevented sudah true dan event dilewati.
  const requestCloseRef = useRef(null)
  requestCloseRef.current = requestClose
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (!e.repeat) requestCloseRef.current?.(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  let confirmText = null
  if (confirming) {
    const u = countUnsaved(allRois, points, savedZones)
    confirmText = u.zones > 0
      ? `Buang ${u.zones} zona yang belum disimpan?`
      : `Buang ${u.points} titik yang belum disimpan?`
  }

  return createPortal(
    <dialog
      ref={dlgRef}
      className="zone-dialog"
      aria-labelledby="roi-update-title"
      onKeyDown={handleKeyDown}
      onCancel={(e) => { e.preventDefault(); requestClose(true) }}
      // Ditutup browser tanpa lewat requestClose (tidak bisa dicegah) → ikut tutup
      onClose={onClose}
    >
      {/* Area gambar. Pembungkus tidak menambah border/padding ke ZoneEditor:
          rumus klik butuh <img> & <canvas> tanpa border/padding sendiri.
          flex-col: kotak editor tetap terisi walau tinggi pembungkus hanya
          berasal dari min-height (tata letak satu kolom di bawah 1100 px). */}
      <div className="editor-stage flex flex-col">
        <ZoneEditor
          frame={frame}
          zones={allRois}
          current={points}
          onAddPoint={addPoint}
          onUndo={undoPoint}
          onFinish={finishZone}
          disabled={saving}
          autoFocus
          className="flex-1 min-h-0"
        />

        {frame && !hasAny && (
          <div className="plate-video absolute top-3 left-1/2 -translate-x-1/2 z-[15] whitespace-nowrap">
            Klik frame untuk menambah titik zona
          </div>
        )}

        {waiting && (
          <div className="well-msg z-[15]">
            <p className="well-msg-title">Mengambil frame… <span className="tnum">{waitSec}</span> dtk</p>
            {slow && <p>Server deteksi masih membuka sumber video. Tidak perlu diulang.</p>}
          </div>
        )}

        {/* Frame tidak akan datang: processor melapor error atau backend belum
            punya sumber. Dialog ini tidak menyimpan konfigurasi sumber dan
            processor tidak mencoba ulang sendiri, jadi jalan keluarnya lewat
            "Ganti sumber…". */}
        {frameFailed && (
          <div className="absolute inset-0 z-[15] grid place-items-center p-4">
            <div className="note note-frame" role="alert">
              <FaultGlyph />
              <div className="break-words">
                <p><strong>Frame tidak bisa diambil</strong></p>
                <p>
                  {frameError
                    ? `Processor berhenti: ${frameError}`
                    : 'Server deteksi belum punya sumber video, mungkin karena baru dijalankan ulang.'}
                </p>
                <p>Tutup jendela ini, lalu pilih Ganti sumber… di kanan atas untuk mengatur ulang sumber video.</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Panel samping, lebar tetap → area gambar tidak berubah ukuran saat menggambar */}
      <aside className="editor-side">
        <div className="editor-side-scroll scroll-thin">
          <div className="side-head">
            <h2 id="roi-update-title" className="side-title">Ubah zona larangan parkir</h2>
            <button
              type="button"
              className="btn btn-sm"
              title="Tutup (Esc)"
              aria-keyshortcuts="Escape"
              onClick={() => requestClose(false)}
            >
              Tutup
            </button>
          </div>

          <ol className="steps">
            <li>Klik sudut-sudut zona pada frame.</li>
            <li>Pilih Selesaikan zona setelah minimal 3 titik. Ulangi untuk zona lain.</li>
            <li>Pilih Simpan zona.</li>
          </ol>
          <p className="side-note">
            Kaca pembesar menunjukkan piksel video di bawah kursor. Titik disimpan tepat pada koordinat X dan Y yang tertera.
          </p>
          <p className="side-note-dim">
            Keyboard: panah menggeser 1 piksel, Shift dan panah 10 piksel, Enter menambah titik, Backspace mengurungkan.
          </p>

          <div className="note">
            <InfoGlyph />
            <p>Perhatian: menyimpan zona baru mengganti zona aktif dan mengulang hitungan waktu semua kendaraan dari nol.</p>
          </div>

          {/* Pelat error di video tertutup dialog, jadi diulang di sini */}
          {procError && (
            <div className="note" role="alert">
              <FaultGlyph />
              <div className="break-words">
                <p><strong>Processor berhenti: {procError}</strong></p>
                <p>Zona tidak bisa diterapkan. Tutup jendela ini, lalu pilih Ganti sumber… di kanan atas.</p>
              </div>
            </div>
          )}

          <section aria-labelledby="roi-zone-list-title">
            <div className="zone-list-head">
              <h3 id="roi-zone-list-title" className="zone-list-title">Zona</h3>
              <span className="zone-list-count">{allRois.length} selesai</span>
            </div>
            {hasAny ? (
              <ul>
                {allRois.map((roi, i) => (
                  <li key={i} className="zone-row">
                    <span className="zone-row-name">Zona {i + 1}</span>
                    <span className="zone-row-count">{roi.length} titik</span>
                  </li>
                ))}
                {points.length > 0 && (
                  <li className="zone-row is-draft">
                    <span className="zone-row-name">Zona {allRois.length + 1} sedang digambar</span>
                    <span className="zone-row-count">{points.length} titik</span>
                  </li>
                )}
              </ul>
            ) : (
              <p className="zone-empty">Belum ada zona. Klik frame untuk menaruh titik pertama.</p>
            )}
          </section>
        </div>

        <div className="editor-actions">
          {confirming ? (
            <>
              <p id="roi-confirm-title" className="confirm-title">{confirmText}</p>
              <button
                ref={keepDrawRef}
                type="button"
                className="btn btn-primary w-full"
                aria-describedby="roi-confirm-title"
                onClick={keepDrawing}
              >
                Lanjut menggambar
              </button>
              <button type="button" className="btn w-full" aria-describedby="roi-confirm-title" onClick={onClose}>
                Buang zona
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn w-full"
                // e.detail 0 = ditekan dari keyboard: tombol langsung nonaktif,
                // jadi fokus dipindah ke kotak editor agar tidak jatuh ke <body>
                onClick={(e) => { finishZone(); if (e.detail === 0) focusEditor() }}
                disabled={saving || points.length < 3}
              >
                Selesaikan zona {allRois.length + 1}
              </button>
              {points.length < 3 && (
                <p className="reason">Butuh minimal 3 titik (sekarang {points.length}).</p>
              )}

              <div className="btn-pair">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={(e) => {
                    const emptyAfter = points.length + allRois.length === 1
                    undoPoint()
                    if (emptyAfter && e.detail === 0) focusEditor()   // tombol jadi nonaktif
                  }}
                  disabled={saving || !hasAny}
                  title="Urungkan titik terakhir (Backspace)"
                >
                  Urungkan
                </button>
                <button type="button" className="btn btn-sm" onClick={clearAll} disabled={saving || !hasAny}>
                  Hapus semua
                </button>
              </div>
              {cleared && (
                <div className="inline-line" role="status">
                  <span id="roi-cleared-text">Semua zona dihapus.</span>
                  <button
                    ref={undoClearRef}
                    type="button"
                    className="btn btn-sm"
                    aria-describedby="roi-cleared-text"
                    onClick={restoreCleared}
                  >
                    Urungkan
                  </button>
                </div>
              )}

              {/* Setelah berhasil disimpan tombol utama menjadi "Tutup" */}
              <button
                ref={primaryRef}
                type="button"
                className="btn btn-primary w-full"
                onClick={saved ? () => requestClose(false) : save}
                disabled={!saved && (saving || !hasDrawing || Boolean(procError))}
              >
                {saved ? 'Tutup' : saving ? 'Menyimpan…' : 'Simpan zona'}
              </button>
              {!saved && !saving && procError && (
                <p className="reason">Processor berhenti. Zona tidak bisa diterapkan.</p>
              )}
              {!saved && !saving && !procError && !hasDrawing && (
                <p className="reason">Gambar minimal 1 zona.</p>
              )}

              {result && (result.ok ? (
                <div className="note" role="status">
                  <Icon name="check" size={16} />
                  <p>{result.n} zona tersimpan. Berlaku mulai tick berikutnya.</p>
                </div>
              ) : (
                <div className="note" role="alert">
                  <FaultGlyph />
                  <p className="break-words">{result.msg}</p>
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </dialog>,
    document.body,
  )
}

// ─── Kolom video ──────────────────────────────────────────────
// Props (nilai primitif + satu callback tetap dari useCallback, supaya memo efektif):
//   connected    — status WebSocket, dipakai untuk menyambung ulang stream
//   procError    — pesan error processor (null = normal)
//   tickLabel    — hasil formatTick() di App, mis. "1,1 dtk/tick" (ditampilkan apa adanya)
//   tickCount    — proc.tick (jumlah tick yang sudah diproses)
//   sourceLabel  — nama sumber, mis. "input3.mp4" atau "Kamera 0"
//   zoneValue    — "Seluruh frame" / "{n} zona digambar" / "Digambar"
//   onZonesSaved — dipanggil dengan jumlah zona setelah dialog berhasil menyimpan
// Status processor tidak lagi ditampilkan di sini (pindah ke header di App).
function VideoMonitor({
  connected = false,
  procError = null,
  tickLabel = null,
  tickCount = null,
  sourceLabel = null,
  zoneValue = null,
  onZonesSaved,
}) {
  const imgRef       = useRef(null)
  const retryTimer   = useRef(null)    // timer sambung ulang stream
  const wasConnected = useRef(false)   // WebSocket sudah pernah tersambung?
  const pausedRef    = useRef(false)   // stream sengaja dilepas selama dialog terbuka
  const [streamOk,   setStreamOk]   = useState(false)
  const [showUpdate, setShowUpdate] = useState(false)

  // Pasang ulang src → browser membuka koneksi MJPEG baru. Parameter `r` hanya
  // membuat URL-nya berbeda dari yang gagal; backend mengabaikannya. Selama
  // dialog terbuka tidak disambung (timer, WebSocket tersambung ulang).
  const reconnectStream = useCallback(() => {
    clearTimeout(retryTimer.current)
    retryTimer.current = null
    if (pausedRef.current) return
    if (imgRef.current) imgRef.current.src = `${STREAM_URL}?r=${Date.now()}`
  }, [])

  // src dipasang lewat effect (bukan atribut JSX) supaya koneksi MJPEG
  // benar-benar ditutup saat komponen di-unmount (mis. "Ganti sumber…").
  useEffect(() => {
    const img = imgRef.current
    img.src = STREAM_URL
    return () => {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
      img.removeAttribute('src')
    }
  }, [])

  // <img> gagal memuat stream → coba lagi setelah jeda, jangan dibiarkan rusak.
  // Saat dijeda src memang sengaja dilepas, jadi tidak dianggap gagal.
  const handleStreamError = () => {
    if (pausedRef.current) return
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

  // Selama dialog terbuka stream MJPEG dilepas: tidak ada decode JPEG dan
  // repaint di belakang latar dialog
  const openUpdate = useCallback(() => {
    clearTimeout(retryTimer.current)
    retryTimer.current = null
    pausedRef.current = true
    if (imgRef.current) {
      imgRef.current.removeAttribute('src')
      // Tanpa src browser menggambar ikon "gambar rusak" + teks alt di
      // belakang dialog; disembunyikan supaya sumur video tetap hitam polos
      imgRef.current.style.visibility = 'hidden'
    }
    setShowUpdate(true)
  }, [])

  // Bisa terpanggil dua kali (tombol dan event close bawaan); pausedRef
  // menjaga supaya stream hanya disambung ulang sekali
  const closeUpdate = useCallback(() => {
    setShowUpdate(false)
    if (!pausedRef.current) return
    pausedRef.current = false
    if (imgRef.current) imgRef.current.style.visibility = ''
    reconnectStream()
  }, [reconnectStream])

  const hasTick = typeof tickCount === 'number' && Number.isFinite(tickCount)

  return (
    <section className="video-col" aria-label="Video">
      <div className="video-toolbar">
        {sourceLabel && (
          <span className="meta">
            <span className="meta-label">Sumber</span>
            <span className="meta-value" title={sourceLabel}>{sourceLabel}</span>
          </span>
        )}
        {zoneValue && (
          <span className="meta">
            <span className="meta-label">Zona</span>
            <span className="meta-value">{zoneValue}</span>
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm video-toolbar-end"
          aria-haspopup="dialog"
          onClick={openUpdate}
        >
          Ubah zona…
        </button>
      </div>

      {/* Video. <img> MJPEG selalu ter-mount; src hanya diatur effect dan
          handler dialog di atas. */}
      <div className="well">
        <img
          ref={imgRef}
          alt="Video kamera dengan kotak deteksi"
          className="absolute inset-0 w-full h-full object-contain"
          onLoad={() => setStreamOk(true)}
          onError={handleStreamError}
        />

        {/* Latar hitam penuh menutupi ikon gambar rusak bawaan browser */}
        {!streamOk && (
          <div className="well-msg bg-well">
            <p className="well-msg-title">Menghubungkan ke video…</p>
            <p className="break-all">{STREAM_URL}</p>
            <p>Dicoba ulang otomatis setiap 3 detik. Halaman tidak perlu dimuat ulang.</p>
          </div>
        )}

        {/* Processor berhenti / melapor error. Netral, tidak pernah merah. */}
        {procError && (
          <div className="plate-video absolute top-3 left-3 right-3" role="alert">
            <p className="flex items-start gap-2 font-semibold">
              <span className="flex h-5 items-center"><FaultGlyph /></span>
              <span className="min-w-0 break-words">Processor berhenti: {procError}</span>
            </p>
            <p className="text-13 mt-1">Pilih Ganti sumber… untuk mengonfigurasi ulang.</p>
          </div>
        )}
      </div>

      <div className="bezel">
        <ul className="legend" aria-label="Arti kotak di video">
          {LEGEND.map(item => (
            <li key={item.label} className="legend-item">
              <span className={item.swatch} aria-hidden="true" />
              {item.label}
              {item.en && <span className="legend-en">{item.en}</span>}
            </li>
          ))}
        </ul>
        {(tickLabel || hasTick) && (
          <div className="bezel-meta">
            {tickLabel && (
              <span className="num" title="Lama proses tick terakhir di server deteksi">{tickLabel}</span>
            )}
            {hasTick && (
              <span className="bezel-dim">tick ke-<span className="tnum">{tickCount}</span></span>
            )}
          </div>
        )}
      </div>

      {/* Dialog "Ubah zona" (lewat portal ke <body>) */}
      {showUpdate && (
        <ROIUpdatePanel onClose={closeUpdate} onSaved={onZonesSaved} procError={procError} />
      )}
    </section>
  )
}

// memo: Dashboard render ulang tiap pesan WebSocket, sedangkan komponen ini
// hanya perlu ikut render kalau props-nya (nilai primitif dan satu callback
// tetap) berubah.
export default memo(VideoMonitor)
