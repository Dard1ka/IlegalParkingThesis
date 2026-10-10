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
 *      (pesan yang sama persis dengan sebelumnya dilewati)
 *   4. Jika koneksi putus, hook coba reconnect tiap 3 detik
 *   5. Saat komponen unmount, koneksi ditutup bersih
 *
 * Return value:
 *   { alerts, stats, connected, error, proc }
 *   proc = status processor { state, tick, tick_ms, error },
 *          atau null kalau backend tidak mengirimnya / koneksi putus
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { WS_URL } from '../config'

const RETRY_DELAY   = 3000   // ms sebelum reconnect
const PING_INTERVAL = 25000  // ms antara keep-alive ping

export function useAlerts() {
  const [alerts,    setAlerts]    = useState([])
  const [stats,     setStats]     = useState({ total: 0, warning: 0, violation: 0, safe: 0 })
  const [connected, setConnected] = useState(false)
  const [error,     setError]     = useState(null)   // pesan error terakhir
  const [proc,      setProc]      = useState(null)   // status processor (boleh tidak ada)

  const wsRef      = useRef(null)   // instance WebSocket aktif
  const retryTimer = useRef(null)   // timer reconnect
  const pingTimer  = useRef(null)   // timer keep-alive
  const lastRaw    = useRef(null)   // teks pesan terakhir yang sudah diproses

  const clearTimers = () => {
    if (retryTimer.current) { clearTimeout(retryTimer.current);  retryTimer.current = null }
    if (pingTimer.current)  { clearInterval(pingTimer.current);  pingTimer.current  = null }
  }

  const connect = useCallback(() => {
    // Hindari membuka koneksi ganda (termasuk yang masih proses menyambung)
    const current = wsRef.current
    if (current && (current.readyState === WebSocket.OPEN ||
                    current.readyState === WebSocket.CONNECTING)) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError(null)
        clearTimers()
        lastRaw.current = null   // koneksi baru → pesan pertamanya selalu diproses

        // Kirim ping secara berkala agar koneksi tidak di-timeout browser/proxy
        pingTimer.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping')
          }
        }, PING_INTERVAL)
      }

      ws.onmessage = (event) => {
        // Isi pesan sama persis dengan sebelumnya (mis. tick belum selesai)
        // → tidak ada yang berubah, jangan parse dan render ulang
        if (event.data === lastRaw.current) return
        lastRaw.current = event.data

        try {
          const data = JSON.parse(event.data)
          if (Array.isArray(data.alerts)) setAlerts(data.alerts)
          if (data.stats)                  setStats(data.stats)
          setProc(data.proc && typeof data.proc === 'object' ? data.proc : null)
        } catch (err) {
          console.warn('[WS] parse error:', err, event.data?.slice?.(0, 200))
        }
      }

      ws.onclose = (event) => {
        setConnected(false)
        setProc(null)            // selama terputus, status processor tidak diketahui
        lastRaw.current = null
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
      const ws = wsRef.current
      if (ws) {
        // Lepas semua handler dulu: close() pada socket yang masih menyambung
        // memicu onclose berkode 1006 (bukan 1000), yang kalau dibiarkan akan
        // menjadwalkan reconnect terus-menerus setelah komponen di-unmount.
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close(1000, 'Component unmounted')
        wsRef.current = null
      }
    }
  }, [connect])

  return { alerts, stats, connected, error, proc }
}
