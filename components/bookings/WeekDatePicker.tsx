'use client'

import { useState } from 'react'
import Popover from '@/components/ui/Popover'
import Glyph from '@/components/ui/Glyph'
import {
  MONTHS_LONG,
  WEEKDAYS_NARROW,
  formatMonthLabel,
  getMondayString,
  offsetDate,
  parseDateString,
  toDateString,
} from '@/lib/dates'
import styles from './WeekDatePicker.module.css'

interface WeekDatePickerProps {
  /** "W 24" — the badge label. */
  label: string
  /** Monday of the week currently on screen. */
  weekStart: string
  /** Today in the company's timezone. */
  today: string
  /** Called with the Monday of the week the picked day belongs to. */
  onPickWeek: (monday: string) => void
}

/**
 * The week badge and its month-calendar popover (screen 06).
 *
 * The design fills a single selected day; here the unit of selection is a week,
 * so every day of the week on screen carries the fill. Same colours, same
 * geometry, same amber-on-black for today.
 */
export default function WeekDatePicker({ label, weekStart, today, onPickWeek }: WeekDatePickerProps) {
  const [open, setOpen] = useState(false)
  const start = parseDateString(weekStart)
  const [cursor, setCursor] = useState({ year: start.getUTCFullYear(), month: start.getUTCMonth() })

  const weekEnd = offsetDate(weekStart, 6)

  function step(delta: number) {
    setCursor((c) => {
      const next = c.month + delta
      if (next < 0) return { year: c.year - 1, month: 11 }
      if (next > 11) return { year: c.year + 1, month: 0 }
      return { ...c, month: next }
    })
  }

  const firstOfMonth = new Date(Date.UTC(cursor.year, cursor.month, 1))
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate()

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.badge}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label} — pick a week`}
      >
        {label}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className={styles.popover}>
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
            <span key={i} className={styles.dow}>{d}</span>
          ))}
        </div>

        <div className={styles.days}>
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <span key={`blank-${i}`} className={styles.blank} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const date = toDateString(new Date(Date.UTC(cursor.year, cursor.month, i + 1)))
            const selected = date >= weekStart && date <= weekEnd
            const isToday = date === today
            return (
              <button
                key={date}
                type="button"
                className={`${styles.day} ${selected ? styles.selected : ''} ${isToday && !selected ? styles.today : ''}`}
                onClick={() => {
                  onPickWeek(getMondayString(date))
                  setOpen(false)
                }}
                aria-label={`Week of ${date}`}
              >
                {i + 1}
              </button>
            )
          })}
        </div>

        <span className={styles.srOnly}>
          Showing {MONTHS_LONG[cursor.month]} {cursor.year}
        </span>
      </Popover>
    </span>
  )
}
