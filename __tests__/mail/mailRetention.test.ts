/**
 * `lib/mail-retention.ts` — the app-side copy of the mail TTL helpers (issue
 * #325). See `functions/__tests__/email/mailRetention.test.ts` for the
 * functions-side copy's own unit test, and `mailRetentionParity.test.ts` in
 * this directory for the test that keeps the two from drifting apart.
 */
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { MAIL_SENT_TTL_MS, MAIL_TTL_MS, mailExpireAt, sentMailExpireAt } from '@/lib/mail-retention'

describe('MAIL_TTL_MS / MAIL_SENT_TTL_MS', () => {
  it('is 30 days for the default (queued/retry/error) TTL', () => {
    expect(MAIL_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('is 30 days for the post-delivery (sent) TTL', () => {
    expect(MAIL_SENT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('the sent TTL equals the default TTL (issue #406: every status gets 30 days)', () => {
    expect(MAIL_SENT_TTL_MS).toBe(MAIL_TTL_MS)
  })
})

describe('mailExpireAt', () => {
  it('returns now + 30 days', () => {
    const now = Timestamp.fromMillis(1_760_000_000_000)
    expect(mailExpireAt(now).toMillis()).toBe(1_760_000_000_000 + MAIL_TTL_MS)
  })

  it('is a genuine Timestamp, not a serverTimestamp sentinel — TTL needs a concrete value', () => {
    const now = Timestamp.fromMillis(1_760_000_000_000)
    const result = mailExpireAt(now)
    expect(result).toBeInstanceOf(Timestamp)
  })
})

describe('sentMailExpireAt', () => {
  it('returns now + 30 days', () => {
    const now = Timestamp.fromMillis(1_760_000_000_000)
    expect(sentMailExpireAt(now).toMillis()).toBe(1_760_000_000_000 + MAIL_SENT_TTL_MS)
  })

  it('equals the queue-time expireAt for the same now (issue #406: both are 30 days; sent re-anchors to sentAt, not a shorter window)', () => {
    const now = Timestamp.fromMillis(1_760_000_000_000)
    expect(sentMailExpireAt(now).toMillis()).toBe(mailExpireAt(now).toMillis())
  })
})
