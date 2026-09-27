/**
 * `isStillEligibleForPurge` — `functions/src/admin/purgeOldFeedback.ts`'s
 * reopen-race guard (issue #338 PR 2, added after code review). The sweep's
 * initial query is a point-in-time read: a ticket that gets reopened, or
 * reclassified in a way that clears `closedAt`, between that query and its
 * actual `recursiveDelete` would otherwise still be deleted out from under
 * the operator who just reopened it. This function is re-checked against a
 * FRESH read of the ticket immediately before each delete — these tests
 * cover its pure logic directly, without a Firestore connection.
 */
import { describe, expect, it } from 'vitest'
import { isStillEligibleForPurge } from '../../functions/src/admin/purgeOldFeedback'

function ts(millis: number) {
  return { toMillis: () => millis }
}

const CUTOFF_MILLIS = 1_700_000_000_000

describe('isStillEligibleForPurge', () => {
  it('true — closedAt is a real Timestamp older than the cutoff', () => {
    expect(isStillEligibleForPurge(ts(CUTOFF_MILLIS - 1), CUTOFF_MILLIS)).toBe(true)
  })

  it('false — closedAt is missing entirely (ticket was reopened since the query ran)', () => {
    expect(isStillEligibleForPurge(undefined, CUTOFF_MILLIS)).toBe(false)
    expect(isStillEligibleForPurge(null, CUTOFF_MILLIS)).toBe(false)
  })

  it('false — closedAt was updated to something newer than the cutoff (reclassified after the query ran)', () => {
    expect(isStillEligibleForPurge(ts(CUTOFF_MILLIS + 1), CUTOFF_MILLIS)).toBe(false)
  })

  it('false — closedAt exactly at the cutoff (matches the sweep query\'s own strict "<")', () => {
    expect(isStillEligibleForPurge(ts(CUTOFF_MILLIS), CUTOFF_MILLIS)).toBe(false)
  })

  it('false — closedAt is not a Timestamp-shaped value at all (malformed data)', () => {
    expect(isStillEligibleForPurge('2020-01-01', CUTOFF_MILLIS)).toBe(false)
    expect(isStillEligibleForPurge(1_600_000_000_000, CUTOFF_MILLIS)).toBe(false)
    expect(isStillEligibleForPurge({}, CUTOFF_MILLIS)).toBe(false)
  })
})
