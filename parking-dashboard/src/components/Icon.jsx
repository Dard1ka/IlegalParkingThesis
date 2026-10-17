/**
 * Icon.jsx
 * ─────────────────────────────────────────────────────────────
 * Ikon garis SVG inline (tanpa font ikon, tetap tampil saat offline).
 * Hanya tersisa "check": langkah stepper yang selesai dan catatan zona
 * tersimpan. Simbol UI lain ada di Glyphs.jsx. Warna ikut `currentColor`;
 * ikon selalu aria-hidden (teks di sebelahnya yang dibaca).
 *
 *   <Icon name="check" size={14} />
 */
const ICONS = {
  check: ['M20 6 9 17l-5-5'],
}

export default function Icon({ name, size = 18, strokeWidth = 1.75, className = '', style }) {
  const paths = ICONS[name]
  if (!paths) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      style={style}
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}
