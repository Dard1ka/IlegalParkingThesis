/**
 * config.js
 * ─────────────────────────────────────────────────────────────
 * Satu-satunya tempat alamat backend ditentukan. File lain tidak
 * boleh menulis alamat backend sendiri — impor dari sini.
 *
 *   Default  : host yang sama dengan halaman dashboard, port 8000
 *              (dashboard tetap jalan kalau dibuka dari perangkat
 *              lain di jaringan, bukan cuma dari mesin backend).
 *   Override : set VITE_API_BASE saat `npm run dev` / `npm run build`,
 *              mis. VITE_API_BASE=http://192.168.1.20:8000
 */

// Alamat dasar REST API, tanpa garis miring di akhir
export const API_BASE = (
  import.meta.env.VITE_API_BASE ||
  ('http://' + (window.location.hostname || 'localhost') + ':8000')
).replace(/\/+$/, '')

// http → ws (https → wss)
export const WS_URL     = API_BASE.replace(/^http/, 'ws') + '/ws/alerts'
export const STREAM_URL = API_BASE + '/video_feed'
