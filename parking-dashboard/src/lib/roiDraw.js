/**
 * roiDraw.js
 * ─────────────────────────────────────────────────────────────
 * Menggambar zona (ROI) dan kaca pembesar di <canvas>. Dipakai
 * ZoneEditor, jadi wizard dan dialog "Ubah zona" tampil sama.
 *
 * Semua koordinat titik ternormalisasi 0..1 terhadap GAMBAR (lihat
 * roiGeometry.js). Buffer canvas = ukuran CSS × devicePixelRatio supaya
 * garis tajam di layar ber-scaling; posisinya tetap benar karena klik dan
 * gambar sama-sama dinormalisasi terhadap kotak gambar di sistem
 * koordinatnya masing-masing.
 *
 * Warna: satu cyan untuk semua zona, sama dengan garis zona yang dibakar
 * backend ke video, jadi zona di editor dan di video terbaca sebagai benda
 * yang sama. Garis cyan selalu di atas garis hitam 4 px supaya tetap
 * terlihat di atas aspal terang maupun gelap.
 */
import { getImageRect, normalizedToCanvas } from './roiGeometry'

export const ZONE_COLOR = '#00FFFF'

const FONT_SANS = '"Overpass Variable", "Segoe UI", sans-serif'

/** Samakan buffer canvas dengan ukuran tampilnya. Return devicePixelRatio. */
export function syncCanvasSize(canvas) {
  const dpr = window.devicePixelRatio || 1
  // Ukuran kotak pecahan (bukan clientWidth yang dibulatkan), supaya titik
  // yang digambar jatuh di posisi yang sama dengan klik yang menyimpannya
  const box = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.round(box.width * dpr))
  const h = Math.max(1, Math.round(box.height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  return dpr
}

function pathOf(ctx, px, close) {
  ctx.beginPath()
  ctx.moveTo(px[0].x, px[0].y)
  for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y)
  if (close) ctx.closePath()
}

function vertex(ctx, p, r, fill, dpr, ring = 1.5, ringColor = 'rgba(0,0,0,0.85)') {
  ctx.beginPath()
  ctx.arc(p.x, p.y, r * dpr, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = ring * dpr
  ctx.strokeStyle = ringColor
  ctx.stroke()
}

function haloText(ctx, text, x, y, color, dpr) {
  ctx.lineWidth = 3 * dpr
  ctx.strokeStyle = '#000000'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

// Pelat "ZONA n": putih-hitam seperti pelat rambu, satu-satunya teks
// kapital di aplikasi. Teks dipusatkan memakai batas tinta sebenarnya
// (actualBoundingBox), bukan baseline 'middle' yang bergantung metrik font.
function zonePlate(ctx, text, cx, cy, dpr) {
  const size = 12 * dpr
  ctx.font = `700 ${size}px ${FONT_SANS}`
  const spaced = 'letterSpacing' in ctx
  if (spaced) ctx.letterSpacing = `${0.02 * size}px`
  const m = ctx.measureText(text)
  const w = Math.round(m.width + 16 * dpr)
  const h = Math.round(22 * dpr)
  const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2)
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 2 * dpr)
  else ctx.rect(x, y, w, h)
  ctx.fillStyle = '#F7FBF5'
  ctx.fill()
  ctx.lineWidth = 1.5 * dpr
  ctx.strokeStyle = '#161616'
  ctx.stroke()
  const asc = m.actualBoundingBoxAscent || 0.7 * size
  const desc = m.actualBoundingBoxDescent || 0
  ctx.fillStyle = '#161616'
  ctx.textAlign = 'center'
  ctx.fillText(text, x + w / 2, y + h / 2 + (asc - desc) / 2)
  ctx.textAlign = 'left'
  if (spaced) ctx.letterSpacing = '0px'
}

/**
 * Gambar zona selesai (`zones`) + polygon yang sedang dibuat (`current`).
 * frameW/frameH = ukuran asli frame. Return kotak gambar (buffer px) atau null.
 */
