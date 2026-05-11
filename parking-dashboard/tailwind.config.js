/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Rajdhani', 'DM Sans', 'sans-serif'],
        mono: ['"Share Tech Mono"', 'monospace'],
        body: ['"DM Sans"', 'sans-serif'],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'live-ping': 'livePing 2.5s ease-in-out infinite',
        'scan': 'scanline 6s linear infinite',
        'slide-in': 'slideIn 0.35s ease-out forwards',
        'count-in': 'countIn 0.5s ease-out forwards',
      },
      keyframes: {
        livePing: {
          '0%, 100%': { opacity: 1, boxShadow: '0 0 0 0 rgba(0,180,216,0.4)' },
          '50%': { opacity: 0.7, boxShadow: '0 0 0 6px rgba(0,180,216,0)' },
        },
        scanline: {
          '0%': { top: '-10%' },
          '100%': { top: '110%' },
        },
        slideIn: {
          from: { opacity: 0, transform: 'translateX(16px)' },
          to: { opacity: 1, transform: 'translateX(0)' },
        },
        countIn: {
          from: { opacity: 0, transform: 'translateY(10px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
