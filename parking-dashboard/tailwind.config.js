/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // Font dan warna DIGANTI (bukan extend): font-mono/font-serif dan palet
    // bawaan Tailwind (cyan-400 dst.) sengaja tidak ada lagi. Nilai warna
    // ada di src/index.css (token :root, ikut tema terang/gelap).
    fontFamily: {
      // UI dan kalimat: Segoe UI lokal (tidak dibundel)
      sans: ['"Segoe UI"', 'system-ui', '-apple-system', '"Noto Sans"', 'sans-serif'],
      // Teks bergaya rambu: Overpass (dibundel, lihat src/main.jsx)
      sign: ['"Overpass Variable"', '"Segoe UI"', 'sans-serif'],
    },
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      black: '#000000',
      white: '#FFFFFF',
      bg: 'var(--bg)',
      panel: 'var(--panel)',
      control: 'var(--control)',
      'control-hover': 'var(--control-hover)',
      'control-pressed': 'var(--control-pressed)',
      separator: 'var(--separator)',
      border: 'var(--border)',
      text: 'var(--text)',
      'text-2': 'var(--text-2)',
      'text-3': 'var(--text-3)',
      focus: 'var(--focus)',
      primary: 'var(--primary)',
      'on-primary': 'var(--on-primary)',
      'st-memantau': 'var(--st-memantau)',
      'st-aman': 'var(--st-aman)',
      'st-peringatan': 'var(--st-peringatan)',
      'st-pelanggaran': 'var(--st-pelanggaran)',
      'tint-pelanggaran': 'var(--tint-pelanggaran)',
      well: 'var(--well)',
      'on-well': 'var(--on-well)',
      'on-well-2': 'var(--on-well-2)',
      'well-line': 'var(--well-line)',
      'sign-red': 'var(--sign-red)',
      'sign-white': 'var(--sign-white)',
      'sign-black': 'var(--sign-black)',
      'warn-fill': 'var(--warn-fill)',
      'lane-track': 'var(--lane-track)',
      'lane-rule': 'var(--lane-rule)',
      'lane-normal': 'var(--lane-normal)',
    },
    extend: {
      // Skala huruf desain (ukuran/tinggi baris dalam px): text-12 … text-18
      fontSize: {
        12: ['12px', '16px'],
        13: ['13px', '18px'],
        14: ['14px', '20px'],
        15: ['15px', '20px'],
        18: ['18px', '24px'],
      },
      // Kelas `border` polos = garis struktur; batas kontrol memakai border-border
      borderColor: {
        DEFAULT: 'var(--separator)',
      },
    },
  },
  // Utilitas efek yang mahal tanpa GPU dimatikan sama sekali. Tailwind juga
  // membuat kelas dari kata biasa di sumber (mis. `.filter(` di JS, "ring" di
  // komentar), jadi tanpa ini .blur / .filter / .ring tetap ikut ter-build.
  // Bayangan yang diizinkan (baris opsi, cincin fokus kanvas) ada di index.css.
  corePlugins: {
    boxShadow: false, boxShadowColor: false,
    ringWidth: false, ringColor: false, ringOpacity: false, ringOffsetWidth: false, ringOffsetColor: false,
    backgroundImage: false, gradientColorStops: false,
    filter: false, blur: false, brightness: false, contrast: false, dropShadow: false, grayscale: false,
    hueRotate: false, invert: false, saturate: false, sepia: false,
    backdropFilter: false, backdropBlur: false, backdropBrightness: false, backdropContrast: false,
    backdropGrayscale: false, backdropHueRotate: false, backdropInvert: false, backdropOpacity: false,
    backdropSaturate: false, backdropSepia: false,
    transitionProperty: false, transitionDuration: false, transitionDelay: false, transitionTimingFunction: false,
    animation: false,
  },
  plugins: [],
}
