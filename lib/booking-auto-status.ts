import 'server-only'

import { createHash } from 'node:crypto'

/**
 * Mirror of `functions/src/bookings/autoStatusLogic.ts` — `functions/` compiles
 * as its own project with no path alias back to the repo root, so this can't
 * be shared by import, only kept in lockstep by hand (same pattern as
 * `lib/mail-retention.ts` and `lib/roles.ts`). `__tests__/bookings/
 * autoStatusParity.test.ts` is what catches drift between the two copies.
 * The app itself never calls this — bookings are checked in/out automatically
 * by Cloud Tasks in `functions/` — it exists so the logic is unit-testable from
 * the root Vitest run and so the parity test has something to compare against.
 *
 * Issue #329: automatic check-out / check-in. One Cloud Task per booking and
 * transition, scheduled for the exact company-local wall-clock time. Everything
 * here is pure (no Firestore, no clock reads — `now` is always passed in), so
 * the decisions the trigger and the task handler make are testable in isolation.
 */

export type AutoTransition = 'checkout' | 'checkin'

/** Cloud Tasks only accepts a scheduleTime up to 30 days ahead; stay under it. */
export const MAX_SCHEDULE_AHEAD_MS = 29 * 24 * 60 * 60 * 1000

export interface AutoPrefs {
  autoCheckout: boolean
  autoCheckin: boolean
  /** Epoch ms the flag was last turned on, or null if never recorded. */
  autoCheckoutSince: number | null
  autoCheckinSince: number | null
  tz: string
}

export interface AutoBookingFields {
  status?: string | null
  startDate?: string | null
  startTime?: string | null
  endDate?: string | null
  endTime?: string | null
  /** Firestore Timestamp (or null/absent); read only through `toMillisOrNull`. */
  createdAt?: unknown
  updatedAt?: unknown
}

export interface AutoTaskPayload {
  companyId: string
  bookingId: string
  transition: AutoTransition
  /** Epoch ms the transition is due, as computed when the task was enqueued. */
  dueAt: number
}

export type TaskDecision =
  | { kind: 'skip'; reason: 'missing' | 'status' | 'flag-off' | 'invalid' | 'before-since' }
  | { kind: 'apply' }
  | { kind: 'hop' }
  | { kind: 'stale' }

// ── Wall-clock → instant ────────────────────────────────────────────────────

const MINUTE_MS = 60_000
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatterCache.set(tz, f)
  }
  return f
}

/** An unknown zone falls back to UTC, the same as `todayInTimezone` in lib/dates.ts. */
function resolveFormatter(tz: string): Intl.DateTimeFormat {
  try {
    return formatterFor(tz)
  } catch {
    return formatterFor('UTC')
  }
}

/** The zone's offset from UTC at instant `t`, in ms (positive east of Greenwich). */
function offsetAt(f: Intl.DateTimeFormat, t: number): number {
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  // h23 should never yield 24, but some ICU builds have — normalise defensively.
  const hour = p.hour === 24 ? 0 : p.hour
  const wall = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second)
  return wall - Math.floor(t / 1000) * 1000
}

/**
 * The instant at which a clock in `tz` reads `date` `time` ("YYYY-MM-DD",
 * "HH:MM"). Uses Intl only — no date library.
 *
 *  - A time that occurs twice (DST ends) resolves to the FIRST occurrence.
 *  - A time that does not exist (DST starts) resolves to the first valid
 *    minute after the gap — e.g. 02:30 on the spring-forward day in
 *    Stockholm is 03:00 local, 01:00Z.
 *  - An unknown `tz` is treated as UTC.
 *
 * Throws RangeError on a malformed `date`/`time`.
 */
