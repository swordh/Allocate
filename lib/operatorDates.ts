/**
 * Date formatting for the operator views (/operator/**).
 *
 * Every date and time in an operator view renders in UTC, not the company's
 * own `preferences.timezone` the way the customer-facing banner does
 * (lib/companyDeletionBanner.ts). That banner's zone choice exists so a
 * member reads the SAME calendar date their own bookings are dated in — a
 * concern that doesn't apply to an operator, who has no bookings of their
 * own in any company's zone and, on the site-wide views, is looking at many
 * companies with different zones side by side; picking any one company's
 * zone there would make dates inconsistent from row to row, and picking
 * "the operator's own zone" isn't meaningful either — Next.js renders these
 * client components on the server first (UTC) and again in the browser on
 * hydration, so a zone-less format shows one date in the HTML and another
 * once hydrated whenever the operator sits within a few hours of midnight
 * UTC (issue #292). UTC is the one zone every row, and both renders, agree
 * on. The more important signal for "is there still time to act" —
 * `timeRemaining` in lib/operatorDeletionView.ts — is a duration, not an
 * instant, so it carries no zone dependency at all; the UTC date is
 * secondary, supporting context.
 *
 * Month names come from `MONTHS_SHORT`, never from `month: 'short'`: newer
 * ICU data renders September as "Sept" in en-GB, and the output has to be
 * the same on every Node and browser version.
 *
 * Safe to import from both Server and Client Components — no `server-only`.
 */

import { MONTHS_SHORT, formatTimeInZone } from '@/lib/dates'

export const OPERATOR_ZONE = 'UTC'

const EMPTY = '—'

const PARTS_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: OPERATOR_ZONE,
  day: '2-digit',
  month: 'numeric',
  year: 'numeric',
})

interface Parts {
  day: string
  /** 0-based index into MONTHS_SHORT. */
  month: number
  year: string
}

/** Null for null/undefined/empty/unparseable input — callers render '—'. */
function parts(iso: string | null | undefined): Parts | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const byType: Record<string, string> = {}
  for (const p of PARTS_FORMAT.formatToParts(d)) byType[p.type] = p.value
  return { day: byType.day, month: Number(byType.month) - 1, year: byType.year }
}

/** "Sep" from "SEP". */
function titleCase(month: string): string {
  return month.charAt(0) + month.slice(1).toLowerCase()
}

/** "10 Sep 2026" */
export function formatOperatorDate(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return EMPTY
  return `${p.day} ${titleCase(MONTHS_SHORT[p.month])} ${p.year}`
}

/** "SEP 2026" */
export function formatOperatorMonthYear(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return EMPTY
  return `${MONTHS_SHORT[p.month]} ${p.year}`
}

/** "05 SEP" */
export function formatOperatorShortDate(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return EMPTY
  return `${p.day} ${MONTHS_SHORT[p.month]}`
}

/** "05 SEP 2026 · 14:32" */
export function formatOperatorDateTime(iso: string | null | undefined): string {
  const p = parts(iso)
  if (!p) return EMPTY
  return `${p.day} ${MONTHS_SHORT[p.month]} ${p.year} · ${formatTimeInZone(iso as string, OPERATOR_ZONE)}`
}

/** "14:32" — empty string for invalid input, like formatTimeInZone. */
export function formatOperatorTime(iso: string): string {
  return formatTimeInZone(iso, OPERATOR_ZONE)
}

/** True when both instants fall on the same UTC calendar date. */
export function isSameOperatorDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  )
}

/** Whole UTC calendar months from `iso` to `now`, never negative. */
export function monthsSinceOperator(iso: string, now: Date = new Date()): number {
  const start = new Date(iso)
  return Math.max(
    0,
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth()),
  )
}
