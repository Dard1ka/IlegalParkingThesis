/**
 * AlertSidebar.jsx
 * ─────────────────────────────────────────────────────────────
 * Daftar kendaraan yang berhenti di zona, satu baris per kendaraan dengan
 * lajur waktu 0–6 menit (garis 1 mnt dan 5 mnt menyambung lurus di semua baris).
 *
 * Props:
 *   alerts      data dari useAlerts()
 *   multiZone   tampilkan "Zona n" hanya kalau zonanya lebih dari satu
 *   connected   status WebSocket
 *   staleSince  kapan koneksi putus (Date), null kalau tersambung
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { StatusGlyph } from './Glyphs'
import RuleLane, { LANE, lanePct } from './RuleLane'

// Nama kelas ditulis utuh (bukan `is-${status}`): Tailwind hanya menyimpan
// kelas yang ditemukan lengkap di sumber.
const ROW_CLASS = {
  monitoring: 'vrow is-monitoring',
  warning:    'vrow is-warning',
  violation:  'vrow is-violation',
  safe:       'vrow is-safe',
}
const STATUS_WORD = { monitoring: 'Memantau', warning: 'Peringatan', violation: 'Pelanggaran', safe: 'Aman' }
const KNOWN_STATUS = new Set(Object.keys(ROW_CLASS))
const STATUS_ORDER = { violation: 0, warning: 1, monitoring: 2, safe: 3 }
// Hitungan selain pelanggaran di kalimat ringkasan, urut seperti daftar
const SUMMARY_PARTS = [['warning', 'peringatan'], ['monitoring', 'memantau'], ['safe', 'aman']]

// Sama dengan bahasa_label / warna_label di backend/processor.py, supaya teks
// di daftar cocok dengan suara peringatan. Warna "Unknown" tidak ditulis.
const VEHICLE_LABEL = { car: 'Mobil', truck: 'Truk', bus: 'Bus', motorcycle: 'Motor', motor: 'Motor' }
const COLOR_LABEL = {
  black: 'hitam', white: 'putih', gray: 'abu-abu', red: 'merah',
  orange: 'oranye', yellow: 'kuning', brown: 'cokelat', green: 'hijau',
  cyan: 'biru muda', blue: 'biru', purple: 'ungu', pink: 'pink',
}

const HOUR_S = 3600
const NO_ALERTS = []   // default tetap: array baru tiap render akan memicu useMemo terus

const pad2 = (n) => String(n).padStart(2, '0')

// Durasi pakai titik dua (3:48, 1:02:05); jam dinding pakai titik (21.26.14)
function fmtDuration(s) {
  const h = Math.floor(s / HOUR_S)
  const m = Math.floor((s % HOUR_S) / 60)
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`
}

// Versi yang dibacakan screen reader: "3 menit 48 detik"
function spokenDuration(s) {
  const h = Math.floor(s / HOUR_S)
  const text = `${Math.floor((s % HOUR_S) / 60)} menit ${s % 60} detik`
  return h > 0 ? `${h} jam ${text}` : text
}

function fmtClock(date) {
  return `${pad2(date.getHours())}.${pad2(date.getMinutes())}.${pad2(date.getSeconds())}`
}

function vehicleName(type, color) {
  const t = String(type ?? '').toLowerCase()
  const c = String(color ?? '').toLowerCase()
  const kind = VEHICLE_LABEL[t] ?? (type || 'Kendaraan')
  const colour = c && c !== 'unknown' ? (COLOR_LABEL[c] ?? c) : ''
  return colour ? `${kind} ${colour}` : kind
}

// Jarak ke batas berikutnya. Hanya untuk title lajur dan teks screen reader,
// tidak ditampilkan sebagai teks (lajur dan durasi sudah menunjukkannya).
function countdown(status, d, fmt) {
  if (status === 'monitoring') return `Peringatan dalam ${fmt(Math.max(0, LANE.WARN_S - d))}`
  if (status === 'warning') return `Pelanggaran dalam ${fmt(Math.max(0, LANE.VIOL_S - d))}`
  if (status === 'violation') return `Lewat batas ${fmt(Math.max(0, d - LANE.VIOL_S))}`
  return 'Segitiga pengaman terdeteksi'
}

function toRow(a) {
  return {
    id: a.id,
    status: KNOWN_STATUS.has(a.status) ? a.status : 'monitoring',
    d: Math.max(0, Math.floor(Number(a.duration) || 0)),
    zone: a.zone,
    vehicle: vehicleName(a.type, a.color),
  }
}

// Pelanggaran, peringatan, memantau, aman; lalu durasi terlama; lalu id terkecil
function byPriority(a, b) {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.d - a.d || Number(a.id) - Number(b.id) || 0
}

function srSentence(r, multiZone) {
  const zone = multiZone ? `, zona ${r.zone}` : ''
  return `${STATUS_WORD[r.status]}. ${r.vehicle}, LID${r.id}${zone}. ` +
    `Berhenti ${spokenDuration(r.d)}. ${countdown(r.status, r.d, spokenDuration)}.`
}

function liveText(r, multiZone) {
  const zone = multiZone ? `, zona ${r.zone}` : ''
  const head = r.status === 'violation' ? 'Pelanggaran baru' : 'Peringatan'
  return `${head}: ${r.vehicle} LID${r.id}${zone}, ${spokenDuration(r.d)}.`
}

// Rona merah baris pelanggaran. Memudar sekali hanya saat status benar-benar
// berubah menjadi pelanggaran; kelasnya dilepas setelah selesai supaya baris
// yang dipindah saat urutan berubah (DOM move) tidak memutar ulang animasinya.
function ViolationTint({ animate }) {
  const [anim, setAnim] = useState(animate)
  return (
    <span
      aria-hidden="true"
      className={anim ? 'vrow-tint tint-in' : 'vrow-tint'}
      onAnimationEnd={() => setAnim(false)}
    />
  )
}

function VehicleRow({ row, prev, multiZone }) {
  const { id, status, d, zone, vehicle } = row
  return (
    <li className={ROW_CLASS[status]}>
      {status === 'violation' && <ViolationTint animate={prev !== undefined && prev !== 'violation'} />}
      <span className="vrow-glyph" aria-hidden="true"><StatusGlyph status={status} size={18} /></span>
      <span className="vrow-status" aria-hidden="true">
        <span className="vrow-word">{STATUS_WORD[status]}</span>
        <span className="vrow-lid">{`LID${id}`}</span>
      </span>
      <span className="vrow-meta" aria-hidden="true">
        <span className="vrow-vehicle">{vehicle}</span>
        {multiZone && <span className="vrow-zone">{`Zona ${zone}`}</span>}
      </span>
      {/* Lebar isi diganti langsung tiap tick, tanpa animasi */}
      <span className="lane" aria-hidden="true" title={countdown(status, d, fmtDuration)}>
        <span className="lane-track" />
        <span className="lane-rule r1" />
        <span className="lane-rule r5" />
        <span className="lane-fill" style={{ width: `${lanePct(d)}%` }} />
        {d > LANE.MAX_S && <span className="lane-cap" />}
      </span>
      <span className={d >= HOUR_S ? 'vrow-dur is-long' : 'vrow-dur'} aria-hidden="true">{fmtDuration(d)}</span>
      <span className="sr-only">{srSentence(row, multiZone)}</span>
    </li>
  )
}

