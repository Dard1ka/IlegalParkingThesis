/**
 * Glyphs.jsx
 * ─────────────────────────────────────────────────────────────
 * Simbol status yang diambil dari rambu lalu lintas Indonesia. Semua
 * aria-hidden: glyph selalu berdampingan dengan kata yang dibaca screen
 * reader. Kelas `rambu` / `glyph` dipakai index.css (forced-colors: warna
 * rambu tidak diganti warna sistem).
 *
 *   <Rambu lit={alarm} />            tanda P coret (PM 13/2014), logo aplikasi
 *   <StatusGlyph status="warning" /> monitoring | warning | violation | safe
 *   <FaultGlyph />                   gangguan (currentColor)
 *   <InfoGlyph />                    catatan netral (currentColor)
 */

const P_PATH = 'M9 17.4V6.6h3.2a3.1 3.1 0 0 1 0 6.2H9'
const SLASH = 'M5.2 5.2L18.8 18.8'

// Rambu "Dilarang Parkir". Menyala (warna resmi) hanya saat ada pelanggaran;
// saat diam hanya garis abu-abu. `knockout` = warna permukaan di belakangnya,
// dipakai untuk memotong lingkaran di bawah garis coret.
export function Rambu({ lit, size = 24, knockout = 'var(--bg)' }) {
  if (lit) {
    return (
      <svg className="rambu" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="11.5" fill="#F7FBF5" />
        <circle cx="12" cy="12" r="9.6" fill="none" stroke="#C1121C" strokeWidth="2.6" />
        <path d={P_PATH} fill="none" stroke="#161616" strokeWidth="2.2" strokeLinejoin="round" />
        <path d={SLASH} stroke="#C1121C" strokeWidth="2.6" />
      </svg>
    )
  }
  return (
    <svg className="rambu" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.6" fill="none" stroke="var(--text-2)" strokeWidth="2" />
      <path d={P_PATH} fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round" />
      <path d={SLASH} stroke={knockout} strokeWidth="4.6" />
      <path d={SLASH} stroke="var(--text-2)" strokeWidth="2" />
    </svg>
  )
}

// Glyph status kendaraan; bentuk dan warnanya mengikuti kotak di video.
// Status tak dikenal digambar sebagai Memantau.
export function StatusGlyph({ status, size = 18 }) {
  if (status === 'violation') return <Rambu lit size={size} />

  let shape
  if (status === 'warning') {
    // rambu peringatan: belah ketupat kuning bertepi hitam
    shape = (
      <>
        <path d="M10 1.5 18.5 10 10 18.5 1.5 10Z" fill="#FFD400" stroke="#161616" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="9.1" y="5.6" width="1.8" height="5.8" fill="#161616" />
        <circle cx="10" cy="14.1" r="1.1" fill="#161616" />
      </>
    )
  } else if (status === 'safe') {
    // segitiga pengaman (UU 22/2009 Ps. 121)
    shape = <path d="M10 2.5 18.5 17.5H1.5Z" fill="none" stroke="var(--st-aman)" strokeWidth="2.25" strokeLinejoin="round" />
  } else {
    // kotak kosong, sama dengan kotak deteksi di video
    shape = <rect x="4" y="4" width="12" height="12" fill="none" stroke="var(--st-memantau)" strokeWidth="2.25" />
  }

  return (
    <svg className="glyph" viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" focusable="false">
      {shape}
    </svg>
  )
}

// Gangguan (server terputus, processor berhenti, galat). Tidak pernah merah.
export function FaultGlyph({ size = 16 }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="1.75" y="1.75" width="12.5" height="12.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.1" y="4" width="1.8" height="5" fill="currentColor" />
      <circle cx="8" cy="11.6" r="1.05" fill="currentColor" />
    </svg>
  )
}

// Catatan netral (mis. peringatan "menyimpan zona baru mengganti zona aktif").
// Lingkaran supaya tidak tertukar dengan kotak FaultGlyph.
export function InfoGlyph({ size = 16 }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="4.9" r="1.05" fill="currentColor" />
      <rect x="7.1" y="7" width="1.8" height="5" fill="currentColor" />
    </svg>
  )
}
