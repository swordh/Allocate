/**
 * `tools/lib/mailExpireAtCompute.js` — the pure `expireAt` picker used by
 * `tools/backfill_mail_expire_at.js` (issue #325). A plain CommonJS module
 * (same convention as `tools/lib/mask_pii.js`), imported here via a normal
 * ESM import — Vite/Vitest's CJS interop resolves the named exports off its
 * `module.exports` object literal fine, no `require()` needed.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS tool script, no .d.ts to import against
const { MAIL_SENT_TTL_MS, MAIL_TTL_MS, computeExpireAtMillis, classifyBucket } = require('../../tools/lib/mailExpireAtCompute.js')

const DAY_MS = 24 * 60 * 60 * 1000

describe('computeExpireAtMillis', () => {
  it('sent + sentAt present -> sentAt + 30 days', () => {
    const sentAtMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'sent', sentAtMillis, createTimeMillis: 0 })).toBe(
      sentAtMillis + MAIL_SENT_TTL_MS,
    )
  })

  it('status sent but NO sentAt -> falls through to createTime + 90 days (never trusts status alone)', () => {
    const createTimeMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'sent', createTimeMillis })).toBe(createTimeMillis + MAIL_TTL_MS)
  })

  it('not sent, failedAt present -> failedAt + 90 days', () => {
    const failedAtMillis = 1_700_000_000_000
    expect(computeExpireAtMillis({ status: 'error', failedAtMillis, createTimeMillis: 0 })).toBe(
      failedAtMillis + MAIL_TTL_MS,
    )
  })

  it('neither sentAt nor failedAt -> createTime + 90 days', () => {
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

  it('an expireAt under 30 days out is under_30d', () => {
    expect(classifyBucket(now + 1, now)).toBe('under_30d')
    expect(classifyBucket(now + 29 * DAY_MS, now)).toBe('under_30d')
  })

  it('an expireAt at or beyond 30 days (up to 90) is 30_to_90d', () => {
    expect(classifyBucket(now + 30 * DAY_MS, now)).toBe('30_to_90d')
    expect(classifyBucket(now + 90 * DAY_MS, now)).toBe('30_to_90d')
  })
})
