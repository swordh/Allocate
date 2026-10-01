import 'server-only'

/**
 * There is no event log in this app. The activity feed on screen 22 is
 * assembled from five existing sources plus one new one
 * (companyEvents, see actions written by the Stripe webhook).
 *
 * Timestamp normalisation (Firestore Timestamp / ISO string / Stripe
 * unix-seconds -> epoch ms) lives in lib/firestore-timestamps.ts, shared
 * with the customers list page. Every entry below carries `at` (epoch ms,
 * the only sort key) and `atIso` (rendering only) — never compare `atIso`
 * or a raw Timestamp directly.
 */

export type FeedEntryKind =
  | 'account_created'
  | 'member_joined'
  | 'booking_created'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'plan_changed'
  | 'status_changed'

export interface FeedEntry {
  kind: FeedEntryKind
  /** Epoch milliseconds. The only sort key. */
  at: number
  /** ISO string, for rendering only. */
  atIso: string
  text: string
}

export function sortFeed(entries: FeedEntry[]): FeedEntry[] {
  return [...entries].sort((a, b) => b.at - a.at)
}
