/**
 * useFirstFrame.js
 * ─────────────────────────────────────────────────────────────
 * Custom hook untuk mengambil frame pertama dari sumber yang
 * sedang dikonfigurasi (GET /first_frame). Dipakai editor zona
 * di wizard dan di panel "Update Zona".
 *
 * Cara kerja:
 *   1. Frame diambil SEKALI saat komponen mount (bukan tiap render)
 *   2. Selama backend menjawab 204 (frame belum siap) hook terus
 *      polling — tanpa batas waktu keras, karena di mesin lambat
 *      membuka sumber bisa makan waktu lama
 *   3. Setelah ~15 detik `slow` jadi true → komponen menampilkan
 *      petunjuk "masih menunggu"
 *   4. Sambil menunggu, hook mengecek GET /status. Polling berhenti
 *      kalau frame memang tidak akan datang:
 *        • processor melapor error (proc.state "error" / proc.error
 *          terisi) → `procError` diisi
 *        • backend tidak punya sumber sama sekali (proc.state
 *          "waiting_source", mis. backend di-restart saat dashboard
 *          masih terbuka) → `noSource` jadi true
 *   5. reload() mengulang polling dari awal. Processor TIDAK membuka
 *      ulang sumber yang gagal dengan sendirinya, jadi pemanggil
 *      harus mengirim POST /configure dulu, baru reload()
 *   6. Saat unmount: timer dibatalkan dan blob URL di-revoke
 *
 * Return value:
 *   { frame, slow, procError, noSource, reload }
 *   frame = null | { url, width, height }   (width/height = ukuran asli gambar)
 */

import { useState, useEffect, useCallback } from 'react'
import { API_BASE } from '../config'

const POLL_INTERVAL   = 500     // ms antar percobaan /first_frame
const STATUS_INTERVAL = 1000    // ms antar pengecekan /status
const SLOW_AFTER      = 15000   // ms sebelum petunjuk "masih menunggu" muncul

// Tepat setelah /configure, processor bisa saja masih melaporkan error milik
// sumber SEBELUMNYA selama sesaat (sebelum sumber baru diambilnya). Karena itu
// state "error" baru dipercaya setelah masa tenggang ini lewat.
const ERROR_GRACE     = 2000    // ms

export function useFirstFrame() {
  const [frame,     setFrame]     = useState(null)   // { url, width, height }
  const [slow,      setSlow]      = useState(false)
  const [procError, setProcError] = useState(null)   // pesan error dari processor
  const [noSource,  setNoSource]  = useState(false)  // backend belum punya sumber
  const [attempt,   setAttempt]   = useState(0)      // naik tiap reload()

  useEffect(() => {
    let cancelled    = false
    let timer        = null
    let objectUrl    = null
    let probe        = null
    let lastStatusAt = 0
    const startedAt  = Date.now()

    const scheduleNext = () => {
      if (Date.now() - startedAt >= SLOW_AFTER) setSlow(true)
      timer = setTimeout(poll, POLL_INTERVAL)
    }

    // Ukur ukuran asli gambar dulu, baru serahkan ke komponen:
    // editor zona butuh width/height untuk menghitung letterbox.
    const showFrame = (blob) => {
      objectUrl = URL.createObjectURL(blob)
      probe = new Image()
      probe.onload = () => {
        if (cancelled) return
        setFrame({ url: objectUrl, width: probe.naturalWidth, height: probe.naturalHeight })
      }
      probe.onerror = () => {
        if (cancelled) return
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
        scheduleNext()
      }
      probe.src = objectUrl
    }

    // true = frame tidak akan datang → polling berhenti. Dua penyebab:
    // processor melapor error (state "error", atau thread-nya berhenti dengan
    // pesan error), atau backend tidak punya sumber sama sekali.
    const frameUnavailable = async () => {
      try {
        const res  = await fetch(`${API_BASE}/status`)
        const data = await res.json()
        const proc = data?.proc   // backend lama belum mengirim "proc" → dilewati
        if (!proc) return false
        if (proc.state === 'error' || proc.error) {
          if (!cancelled) setProcError(proc.error || 'penyebab tidak diketahui')
          return true
        }
        // Setelah /configure backend melapor "opening_source" sampai sumbernya
        // terbuka, jadi "waiting_source" hanya terbaca kalau memang belum ada
        // sumber (mis. backend baru di-restart) — bukan sumber yang sedang dibuka.
        if (proc.state === 'waiting_source') {
          if (!cancelled) setNoSource(true)
          return true
        }
        return false
      } catch {
        return false
      }
    }

    const poll = async () => {
      try {
        // no-store: frame harus milik sumber yang sekarang, jangan dari cache
        const res = await fetch(`${API_BASE}/first_frame`, { cache: 'no-store' })
        if (cancelled) return
        if (res.ok && res.status !== 204) {
          const blob = await res.blob()
          if (!cancelled) showFrame(blob)
          return
        }
      } catch {
        // Backend belum bisa dijangkau — dicoba lagi di putaran berikutnya
      }
      if (cancelled) return

      // Belum ada frame: sesekali cek apakah frame memang tidak akan datang
      const now = Date.now()
      if (now - startedAt >= ERROR_GRACE && now - lastStatusAt >= STATUS_INTERVAL) {
        lastStatusAt = now
        if (await frameUnavailable()) return
        if (cancelled) return
      }

      scheduleNext()
    }

    poll()

    return () => {
      cancelled = true
      clearTimeout(timer)
      if (probe) { probe.onload = null; probe.onerror = null }
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attempt])

  const reload = useCallback(() => {
    setFrame(null)
    setSlow(false)
    setProcError(null)
    setNoSource(false)
    setAttempt(n => n + 1)
  }, [])

  return { frame, slow, procError, noSource, reload }
}
