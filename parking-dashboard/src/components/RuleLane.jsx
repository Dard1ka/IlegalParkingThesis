/**
 * RuleLane.jsx
 * ─────────────────────────────────────────────────────────────
 * Aturan waktu dalam bentuk lajur 0–6 menit, objek yang sama dengan lajur di
 * setiap baris daftar kendaraan. Batas 60 dtk dan 300 dtk = PARKING_CHECK_SECONDS
 * dan ILLEGAL_PARKING_SECONDS di backend.
 *
 *   <RuleLane />                      (kosong di daftar kendaraan, wizard langkah 2)
 *   import { LANE, lanePct } from './RuleLane'
 *
 * Posisi garis 1 mnt / 5 mnt ada di index.css (.lane-rule.r1 / .r5 dan
 * .at-1 / .at-5): 60/360 = 16,6667 % dan 300/360 = 83,3333 %. Kalau LANE
 * diubah, persentase di CSS ikut diubah.
 */
import { Fragment } from 'react'
import { StatusGlyph } from './Glyphs'

export const LANE = { WARN_S: 60, VIOL_S: 300, MAX_S: 360 }

// Lebar isi lajur (persen) untuk durasi dalam detik. Lewat 6 menit mentok di
// 100; baris menandainya dengan .lane-cap.
export function lanePct(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  return (Math.min(s, LANE.MAX_S) / LANE.MAX_S) * 100
}

const RULES = [
  { status: 'monitoring', term: 'Memantau', range: `0–${LANE.WARN_S} dtk` },
  { status: 'warning', term: 'Peringatan', range: `${LANE.WARN_S}–${LANE.VIOL_S} dtk` },
  { status: 'violation', term: 'Pelanggaran', range: `lebih dari ${LANE.VIOL_S} dtk tanpa segitiga pengaman` },
  { status: 'safe', term: 'Aman', range: `segitiga pengaman terdeteksi setelah ${LANE.WARN_S} dtk` },
]

export function RuleLane({ className = '' }) {
  return (
    <div className={className ? `rule-lane ${className}` : 'rule-lane'}>
      <div className="rule-lane-scale num" aria-hidden="true">
        <span className="at-0">0</span>
        <span className="at-1">{LANE.WARN_S / 60} mnt</span>
        <span className="at-5">{LANE.VIOL_S / 60} mnt</span>
        <span className="at-6">{LANE.MAX_S / 60} mnt</span>
      </div>
      <div className="rule-lane-bar" aria-hidden="true">
        <span className="rule-lane-seg seg-normal" />
        <span className="rule-lane-seg seg-warn" />
        <span className="rule-lane-seg seg-viol" />
        <span className="lane-rule r1" />
        <span className="lane-rule r5" />
      </div>
      <dl className="rule-lane-dl">
        {RULES.map(r => (
          <Fragment key={r.status}>
            <dt><StatusGlyph status={r.status} />{r.term}</dt>
            <dd>{r.range}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

export default RuleLane
