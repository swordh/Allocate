/**
 * Date helpers shared by the bookings views, their server shells and the
 * booking form.
 *
 * Two rules hold everywhere in here:
 *
 * 1. A booking's `startDate` / `endDate` is a *civil* date — "YYYY-MM-DD" with
 *    no zone attached, inclusive in both ends. It must never be pushed through
 *    a local-time `new Date(str)`, which shifts it a day either way depending
 *    on where the browser sits. Every date string is parsed as UTC midnight and
 *    formatted back with `timeZone: 'UTC'`, so the civil date that goes in is
 *    the civil date that comes out.
 *
 * 2. The company's timezone (`CompanyPreferences.timezone`) decides two things
 *    only: which civil date counts as "today", and how a real instant
 *    (`createdAt`, `startTime`, `endTime`) renders. Use `todayInTimezone` for
 *    the former and `formatTimeInZone` / `formatStampInZone` for the latter.
 *
 * Safe to import from both Server and Client Components — no `server-only`.
 */

export const MONTHS_SHORT = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const

export const MONTHS_LONG = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const

/** Monday first — the whole design is Monday-first. */
export const WEEKDAYS_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

/** The one-letter row above a month grid. Two T's and two S's is intentional. */
export const WEEKDAYS_NARROW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ── parsing / formatting primitives ─────────────────────────────────────────

/** "YYYY-MM-DD" → Date at UTC midnight. Invalid input yields an Invalid Date. */
export function parseDateString(date: string): Date {
  if (!DATE_RE.test(date)) return new Date(NaN)
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Date → "YYYY-MM-DD", read in UTC so it round-trips with parseDateString. */
export function toDateString(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Today's civil date in the company's zone, as "YYYY-MM-DD". */
export function todayInTimezone(timezone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    // An unknown zone must not take a whole view down; fall back to UTC.
    return new Date().toISOString().slice(0, 10)
  }
}

/** Shift a civil date by whole days. Negative moves back. */
export function offsetDate(date: string, days: number): string {
  const d = parseDateString(date)
  d.setUTCDate(d.getUTCDate() + days)
  return toDateString(d)
}

/** Whole days from `start` to `end`, inclusive in both ends. */
export function daysBetween(start: string, end: string): number {
  return Math.round((parseDateString(end).getTime() - parseDateString(start).getTime()) / DAY_MS) + 1
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (parseDateString(date).getUTCDay() + 6) % 7
}

export function isWeekend(date: string): boolean {
  return weekdayIndex(date) >= 5
}

/** The Monday of the week `date` falls in. */
export function getMondayString(date: string): string {
  return offsetDate(date, -weekdayIndex(date))
}

// ── ISO weeks ───────────────────────────────────────────────────────────────

/** ISO-8601 week number (1–53) of a civil date. */
export function getISOWeek(date: string): number {
  const d = parseDateString(date)
  // Shift to the Thursday of this week: the ISO week-year is whoever owns it.
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7))
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  return 1 + Math.round(
    ((d.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getUTCDay() + 6) % 7)) / 7,
  )
}

/** The ISO week-year of a civil date — not always its calendar year. */
export function getISOWeekYear(date: string): number {
  const d = parseDateString(date)
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7))
  return d.getUTCFullYear()
}

/** Monday and Sunday of ISO week `week` in ISO week-year `year`. */
export function getWeekBounds(year: number, week: number): { weekStart: string; weekEnd: string } {
  // 4 Jan is always in ISO week 1, so week 1's Monday anchors the year.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const mondayOfWeek1 = new Date(jan4)
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7))

  const weekStart = new Date(mondayOfWeek1)
  weekStart.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7)

  const start = toDateString(weekStart)
  return { weekStart: start, weekEnd: offsetDate(start, 6) }
}

// ── labels ──────────────────────────────────────────────────────────────────

/** "10 JUN" */
export function formatDayShort(date: string): string {
  const d = parseDateString(date)
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`
}

/** "WED 10 JUN" — the day-group heading in the list view. */
export function formatDayLabel(date: string): string {
  return `${WEEKDAYS_SHORT[weekdayIndex(date)]} ${formatDayShort(date)}`
}

/** "10 JUN 2026" */
export function formatDayFull(date: string): string {
  return `${formatDayShort(date)} ${parseDateString(date).getUTCFullYear()}`
}

/** "JUNE 2026" */
export function formatMonthLabel(year: number, month: number): string {
  return `${MONTHS_LONG[month]} ${year}`
}

/**
 * The week-span heading: "8 – 14 JUN 2026", widening to
 * "28 JUN – 4 JUL 2026" and "28 DEC 2026 – 3 JAN 2027" as needed.
 */
export function formatSpanLabel(start: string, end: string): string {
  const s = parseDateString(start)
  const e = parseDateString(end)
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear()
  const sameMonth = sameYear && s.getUTCMonth() === e.getUTCMonth()

  if (sameMonth) {
    return `${s.getUTCDate()} – ${e.getUTCDate()} ${MONTHS_SHORT[e.getUTCMonth()]} ${e.getUTCFullYear()}`
  }
  if (sameYear) {
    return `${formatDayShort(start)} – ${formatDayShort(end)} ${e.getUTCFullYear()}`
  }
  return `${formatDayFull(start)} – ${formatDayFull(end)}`
}

/**
 * The tight range badge on a clipped booking block: "6–16 JUN", widening to
 * "28 JUN–4 JUL". No spaces around the dash — that is what the design draws.
 */
export function formatCompactRange(start: string, end: string): string {
  const s = parseDateString(start)
  const e = parseDateString(end)
  if (start === end) return formatDayShort(start)
  if (s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()) {
    return `${s.getUTCDate()}–${e.getUTCDate()} ${MONTHS_SHORT[e.getUTCMonth()]}`
  }
  return `${formatDayShort(start)}–${formatDayShort(end)}`
}

/** "12–14 JUN" for a range, "12 JUN" for a single day. */
export function formatRange(start: string, end: string): string {
  return formatCompactRange(start, end)
}

// ── instants, rendered in the company's zone ────────────────────────────────

/** An ISO timestamp → "14:32" in the company's zone. */
export function formatTimeInZone(iso: string, timezone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
  } catch {
    return d.toISOString().slice(11, 16)
  }
}

/** An ISO timestamp → "10 JUN · 14:32" in the company's zone. */
export function formatStampInZone(iso: string, timezone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d)
    return `${formatDayShort(parts)} · ${formatTimeInZone(iso, timezone)}`
  } catch {
    return `${formatDayShort(d.toISOString().slice(0, 10))} · ${formatTimeInZone(iso, timezone)}`
  }
}
