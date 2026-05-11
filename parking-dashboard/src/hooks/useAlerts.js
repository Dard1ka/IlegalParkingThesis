/**
 * useAlerts.js
 * ─────────────────────────────────────────────────────────────
 * Custom hook untuk menerima data alert real-time dari backend
 * via WebSocket.
 *
 * Cara kerja:
 *   1. Komponen memanggil useAlerts()
 *   2. Hook membuka koneksi WS ke backend
 *   3. Backend push JSON setiap 1 detik → hook update state
 *   4. Jika koneksi putus, hook coba reconnect tiap 3 detik
 *   5. Saat komponen unmount, koneksi ditutup bersih
 *
 * Return value:
 *   { alerts, stats, connected, error }
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const WS_URL        = 'ws://localhost:8000/ws/alerts'
const RETRY_DELAY   = 3000   // ms sebelum reconnect
const PING_INTERVAL = 25000  // ms antara keep-alive ping

export function useAlerts() {
  const [alerts,    setAlerts]    = useState([])
  const [stats,     setStats]     = useState({ total: 0, warning: 0, violation: 0, safe: 0 })
  const [connected, setConnected] = useState(false)
  const [error,     setError]     = useState(null)   // pesan error terakhir

  const wsRef      = useRef(null)   // instance WebSocket aktif
  const retryTimer = useRef(null)   // timer reconnect
  const pingTimer  = useRef(null)   // timer keep-alive

  const clearTimers = () => {
    if (retryTimer.current) { clearTimeout(retryTimer.current);  retryTimer.current = null }
    if (pingTimer.current)  { clearInterval(pingTimer.current);  pingTimer.current  = null }
  }

  const connect = useCallback(() => {
    // Hindari membuka koneksi ganda
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError(null)
        clearTimers()

        // Kirim ping secara berkala agar koneksi tidak di-timeout browser/proxy
        pingTimer.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping')
          }
        }, PING_INTERVAL)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          // DEBUG: log setiap pesan yang datang
          console.log('[WS] recv', {
            alerts: data.alerts?.length ?? 0,
            stats:  data.stats,
            sample: data.alerts?.[0],
          })
          if (Array.isArray(data.alerts)) setAlerts(data.alerts)
          if (data.stats)                  setStats(data.stats)
        } catch (err) {
          console.warn('[WS] parse error:', err, event.data?.slice?.(0, 200))
        }
      }

      ws.onclose = (event) => {
        setConnected(false)
        clearTimers()

        // Jangan reconnect jika ditutup dengan kode normal (1000 = close clean)
        if (event.code !== 1000) {
          setError(`Koneksi terputus (kode ${event.code}). Mencoba ulang...`)
          retryTimer.current = setTimeout(connect, RETRY_DELAY)
        }
      }

      ws.onerror = () => {
        setError('Backend tidak dapat dijangkau di ' + WS_URL)
        // onclose akan dipanggil setelah onerror, dan reconnect akan dilakukan di sana
      }

    } catch (err) {
      setError('Gagal membuat koneksi WebSocket: ' + err.message)
      retryTimer.current = setTimeout(connect, RETRY_DELAY)
    }
  }, [])

  useEffect(() => {
    connect()

    return () => {
      clearTimers()
      if (wsRef.current) {
        // Code 1000 = normal closure → mencegah auto-reconnect
        wsRef.current.close(1000, 'Component unmounted')
      }
    }
  }, [connect])

  return { alerts, stats, connected, error }
}