export function drawZones(canvas, zones, current, frameW, frameH) {
  const dpr = syncCanvasSize(canvas)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const imgRect = getImageRect(canvas.width, canvas.height, frameW, frameH)
  if (!imgRect) return null
  const toC = (pts) => pts.map((p) => normalizedToCanvas(p, imgRect))
  // Sudut tajam dengan garis 4 px tidak menjulurkan taji hitam
  ctx.lineJoin = 'round'
  ctx.textBaseline = 'alphabetic'

  const centers = zones.map((zone) => {
    const px = toC(zone)
    pathOf(ctx, px, true)
    ctx.fillStyle = 'rgba(0,255,255,0.10)'
    ctx.fill()
    ctx.setLineDash([])
    ctx.lineWidth = 4 * dpr
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.stroke()
    ctx.lineWidth = 2 * dpr
    ctx.strokeStyle = ZONE_COLOR
    ctx.stroke()
    px.forEach((p) => vertex(ctx, p, 4, ZONE_COLOR, dpr))
    return {
      x: px.reduce((s, p) => s + p.x, 0) / px.length,
      y: px.reduce((s, p) => s + p.y, 0) / px.length,
    }
  })
  // Pelat digambar setelah semua zona, supaya garis zona lain tidak memotongnya
  centers.forEach((c, idx) => zonePlate(ctx, `ZONA ${idx + 1}`, c.x, c.y, dpr))

  if (current.length > 0) {
    const px = toC(current)
    if (current.length >= 3) {
      pathOf(ctx, px, true)
      ctx.fillStyle = 'rgba(0,255,255,0.06)'
      ctx.fill()
    }
    pathOf(ctx, px, current.length >= 3)
    ctx.setLineDash([])
    ctx.lineWidth = 4 * dpr
    ctx.strokeStyle = '#000000'
    ctx.stroke()
    ctx.setLineDash([8 * dpr, 5 * dpr])
    ctx.lineWidth = 2 * dpr
    ctx.strokeStyle = ZONE_COLOR
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = `700 ${12 * dpr}px ${FONT_SANS}`
    px.forEach((p, i) => {
      // Titik pertama putih dan lebih besar: titik yang menutup zona
      if (i === 0) vertex(ctx, p, 6, '#FFFFFF', dpr, 2, '#000000')
      else vertex(ctx, p, 4.5, ZONE_COLOR, dpr)
      haloText(ctx, `P${i + 1}`, p.x + 9 * dpr, p.y - 7 * dpr, '#FFFFFF', dpr)
    })
  }
  return imgRect
}

/**
 * Kaca pembesar: potongan frame di sekitar piksel video (px, py), tiap
 * piksel video jadi kotak `zoom` px tanpa smoothing, piksel target diberi
 * bingkai. `img` = elemen <img> frame (ukuran aslinya dipakai drawImage).
 */
export function drawLoupe(canvas, img, px, py, zoom = 7) {
  const dpr = syncCanvasSize(canvas)
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const cell = zoom * dpr
  const cols = Math.ceil(W / cell) | 1           // ganjil → piksel target tepat di tengah
  const rows = Math.ceil(H / cell) | 1
  const half = Math.floor(cols / 2), halfR = Math.floor(rows / 2)
  const ox = W / 2 - (half + 0.5) * cell         // geser supaya sel tengah di pusat canvas
  const oy = H / 2 - (halfR + 0.5) * cell

  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  // Sumber di luar gambar dipotong browser; bagian itu tetap hitam
  const sx = px - half, sy = py - halfR
  const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy)
  const cx1 = Math.min(img.naturalWidth, sx + cols), cy1 = Math.min(img.naturalHeight, sy + rows)
  if (cx1 > cx0 && cy1 > cy0) {
    ctx.drawImage(img, cx0, cy0, cx1 - cx0, cy1 - cy0,
      ox + (cx0 - sx) * cell, oy + (cy0 - sy) * cell, (cx1 - cx0) * cell, (cy1 - cy0) * cell)
  }

  // Garis bidik + bingkai piksel target (hitam di luar, putih di dalam:
  // terbaca di atas piksel terang maupun gelap)
  const tx = ox + half * cell, ty = oy + halfR * cell
  ctx.lineWidth = 1 * dpr
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.beginPath()
  ctx.moveTo(tx + cell / 2, 0); ctx.lineTo(tx + cell / 2, ty)
  ctx.moveTo(tx + cell / 2, ty + cell); ctx.lineTo(tx + cell / 2, H)
  ctx.moveTo(0, ty + cell / 2); ctx.lineTo(tx, ty + cell / 2)
  ctx.moveTo(tx + cell, ty + cell / 2); ctx.lineTo(W, ty + cell / 2)
  ctx.stroke()
  ctx.lineWidth = 2 * dpr
  ctx.strokeStyle = 'rgba(0,0,0,0.9)'
  ctx.strokeRect(tx - 1 * dpr, ty - 1 * dpr, cell + 2 * dpr, cell + 2 * dpr)
  ctx.lineWidth = 1.5 * dpr
  ctx.strokeStyle = '#FFFFFF'
  ctx.strokeRect(tx, ty, cell, cell)
}
