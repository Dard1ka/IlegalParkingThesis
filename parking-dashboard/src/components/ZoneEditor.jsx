/**
 * ZoneEditor.jsx
 * ─────────────────────────────────────────────────────────────
 * Area gambar zona (frame + canvas polygon + kaca pembesar). Dipakai
 * wizard (Gambar zona) dan dialog "Ubah zona", jadi keduanya
 * menghasilkan titik yang sama persis.
 *
 * Ketepatan:
 *   • Klik dikunci ke PIKSEL VIDEO di bawah kursor (clientToVideoPixel),
 *     lalu disimpan sebagai pusat piksel itu (videoPixelToNormalized).
 *     Backend menghitung int(x·W) → hasilnya piksel yang sama.
 *   • Bar hitam (letterbox object-contain) diperhitungkan; klik di bar
 *     ditarik ke tepi frame terdekat.
 *   • Kaca pembesar + pembacaan "X  Y" menunjukkan piksel yang akan
 *     disimpan sebelum diklik.
 *
 * Keyboard (tambahan, jalur klik tidak berubah): kotak bisa difokus.
 * Panah menggeser 1 piksel video (Shift: 10), Enter menambah titik lewat
 * videoPixelToNormalized yang sama dengan klik, Backspace = onUndo,
 * Ctrl+Enter = onFinish. Bidik 11×11 + kaca pembesar menunjuk piksel itu.
 *
 * Ringan: gerakan mouse diproses paling banyak sekali per frame
 * (requestAnimationFrame) dan langsung ke DOM/canvas, tanpa render ulang
 * React. Keyboard juga langsung ke DOM. Tidak ada animasi yang berjalan.
 *
 * <img> dan <canvas> HARUS mengisi kotak yang sama (absolute inset-0, tanpa
 * border/padding/transform sendiri) — rumus normalisasi bergantung padanya.
 *
 * Props:
 *   frame       — { url, width, height } dari useFirstFrame (atau null)
 *   zones       — zona selesai: array of array of {x,y} (0..1)
 *   current     — titik zona yang sedang dibuat: array of {x,y}
 *   onAddPoint  — dipanggil dengan {x,y} (0..1) saat frame diklik / Enter
 *   onUndo      — opsional, Backspace
 *   onFinish    — opsional, Ctrl+Enter
 *   autoFocus   — true = kotak difokus saat dipasang
 *   disabled    — true = klik dan tombol edit diabaikan (mis. sedang menyimpan)
 *   className / style — untuk kotak luar
 *   children    — overlay tambahan (petunjuk, status loading, error)
 */
import { useCallback, useEffect, useRef } from 'react'
import { clientToVideoPixel, videoPixelToNormalized, getImageRect, normalizedToCanvas } from '../lib/roiGeometry'
import { drawZones, drawLoupe } from '../lib/roiDraw'

const LOUPE_SIZE = 140   // px CSS
const LOUPE_ZOOM = 7     // 1 piksel video = 7 px CSS di kaca pembesar
const LOUPE_GAP  = 18    // jarak kaca pembesar dari kursor

const BOX_LABEL = 'Frame untuk menggambar zona. Panah menggeser 1 piksel, Shift dan panah 10 piksel, '
  + 'Enter menambah titik, Backspace mengurungkan, Ctrl dan Enter menyelesaikan zona.'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Fokus dari keyboard (Tab, atau fokus program setelah interaksi keyboard)?
// Fokus karena klik mouse tidak memunculkan bidik keyboard.
function isFocusVisible(el) {
  try { return el.matches(':focus-visible') } catch { return false }
}