export function zonedWallClockToInstant(date: string, time: string, tz: string): Date {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) throw new RangeError(`Invalid wall-clock ${date} ${time}`)
  const wanted = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  // Round-trip so out-of-range parts (month 13, Feb 30, 24:00, 12:60) are
  // rejected instead of silently rolling over into another day.
  const check = new Date(wanted)
  if (
    Number.isNaN(wanted) ||
    check.getUTCFullYear() !== Number(d[1]) ||
    check.getUTCMonth() !== Number(d[2]) - 1 ||
    check.getUTCDate() !== Number(d[3]) ||
    check.getUTCHours() !== Number(t[1]) ||
    check.getUTCMinutes() !== Number(t[2])
  ) {
    throw new RangeError(`Invalid wall-clock ${date} ${time}`)
  }

  const f = resolveFormatter(tz)

  // The offset on either side of the guess brackets any single transition.
  const offsets = new Set([offsetAt(f, wanted - 24 * 3_600_000), offsetAt(f, wanted + 24 * 3_600_000)])
  let best: number | null = null
  for (const o of offsets) {
    const candidate = wanted - o
    // A candidate is real only if the zone actually has that offset there.
    if (offsetAt(f, candidate) === o && (best === null || candidate < best)) best = candidate
  }
  if (best !== null) return new Date(best)

  // Gap: no instant reads `wanted`. Find the first minute whose wall clock is
  // at or past it. Wall time is monotone across a spring-forward transition.
  let lo = wanted - 36 * 3_600_000
  let hi = wanted + 36 * 3_600_000
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / MINUTE_MS / 2) * MINUTE_MS
    if (mid + offsetAt(f, mid) >= wanted) hi = mid
    else lo = mid
  }
  return new Date(hi)
}

// ── Preferences ─────────────────────────────────────────────────────────────

function toMillisOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis()
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** Reads the auto-status settings off a company document's data. A flag counts only if it is exactly `true`. */
export function readAutoPrefs(companyData: Record<string, unknown> | undefined | null): AutoPrefs {
  const prefs = (companyData?.preferences ?? {}) as Record<string, unknown>
  return {
    autoCheckout: prefs.autoCheckout === true,
    autoCheckin: prefs.autoCheckin === true,
    autoCheckoutSince: toMillisOrNull(prefs.autoCheckoutSince),
    autoCheckinSince: toMillisOrNull(prefs.autoCheckinSince),
    tz: typeof prefs.timezone === 'string' && prefs.timezone ? prefs.timezone : 'UTC',
  }
}

function flagOn(prefs: AutoPrefs, transition: AutoTransition): boolean {
  return transition === 'checkout' ? prefs.autoCheckout : prefs.autoCheckin
}

/**
 * Forward-only cut-off (see `eligible`). A flag that is on but has no recorded `since` (a
 * company that had the flag set before `since` existed) is treated as "no
 * restriction" — the flags are false in every environment today, so this only
 * keeps the logic total rather than covering a real case.
 */
function sinceFor(prefs: AutoPrefs, transition: AutoTransition): number {
  return (transition === 'checkout' ? prefs.autoCheckoutSince : prefs.autoCheckinSince) ?? 0
}

/**
 * Latest time the booking was created or edited, epoch ms (0 if neither is
 * readable). `updatedAt` is stamped on every write, so this is "last touched".
 */
function touchedAt(booking: AutoBookingFields): number {
  return Math.max(toMillisOrNull(booking.createdAt) ?? 0, toMillisOrNull(booking.updatedAt) ?? 0)
}

/**
 * Forward-only eligibility: a booking is handled if its due time is at or after
 * the flag's `since` (an upcoming booking), OR it was created/edited at or after
 * `since` (so a booking made or rescheduled after the flag went on is processed
 * even if its start has already passed). An old, untouched booking whose time
 * passed before the flag went on is left alone.
 */
function eligible(booking: AutoBookingFields, due: number, since: number): boolean {
  return due >= since || touchedAt(booking) >= since
}

// ── Due times ───────────────────────────────────────────────────────────────

/**
 * Epoch ms at which `transition` is due for `booking`, in the company's zone.
 * Check-out is at the start time (all-day: 00:00 on startDate); check-in is at
 * the end time (all-day: 23:59 on endDate). No grace margin. Null if the
 * booking's dates are missing or malformed.
 */
export function computeDueInstant(
  booking: AutoBookingFields,
  transition: AutoTransition,
  tz: string,
): number | null {
  const date = transition === 'checkout' ? booking.startDate : booking.endDate
  // `||`, not `??`: an empty-string time is all-day, like null (matches the manual path).
  const time = transition === 'checkout'
    ? booking.startTime || '00:00'
    : booking.endTime || '23:59'
  if (!date) return null
  try {
    return zonedWallClockToInstant(date, time, tz).getTime()
  } catch {
    return null
  }
}

/** The transition that applies to a booking in `status`, or null if none. */
export function transitionFor(status: string | null | undefined): AutoTransition | null {
  if (status === 'confirmed') return 'checkout'
  if (status === 'checked_out') return 'checkin'
  return null
}

