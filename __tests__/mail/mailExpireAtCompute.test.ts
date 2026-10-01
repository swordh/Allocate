/**
 * `tools/lib/mailExpireAtCompute.js` — the pure `expireAt` picker used by
 * `tools/backfill_mail_expire_at.js` (issue #325). A plain CommonJS module
 * (same convention as `tools/lib/mask_pii.js`), imported here via a normal
 * ESM import — Vite/Vitest's CJS interop resolves the named exports off its
 * `module.exports` object literal fine, no `require()` needed.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS tool script, no .d.ts to import against
const {
  MAIL_SENT_TTL_MS,
  MAIL_TTL_MS,
  computeExpireAtMillis,
  classifyBucket,
  pickShortenedExpireAtMillis,
} = require('../../tools/lib/mailExpireAtCompute.js')

const DAY_MS = 24 * 60 * 60 * 1000

describe('computeExpireAtMillis', () => {
  it('sent + sentAt present -> sentAt + 30 days', () => {
    const sentAtMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'sent', sentAtMillis, createTimeMillis: 0 })).toBe(
      sentAtMillis + MAIL_SENT_TTL_MS,
    )
  })

  it('status sent but NO sentAt -> falls through to createTime + 30 days (never trusts status alone)', () => {
    const createTimeMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'sent', createTimeMillis })).toBe(createTimeMillis + MAIL_TTL_MS)
  })

  it('not sent, failedAt present -> failedAt + 30 days', () => {
    const failedAtMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'error', failedAtMillis, createTimeMillis: 0 })).toBe(
      failedAtMillis + MAIL_TTL_MS,
    )
  })

  it('neither sentAt nor failedAt -> createTime + 30 days', () => {
    const createTimeMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'queued', createTimeMillis })).toBe(createTimeMillis + MAIL_TTL_MS)
  })

  it('sentAt takes priority over failedAt when a doc somehow has both (sent wins)', () => {
    const sentAtMillis = 1_700_000_000_000
    const failedAtMillis = 1_600_000_000_000
    expect(
      computeExpireAtMillis({ status: 'sent', sentAtMillis, failedAtMillis, createTimeMillis: 0 }),
    ).toBe(sentAtMillis + MAIL_SENT_TTL_MS)
  })
})

describe('classifyBucket', () => {
  const now = 1_760_000_000_000

  it('a past/equal expireAt is already_expired', () => {
    expect(classifyBucket(now - 1, now)).toBe('already_expired')
    expect(classifyBucket(now, now)).toBe('already_expired')
  })

  it('an expireAt under or at 30 days out is under_30d', () => {
    expect(classifyBucket(now + 1, now)).toBe('under_30d')
    expect(classifyBucket(now + 29 * DAY_MS, now)).toBe('under_30d')
    expect(classifyBucket(now + 30 * DAY_MS, now)).toBe('under_30d')
  })

  it('an expireAt beyond 30 days is the over_30d_unexpected sanity bucket', () => {
    expect(classifyBucket(now + 30 * DAY_MS + 1, now)).toBe('over_30d_unexpected')
    expect(classifyBucket(now + 90 * DAY_MS, now)).toBe('over_30d_unexpected')
  })
})

describe('pickShortenedExpireAtMillis', () => {
  it('stamps a doc with no existing expireAt', () => {
    expect(
      pickShortenedExpireAtMillis({ existingExpireAtMillis: undefined, computedExpireAtMillis: 1_000 }),
    ).toEqual({ action: 'stamped', expireAtMillis: 1_000 })
  })

  it('shortens when the existing expireAt is later than the computed value (the #406 backfill case: a stale 90-day value)', () => {
    const computedExpireAtMillis = 1_700_000_000_000
    const existingExpireAtMillis = computedExpireAtMillis + 60 * DAY_MS // the old 90-day value
    expect(
      pickShortenedExpireAtMillis({ existingExpireAtMillis, computedExpireAtMillis }),
    ).toEqual({ action: 'shortened', expireAtMillis: computedExpireAtMillis })
  })

  it('never extends: leaves an existing expireAt that is already earlier than the computed value unchanged', () => {
    const computedExpireAtMillis = 1_700_000_000_000
    const existingExpireAtMillis = computedExpireAtMillis - 5 * DAY_MS
    expect(
      pickShortenedExpireAtMillis({ existingExpireAtMillis, computedExpireAtMillis }),
    ).toEqual({ action: 'unchanged', expireAtMillis: existingExpireAtMillis })
  })

  it('never extends: leaves an existing expireAt that exactly equals the computed value unchanged', () => {
    const millis = 1_700_000_000_000
    expect(
      pickShortenedExpireAtMillis({ existingExpireAtMillis: millis, computedExpireAtMillis: millis }),
    ).toEqual({ action: 'unchanged', expireAtMillis: millis })
  })
})