// Taruh kaca pembesar di kanan-atas titik (lx, ly: px CSS di dalam kotak);
// pindah sisi kalau mepet tepi kotak. Dipakai mouse dan keyboard.
function placeLoupe(wrap, lx, ly, boxW) {
  const wrapH = wrap.offsetHeight || LOUPE_SIZE + 30
  let x = lx + LOUPE_GAP
  let y = ly - wrapH - LOUPE_GAP
  if (x + LOUPE_SIZE > boxW - 4) x = lx - LOUPE_SIZE - LOUPE_GAP
  if (y < 4) y = ly + LOUPE_GAP
  wrap.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

export default function ZoneEditor({
  frame, zones, current, onAddPoint, onUndo, onFinish, autoFocus = false,
  disabled = false, className = '', style, children,
}) {
  const boxRef     = useRef(null)
  const imgRef     = useRef(null)
  const canvasRef  = useRef(null)
  const loupeWrap  = useRef(null)
  const loupeRef   = useRef(null)
  const readoutRef = useRef(null)
  const rafRef     = useRef(0)
  const lastMove   = useRef(null)
  const redrawRef  = useRef(null)
  const kbRef      = useRef(null)    // titik keyboard {x,y} dalam piksel video
  const kbCross    = useRef(null)
  const kbShown    = useRef(false)   // bidik keyboard sedang tampil
  const kbShowRef  = useRef(null)

  const redraw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    if (!frame) {
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, c.width, c.height)
      return
    }
    drawZones(c, zones, current, frame.width, frame.height)
  }, [frame, zones, current])

  useEffect(() => {
    redrawRef.current = redraw
    redraw()
  }, [redraw])

  // Ukuran kotak berubah (resize jendela, panel dibuka) → gambar ulang,
  // termasuk posisi bidik keyboard kalau sedang tampil
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const obs = new ResizeObserver(() => {
      redrawRef.current?.()
      if (kbShown.current) kbShowRef.current?.()
    })
    obs.observe(box)
    return () => obs.disconnect()
  }, [])

  // Font canvas (dibundel) mungkin baru siap setelah gambar pertama
  useEffect(() => {
    if (document.fonts?.ready) document.fonts.ready.then(() => redrawRef.current?.())
  }, [])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const hideLoupe = () => {
    lastMove.current = null
    if (loupeWrap.current) loupeWrap.current.style.display = 'none'
  }

  const hideKbCross = () => {
    kbShown.current = false
    if (kbCross.current) kbCross.current.style.display = 'none'
  }

  // Bidik keyboard + kaca pembesar yang dipasangnya disembunyikan
  const hideKb = () => {
    if (!kbShown.current) return
    hideKbCross()
    if (loupeWrap.current) loupeWrap.current.style.display = 'none'
  }

  // Frame berganti atau hilang → posisi bidik keyboard lama tidak berlaku
  useEffect(() => { hideKb() }, [frame])

  const updateLoupe = () => {
    rafRef.current = 0
    const m = lastMove.current, c = canvasRef.current, img = imgRef.current, wrap = loupeWrap.current
    if (!m || !c || !img || !wrap || !frame || !img.complete) return
    const box = c.getBoundingClientRect()
    const px = clientToVideoPixel(m.x, m.y, box, frame.width, frame.height)
    if (!px) return
    // Panah keyboard melanjutkan dari piksel terakhir yang ditunjuk mouse
    kbRef.current = { x: px.x, y: px.y }

    wrap.style.display = 'block'
    drawLoupe(loupeRef.current, img, px.x, px.y, LOUPE_ZOOM)
    readoutRef.current.textContent = px.inside
      ? `X ${px.x}   Y ${px.y}`
      : `X ${px.x}   Y ${px.y}   tepi frame`

    // Taruh di kanan-atas kursor; pindah sisi kalau mepet tepi kotak
    placeLoupe(wrap, m.x - box.left, m.y - box.top, box.width)
  }

  const handleMove = (e) => {
    if (!frame) return
    if (kbShown.current) {
      // Chrome bisa mengirim mousemove di posisi yang sama (mis. setelah
      // gulir); itu tidak boleh merebut kaca pembesar dari keyboard
      const m = lastMove.current
      if (m && m.x === e.clientX && m.y === e.clientY) return
      hideKbCross()
    }
    lastMove.current = { x: e.clientX, y: e.clientY }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(updateLoupe)
  }

  const handleClick = (e) => {
    const c = canvasRef.current
    if (!c || !frame || disabled) return
    const px = clientToVideoPixel(e.clientX, e.clientY, c.getBoundingClientRect(), frame.width, frame.height)
    if (!px) return
    // Kaca pembesar langsung menunjuk titik yang baru disimpan (tanpa menunggu
    // frame animasi berikutnya), jadi angka X · Y selalu sama dengan titiknya
    cancelAnimationFrame(rafRef.current)
    // Bidik keyboard yang masih tampil sudah tidak berlaku setelah klik mouse
    if (kbShown.current) hideKbCross()
    lastMove.current = { x: e.clientX, y: e.clientY }
    updateLoupe()
    onAddPoint(videoPixelToNormalized(px.x, px.y, frame.width, frame.height))
  }

  // Titik keyboard sekarang; kosong → tengah frame. Dijepit ke ukuran frame
  // yang tampil, karena frame bisa berganti (Coba lagi)
  const kbPoint = () => {
    const W = frame.width, H = frame.height
    const k = kbRef.current ?? { x: Math.floor(W / 2), y: Math.floor(H / 2) }
    kbRef.current = { x: clamp(k.x, 0, W - 1), y: clamp(k.y, 0, H - 1) }
    return kbRef.current
  }

  // Bidik + kaca pembesar di titik keyboard. Posisi layar memakai rumus yang
  // sama dengan gambar zona (pusat piksel → kotak gambar), dalam px CSS.
  const showKb = () => {
    const c = canvasRef.current, cross = kbCross.current
    if (!c || !cross || !frame) return
    const k = kbPoint()
    const box = c.getBoundingClientRect()
    const rect = getImageRect(box.width, box.height, frame.width, frame.height)
    if (!rect) return
    const p = normalizedToCanvas(videoPixelToNormalized(k.x, k.y, frame.width, frame.height), rect)
    // Gerakan mouse yang masih menunggu frame animasi dibatalkan, supaya
    // kaca pembesar tidak melompat kembali ke kursor
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0

    cross.style.left = `${Math.floor(p.x)}px`
    cross.style.top = `${Math.floor(p.y)}px`
    cross.style.display = 'block'
    kbShown.current = true

    const img = imgRef.current, wrap = loupeWrap.current
    if (!img || !wrap || !img.complete) return
    wrap.style.display = 'block'
    drawLoupe(loupeRef.current, img, k.x, k.y, LOUPE_ZOOM)
    readoutRef.current.textContent = `X ${k.x}   Y ${k.y}`
    placeLoupe(wrap, p.x, p.y, box.width)
  }

  // ResizeObserver dipasang sekali; ia memanggil showKb versi terbaru lewat ref
  useEffect(() => { kbShowRef.current = showKb })

  // Dipasang setelah effect [frame] di atas, supaya bidik yang muncul karena
  // fokus awal tidak langsung disembunyikan lagi. Di dialog, focus() ini
  // terjadi sebelum showModal() dan tidak berpengaruh; dialog memfokuskan
  // kotak ini sendiri setelah terbuka.
  useEffect(() => {
    if (autoFocus) boxRef.current?.focus({ preventScroll: true })
  }, [])

  const handleFocus = (e) => {
    if (e.target !== e.currentTarget || !frame) return
    kbPoint()
    if (isFocusVisible(e.currentTarget)) showKb()
  }

  const handleBlur = (e) => {
    if (e.target === e.currentTarget) hideKb()
  }

  const handleKeyDown = (e) => {
    // Hanya tombol yang ditekan saat kotak ini sendiri yang fokus (bukan
    // tombol di overlay anak). Esc dan Tab dibiarkan lewat ke dialog/halaman.
    if (e.target !== e.currentTarget || !frame || e.altKey || e.metaKey) return
    const step = e.shiftKey ? 10 : 1
    let dx = 0, dy = 0
    switch (e.key) {
      case 'ArrowLeft':  dx = -step; break
      case 'ArrowRight': dx = step; break
      case 'ArrowUp':    dy = -step; break
      case 'ArrowDown':  dy = step; break
      case 'Enter': {
        e.preventDefault()
        // Enter yang ditahan tidak menumpuk titik
        if (e.repeat || disabled) return
        if (e.ctrlKey) { onFinish?.(); return }
        const k = kbPoint()
        onAddPoint(videoPixelToNormalized(k.x, k.y, frame.width, frame.height))
        showKb()
        return
      }
      case 'Backspace':
        e.preventDefault()
        if (!e.repeat && !disabled) onUndo?.()
        return
      default:
        return
    }
    e.preventDefault()
    const k = kbPoint()
    kbRef.current = {
      x: clamp(k.x + dx, 0, frame.width - 1),
      y: clamp(k.y + dy, 0, frame.height - 1),
    }
    showKb()
  }

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="application"
      aria-label={BOX_LABEL}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={`relative overflow-hidden zone-box ${className}`}
      style={{ background: '#000', ...style }}
    >
      {frame && (
        <img
          ref={imgRef}
          src={frame.url}
          alt="Frame video"
          draggable={false}
          className="absolute inset-0 w-full h-full object-contain select-none"
          style={{ zIndex: 1 }}
        />
      )}
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={hideLoupe}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 10, cursor: frame ? (disabled ? 'not-allowed' : 'crosshair') : 'default' }}
      />

      {/* Bidik keyboard (posisi dipasang langsung oleh showKb) */}
      <div ref={kbCross} className="kb-cross" style={{ display: 'none' }} />

      {/* Kaca pembesar + koordinat piksel video (saat kursor di atas frame,
          atau di titik keyboard) */}
      <div
        ref={loupeWrap}
        className="absolute left-0 top-0 pointer-events-none"
        style={{ zIndex: 20, display: 'none', width: LOUPE_SIZE }}
      >
        {/* Bingkai di pembungkus, bukan di canvas: syncCanvasSize membaca kotak
            luar canvas, jadi border di canvas membuat buffer 2 px lebih besar
            dari area tampilnya dan grid piksel ikut diskalakan (buram) */}
        <div className="loupe overflow-hidden" style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }}>
          <canvas ref={loupeRef} className="w-full h-full" />
        </div>
        {/* Lebar minimal = kaca pembesar; "tepi frame" yang lebih panjang
            melebar rata ke dua sisi, tidak keluar dari pelatnya */}
        <div className="mt-2 flex justify-center">
          <div ref={readoutRef} className="plate-video plate-readout min-w-full shrink-0 text-center" />
        </div>
      </div>

      {frame && (
        <div className="plate-video plate-readout absolute bottom-3 left-3 z-[15]">
          Frame {frame.width}×{frame.height} px
        </div>
      )}

      {children}
    </div>
  )
}
