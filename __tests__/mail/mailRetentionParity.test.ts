/**
 * Guards `lib/mail-retention.ts` against drifting from
 * `functions/src/email/mailRetention.ts` — the two are supposed to define
 * byte-for-byte the same constants and compute byte-for-byte the same
 * `expireAt` values (issue #325). App Hosting cannot import `functions/src`
 * (a different runtime entirely — see the docblock on either copy, or
 * `lib/roles.ts` ↔ `functions/src/auth/role.ts` for the precedent this
 * pattern follows), so this parity test is the only thing standing between
 * the two copies and silent drift, exactly like
 * `__tests__/company/failWritesParity.test.ts` does for the company-deletion
 * write-builders.
 *
 * There's actually a THIRD copy of the two TTL constants:
 * `tools/lib/mailExpireAtCompute.js`, the backfill script's pure `expireAt`
 * picker — it can't import either TS module (a plain Node CJS script, no
 * bundler), so it's a third literal pair of `MAIL_TTL_MS` /
 * `MAIL_SENT_TTL_MS` values (both 30 days since #406). It has no `mailExpireAt`/`sentMailExpireAt`
 * of its own (its `computeExpireAtMillis` takes plain millis and picks an
 * ANCHOR — sentAt/failedAt/createTime — rather than always adding to "now",
 * which is a different job, not just a different runtime), so only its two
 * constants are checked against the TS side below, not a third round of
 * function-output comparisons.
 */
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import * as appCopy from '@/lib/mail-retention'
import * as functionsCopy from '../../functions/src/email/mailRetention'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS tool script, no .d.ts to import against
const toolsCopy = require('../../tools/lib/mailExpireAtCompute.js')

describe('mail-retention parity (app vs functions)', () => {
  it('MAIL_TTL_MS is identical on both sides', () => {
    expect(appCopy.MAIL_TTL_MS).toBe(functionsCopy.MAIL_TTL_MS)
  })

  it('MAIL_SENT_TTL_MS is identical on both sides', () => {
    expect(appCopy.MAIL_SENT_TTL_MS).toBe(functionsCopy.MAIL_SENT_TTL_MS)
  })

  it.each([0, 1_700_000_000_000, 1_760_000_000_000])('mailExpireAt(%i) matches on both sides', (ms) => {
    const now = Timestamp.fromMillis(ms)
    expect(appCopy.mailExpireAt(now).toMillis()).toBe(functionsCopy.mailExpireAt(now).toMillis())
  })

  it.each([0, 1_700_000_000_000, 1_760_000_000_000])('sentMailExpireAt(%i) matches on both sides', (ms) => {
    const now = Timestamp.fromMillis(ms)
    expect(appCopy.sentMailExpireAt(now).toMillis()).toBe(functionsCopy.sentMailExpireAt(now).toMillis())
  })
})

describe('mail-retention parity (tools/lib/mailExpireAtCompute.js — the third, CJS copy)', () => {
  it('MAIL_TTL_MS matches the TS copies', () => {
    expect(toolsCopy.MAIL_TTL_MS).toBe(appCopy.MAIL_TTL_MS)
    expect(toolsCopy.MAIL_TTL_MS).toBe(functionsCopy.MAIL_TTL_MS)
  })

  it('MAIL_SENT_TTL_MS matches the TS copies', () => {
    expect(toolsCopy.MAIL_SENT_TTL_MS).toBe(appCopy.MAIL_SENT_TTL_MS)
    expect(toolsCopy.MAIL_SENT_TTL_MS).toBe(functionsCopy.MAIL_SENT_TTL_MS)
  })
})
