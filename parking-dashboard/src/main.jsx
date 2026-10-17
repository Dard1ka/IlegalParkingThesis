import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Overpass (keluarga huruf rambu jalan) dibundel ke dist/, bukan Google Fonts,
// supaya tampil sama saat offline. Teks biasa memakai Segoe UI bawaan Windows.
import '@fontsource-variable/overpass'
import './index.css'
import App from './App.jsx'

// Mode ringan: buka dashboard dengan ?lite di URL (mis. http://localhost:4173/?lite).
// Untuk PC tanpa akselerasi GPU, lihat bagian "Mode ringan" di index.css.
if (new URLSearchParams(window.location.search).has('lite')) {
  document.documentElement.classList.add('lite')
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
