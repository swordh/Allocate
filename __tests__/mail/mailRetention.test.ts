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
  it('is 90 days for the default (queued/retry/error) TTL', () => {
    expect(MAIL_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  it('is 30 days for the post-delivery (sent) TTL', () => {
    expect(MAIL_SENT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('the sent TTL is shorter than the default TTL', () => {
    expect(MAIL_SENT_TTL_MS).toBeLessThan(MAIL_TTL_MS)
  })
})

describe('mailExpireAt', () => {
  it('returns now + 90 days', () => {
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

  it('rolls the expiry EARLIER than the original 90-day queue-time expireAt would have been for the same now', () => {
    const now = Timestamp.fromMillis(1_760_000_000_000)
    expect(sentMailExpireAt(now).toMillis()).toBeLessThan(mailExpireAt(now).toMillis())
  })
})
