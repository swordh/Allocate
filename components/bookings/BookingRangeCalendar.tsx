'use client'

import { useState } from 'react'
import Glyph from '@/components/ui/Glyph'
import {
  WEEKDAYS_NARROW,
  formatMonthLabel,
  parseDateString,
  toDateString,
} from '@/lib/dates'
import styles from './BookingRangeCalendar.module.css'

interface BookingRangeCalendarProps {
  /** "YYYY-MM-DD", inclusive. */
  pickup: string
  ret: string
  /** Which end the next click moves. */
  picking: 'pickup' | 'ret'
  onChange: (next: { pickup: string; ret: string; picking: 'pickup' | 'ret' }) => void
  /** Today in the company's timezone. */
  today: string
}

/**
 * The inline month calendar in the booking form (screen 09).
 *
 * The click pattern is the design's, and it is not the usual "click start,
 * click end" of a two-phase picker:
 *
 *   picking pickup            → set pickup, push ret forward if it fell behind,
 *                               then hand the next click to ret
 *   picking ret, click before pickup → move pickup there, keep picking ret
 *   otherwise                 → set ret, hand the next click back to pickup
 *
 * The effect is that a range is always valid, and clicking backwards past the
 * start extends the range instead of inverting it.
 */
export default function BookingRangeCalendar({
  pickup,
  ret,
  picking,
  onChange,
  today,
}: BookingRangeCalendarProps) {
  const anchor = parseDateString(pickup || today)
  const [cursor, setCursor] = useState({ year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() })

  function step(delta: number) {
    setCursor((c) => {
      const next = c.month + delta
      if (next < 0) return { year: c.year - 1, month: 11 }
      if (next > 11) return { year: c.year + 1, month: 0 }
      return { ...c, month: next }
    })
  }

  function pick(date: string) {
    if (picking === 'pickup') {
      onChange({ pickup: date, ret: date > ret ? date : ret, picking: 'ret' })
      return
    }
    if (date < pickup) {
      onChange({ pickup: date, ret, picking: 'ret' })
      return
    }
    onChange({ pickup, ret: date, picking: 'pickup' })
  }

  const firstOfMonth = new Date(Date.UTC(cursor.year, cursor.month, 1))
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate()

  return (
    <div className={styles.calendar}>
      <div className={styles.head}>
        <button type="button" className={styles.navBtn} onClick={() => step(-1)} aria-label="Previous month">
          <Glyph char="‹" />
        </button>
        <span className={styles.monthLabel}>{formatMonthLabel(cursor.year, cursor.month)}</span>
        <button type="button" className={styles.navBtn} onClick={() => step(1)} aria-label="Next month">
          <Glyph char="›" />
        </button>
      </div>

      <div className={styles.dowRow} aria-hidden="true">
        {WEEKDAYS_NARROW.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div className={styles.days}>
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const date = toDateString(new Date(Date.UTC(cursor.year, cursor.month, i + 1)))
          const isEdge = date === pickup || date === ret
          const inRange = date > pickup && date < ret
          return (
            <button
              key={date}
              type="button"
              onClick={() => pick(date)}
              aria-pressed={isEdge}
              className={`${styles.day} ${isEdge ? styles.edge : ''} ${inRange ? styles.inRange : ''} ${
                date === today && !isEdge && !inRange ? styles.today : ''
              }`}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}
