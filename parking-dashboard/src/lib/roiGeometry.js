/**
 * roiGeometry.js
 * ─────────────────────────────────────────────────────────────
 * Geometri editor zona (ROI). Dipakai wizard (StepDrawROI) dan
 * panel "Update Zona" supaya keduanya menghasilkan koordinat
 * yang sama persis.
 *
 * Frame ditampilkan dengan `object-contain`: kalau rasio container
 * berbeda dari rasio video, gambar diberi bar hitam (letterbox).
 * Backend mengalikan titik ROI langsung dengan lebar/tinggi VIDEO,
 * jadi titik harus dinormalisasi terhadap kotak GAMBAR yang tampil,
 * bukan terhadap kotak canvas yang menutupi seluruh container.
 */

/**
 * Kotak gambar yang benar-benar tampil di dalam container
 * (aturan object-contain: skala seragam, posisi di tengah).
 * Satuannya mengikuti boxW/boxH. Mengembalikan null kalau ada
 * ukuran yang belum diketahui.
 */
export function getImageRect(boxW, boxH, imgW, imgH) {
  if (!(boxW > 0 && boxH > 0 && imgW > 0 && imgH > 0)) return null
  const scale = Math.min(boxW / imgW, boxH / imgH)
  const w = imgW * scale
  const h = imgH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))

/**
 * Posisi klik (clientX/clientY) → titik ternormalisasi 0..1
 * terhadap gambar. `boxRect` = getBoundingClientRect() milik canvas.
 * Klik di bar hitam ditarik ke tepi gambar terdekat, jadi hasilnya
 * tidak pernah keluar dari 0..1.
 */
export function clientToNormalized(clientX, clientY, boxRect, imgW, imgH) {
  const img = getImageRect(boxRect.width, boxRect.height, imgW, imgH)
  if (!img) return null
  return {
    x: clamp01((clientX - boxRect.left - img.x) / img.w),
    y: clamp01((clientY - boxRect.top  - img.y) / img.h),
  }
}

/**
 * Titik ternormalisasi → piksel canvas, untuk menggambar polygon.
 * `imgRect` = hasil getImageRect() memakai ukuran buffer canvas.
 */
export function normalizedToCanvas(point, imgRect) {
  return {
    x: imgRect.x + point.x * imgRect.w,
    y: imgRect.y + point.y * imgRect.h,
  }
}
