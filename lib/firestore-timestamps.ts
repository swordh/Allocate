import 'server-only'

/**
 * Shared timestamp-normalisation helpers. Firestore/Stripe data on this app
 * holds time in three different representations — Firestore `Timestamp`s,
 * ISO strings, and Stripe's unix-SECONDS integers — and mixing them up is a
 * silent bug: `String(Timestamp)` is `"Timestamp(seconds=…)"`, which sorts
 * before every real date string. Route every read through one of these
 * instead of ad-hoc `.toDate?.()` chains.
 *
 * Previously duplicated verbatim in app/operator/customers/page.tsx and
 * app/operator/customers/[companyId]/page.tsx — hoisted here as the one copy.
 */

type TimestampLike = { toDate?: () => Date; toMillis?: () => number } | string | null | undefined

/** Firestore Timestamp (or already-ISO string) -> ISO string. `''` if absent. */
export function iso(value: TimestampLike): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value.toDate?.().toISOString() ?? ''
}

/** Same as `iso`, but `null` instead of `''` for "absent" — for optional fields. */
export function isoOrNull(value: TimestampLike): string | null {
  return iso(value) || null
}

/** Firestore Timestamp -> epoch ms. Never falls through to `String()`. */
export function tsToMillis(v: TimestampLike): number | null {
  if (!v) return null
  if (typeof v === 'string') {
    const t = new Date(v).getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v.toDate === 'function') return v.toDate().getTime()
  return null
}

export function isoToMillis(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** Stripe timestamps are unix SECONDS, not ms. */
export function unixSecondsToMillis(sec: number | null | undefined): number | null {
  if (sec === null || sec === undefined) return null
  return sec * 1000
}
