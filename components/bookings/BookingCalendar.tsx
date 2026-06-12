'use client'

import { useState } from 'react'
import styles from './BookingCalendar.module.css'

const MONTHS = [
  'JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
  'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER',
]
const DOW = ['MO','TU','WE','TH','FR','SA','SU']

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fromKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}

interface BookingCalendarProps {
  start: string | null
  end: string | null
  onChange: (s: string, e: string | null) => void
}

export default function BookingCalendar({ start, end, onChange }: BookingCalendarProps) {
  const today = new Date()
  const [view, setView] = useState(() => {
    if (start) {
      const d = fromKey(start)
      return new Date(d.getFullYear(), d.getMonth(), 1)
    }
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  // Phase flag: distinguishes "just picked a start" (next click extends to a range)
  // from a completed selection (next click resets to a new start).
  const [awaitingEnd, setAwaitingEnd] = useState(false)

  const y = view.getFullYear()
  const m = view.getMonth()
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7
  const daysInMonth = new Date(y, m + 1, 0).getDate()

  const cells: (Date | null)[] = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d))

  const todayKey = keyOf(today)

  function pick(d: Date) {
    const k = keyOf(d)
    if (!awaitingEnd || !start) {
      // First click: start == end (a valid one-day booking), then await the end.
      onChange(k, k)
      setAwaitingEnd(true)
    } else {
      // Second click: set the end, sorting so the earlier date is the start.
      if (fromKey(k) < fromKey(start)) onChange(k, start)
      else onChange(start, k)
      setAwaitingEnd(false)
    }
  }

  return (
    <div className={styles.cal}>
      <div className={styles.calHead}>
        <button
          type="button"
          onClick={() => setView(new Date(y, m - 1, 1))}
          aria-label="Previous month"
        >
          ‹
        </button>
        <span>{MONTHS[m]} {y}</span>
        <button
          type="button"
          onClick={() => setView(new Date(y, m + 1, 1))}
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <div className={styles.calDow}>
        {DOW.map((d) => <span key={d}>{d}</span>)}
      </div>

      <div className={styles.calGrid}>
        {cells.map((d, i) => {
          if (!d) return <span key={i} className={styles.calEmpty} />
          const k = keyOf(d)
          const isStart = k === start
          const isEnd = k === (end ?? start)
          const isSolo = isStart && (!end || end === start)
          const inRange = !!(start && end && fromKey(k) > fromKey(start) && fromKey(k) < fromKey(end))
          const isToday = k === todayKey && !isStart && !isEnd

          let cls = styles.calDay
          if (isSolo) cls += ' ' + styles.calDaySolo
          else if (isStart) cls += ' ' + styles.calDayStart
          else if (isEnd) cls += ' ' + styles.calDayEnd
          if (inRange) cls += ' ' + styles.calDayMid
          if (isToday) cls += ' ' + styles.calDayToday

          return (
            <button type="button" key={i} className={cls} onClick={() => pick(d)}>
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}