export default function AlertSidebar({ alerts = NO_ALERTS, multiZone = false, connected = true, staleSince = null }) {
  const { rows, counts } = useMemo(() => {
    const counts = { violation: 0, warning: 0, monitoring: 0, safe: 0 }
    const rows = alerts.map(toRow)
    for (const r of rows) counts[r.status] += 1
    rows.sort(byPriority)
    return { rows, counts }
  }, [alerts])

  // Status terakhir per id, diperbarui setelah setiap perubahan alerts. Pesan
  // pertama hanya mengisi Map: id yang belum pernah terlihat tidak dianggap
  // berubah status, jadi tidak beranimasi dan tidak diumumkan. Id yang hilang
  // sengaja tidak dihapus: kendaraan yang sempat tertutup lalu muncul lagi
  // sebagai pelanggaran tetap terhitung berubah status.
  const prevStatus = useRef(new Map())
  const [live, setLive] = useState(null)

  useEffect(() => {
    const prev = prevStatus.current
    const lines = []
    for (const r of rows) {
      const before = prev.get(r.id)
      if (before !== undefined && before !== r.status && (r.status === 'violation' || r.status === 'warning')) {
        lines.push(liveText(r, multiZone))
      }
      prev.set(r.id, r.status)
    }
    if (lines.length > 0) setLive((p) => ({ seq: (p ? p.seq : 0) + 1, text: lines.join(' ') }))
  }, [rows, multiZone])

  // Data basi: WebSocket putus, daftar tetap menampilkan keadaan terakhir
  const staleAt = !connected && staleSince ? new Date(staleSince) : null
  const stale = staleAt !== null

  const others = SUMMARY_PARTS
    .filter(([key]) => counts[key] > 0)
    .map(([key, word]) => `${counts[key]} ${word}`)
    .join(', ')

  return (
    <section className={stale ? 'vlist is-stale' : 'vlist'} aria-labelledby="vlist-title">
      <div className="vlist-head">
        <div className="vlist-title-row">
          <h2 id="vlist-title" className="vlist-title">Kendaraan berhenti di zona</h2>
          <span className="vlist-total">{rows.length}</span>
        </div>
        {(rows.length > 0 || stale) && (
          <p className="vlist-summary">
            {/* Ringkasan selalu dibungkus elemen: .vlist-stale:first-child (tanpa
                margin) hanya boleh kena kalau cap waktunya berdiri sendiri */}
            {rows.length > 0 && (counts.violation > 0 ? (
              <>
                <span className="vlist-summary-alarm">{`${counts.violation} pelanggaran`}</span>
                {others && `, ${others}`}
              </>
            ) : (
              <span>{others ? `Tidak ada pelanggaran. ${others}.` : 'Tidak ada pelanggaran.'}</span>
            ))}
            {/* Spasi biasa: margin saja tidak memisahkan kata bagi screen reader */}
            {stale && rows.length > 0 && ' '}
            {stale && <span className="vlist-stale">{`Data terakhir ${fmtClock(staleAt)}`}</span>}
          </p>
        )}
      </div>

      {rows.length > 0 ? (
        <>
          <div className="vlist-cols" aria-hidden="true">
            <span className="vlist-cols-status">Status</span>
            <span className="vlist-cols-lane">
              <span className="at-1">{`${LANE.WARN_S / 60} mnt`}</span>
              <span className="at-5">{`${LANE.VIOL_S / 60} mnt`}</span>
            </span>
            <span className="vlist-cols-dur">Lama</span>
          </div>
          <ul className="vlist-body">
            {rows.map((r) => (
              <VehicleRow key={r.id} row={r} prev={prevStatus.current.get(r.id)} multiZone={multiZone} />
            ))}
          </ul>
        </>
      ) : (
        <div className="vlist-empty">
          <p className="vlist-empty-title">Belum ada kendaraan berhenti di zona.</p>
          <p className="vlist-empty-text">Kendaraan yang berhenti di zona muncul di sini beserta lama berhentinya.</p>
          <RuleLane />
        </div>
      )}

      {/* Hanya perubahan menjadi peringatan atau pelanggaran. Elemen diganti
          (key baru) supaya teks yang kebetulan sama tetap dibacakan ulang. */}
      <div className="sr-only" aria-live="polite">
        {live && <span key={live.seq}>{live.text}</span>}
      </div>
    </section>
  )
}