function requiredStatus(transition: AutoTransition): string {
  return transition === 'checkout' ? 'confirmed' : 'checked_out'
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Whether the fields that decide `transition`'s due time (or the status itself)
 * changed between `before` and `after`. A status change always counts. Check-out
 * watches the start date/time, check-in the end date/time — an unrelated edit
 * (e.g. moving only the end time of a confirmed booking) must not re-plan the
 * other transition.
 */
export function watchedFieldsChanged(
  before: AutoBookingFields | undefined | null,
  after: AutoBookingFields,
  transition: AutoTransition,
): boolean {
  if (!before || before.status !== after.status) return true
  return transition === 'checkout'
    ? before.startDate !== after.startDate || before.startTime !== after.startTime
    : before.endDate !== after.endDate || before.endTime !== after.endTime
}

/**
 * What the booking-written trigger should enqueue, if anything. Acts only when
 * the booking was created or a field relevant to its transition changed
 * (`watchedFieldsChanged`), the matching flag is on, and the booking is
 * `eligible` (due at/after the flag's `since`, or touched at/after it). A due
 * time already in the past still plans a task — the handler applies it
 * immediately.
 */
export function planBookingEnqueue(
  before: AutoBookingFields | undefined | null,
  after: AutoBookingFields | undefined | null,
  prefs: AutoPrefs,
): { transition: AutoTransition; dueAt: number } | null {
  if (!after) return null
  const transition = transitionFor(after.status)
  if (!transition || !flagOn(prefs, transition)) return null
  if (!watchedFieldsChanged(before, after, transition)) return null
  const dueAt = computeDueInstant(after, transition, prefs.tz)
  if (dueAt === null || !eligible(after, dueAt, sinceFor(prefs, transition))) return null
  return { transition, dueAt }
}

/**
 * Which transitions the company-updated trigger must re-enqueue bookings for:
 * a flag that just went false→true (existing bookings need tasks), or a flag
 * that is on while the time zone changed (every due time moved).
 */
export function planCompanyEnqueue(before: AutoPrefs, after: AutoPrefs): AutoTransition[] {
  const out: AutoTransition[] = []
  const tzChanged = before.tz !== after.tz
  if (after.autoCheckout && (!before.autoCheckout || tzChanged)) out.push('checkout')
  if (after.autoCheckin && (!before.autoCheckin || tzChanged)) out.push('checkin')
  return out
}

// ── Task handling ───────────────────────────────────────────────────────────

/**
 * What the task handler does with a dispatched task, given the booking and
 * company as they are RIGHT NOW (re-read inside the handler's transaction).
 *
 *  - skip:  booking gone, wrong status, flag off, or not eligible (due before
 *           `since` and not created/edited since)
 *  - apply: due has passed — perform the transition
 *  - hop:   not due yet and the payload still matches — a task was capped at
 *           29 days, so enqueue the next hop
 *  - stale: not due yet but the payload's dueAt no longer matches — the
 *           booking was rescheduled and its own newer task owns it
 */
export function decideTask(
  payload: AutoTaskPayload,
  booking: AutoBookingFields | undefined | null,
  prefs: AutoPrefs,
  now: number,
): TaskDecision {
  if (!booking) return { kind: 'skip', reason: 'missing' }
  if (booking.status !== requiredStatus(payload.transition)) return { kind: 'skip', reason: 'status' }
  if (!flagOn(prefs, payload.transition)) return { kind: 'skip', reason: 'flag-off' }
  const due = computeDueInstant(booking, payload.transition, prefs.tz)
  if (due === null) return { kind: 'skip', reason: 'invalid' }
  if (!eligible(booking, due, sinceFor(prefs, payload.transition))) return { kind: 'skip', reason: 'before-since' }
  if (due <= now) return { kind: 'apply' }
  return payload.dueAt === due ? { kind: 'hop' } : { kind: 'stale' }
}

/** When to schedule a task for `dueAt`: capped at now+29d, undefined (run now) if already due. */
export function scheduleTimeFor(dueAt: number, now: number): number | undefined {
  if (dueAt <= now) return undefined
  return Math.min(dueAt, now + MAX_SCHEDULE_AHEAD_MS)
}

/** A Cloud Tasks id: `<transition>-<48 hex of sha256(parts)>`. */
export function taskId(transition: AutoTransition, parts: ReadonlyArray<string | number>): string {
  return `${transition}-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 48)}`
}
