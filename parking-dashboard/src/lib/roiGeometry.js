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
 * Posisi kursor → piksel VIDEO di bawahnya (bilangan bulat 0..imgW-1,
 * 0..imgH-1). imgW/imgH harus ukuran asli frame (= ukuran video, karena
 * /first_frame dikirim dalam resolusi asli). `inside` = false kalau kursor
 * ada di bar hitam / di luar gambar; x/y lalu ditarik ke tepi terdekat.
 */
export function clientToVideoPixel(clientX, clientY, boxRect, imgW, imgH) {
  const img = getImageRect(boxRect.width, boxRect.height, imgW, imgH)
  if (!img) return null
  const fx = (clientX - boxRect.left - img.x) / img.w
  const fy = (clientY - boxRect.top  - img.y) / img.h
  return {
    x: Math.min(imgW - 1, Math.max(0, Math.floor(fx * imgW))),
    y: Math.min(imgH - 1, Math.max(0, Math.floor(fy * imgH))),
    inside: fx >= 0 && fx < 1 && fy >= 0 && fy < 1,
  }
}

/**
 * Piksel video → titik ternormalisasi di PUSAT piksel itu. Backend
 * (processor._decode_roi) menghitung int(x * W), dan int(((px + 0.5) / W) * W)
 * = px, jadi titik yang disimpan jatuh tepat di piksel yang diklik — termasuk
 * piksel paling kanan/bawah (tidak pernah W / H, satu piksel di luar frame).
 */
export function videoPixelToNormalized(px, py, imgW, imgH) {
  return { x: (px + 0.5) / imgW, y: (py + 0.5) / imgH }
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
