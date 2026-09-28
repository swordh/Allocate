/**
 * `hashUserIdForAudit` (lib/auditLogHash.ts) — issue #294. Replaces
 * `deletionAuditLog.userIdHash`'s old unkeyed `sha256(uid)` with an
 * HMAC-SHA256 keyed by `AUDIT_LOG_HMAC_KEY`, so the hash can no longer be
 * rebuilt by anyone who doesn't hold the key. See that mirror in
 * functions/src/audit/userIdHash.test.ts for the Cloud Functions side of
 * the same contract.
 */
import { createHash, createHmac } from 'crypto'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { hashUserIdForAudit } from '@/lib/auditLogHash'

const TEST_KEY = 'test-audit-hmac-key-do-not-use-in-prod'
const UID = 'user-abc-123'

describe('hashUserIdForAudit', () => {
  beforeEach(() => {
    vi.stubEnv('AUDIT_LOG_HMAC_KEY', TEST_KEY)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('equals createHmac(sha256, key).update(uid).digest(hex) for a known key', () => {
    const expected = createHmac('sha256', TEST_KEY).update(UID).digest('hex')
    expect(hashUserIdForAudit(UID)).toBe(expected)
  })

  it('is NOT equal to the old unkeyed sha256(uid)', () => {
    const oldStyle = createHash('sha256').update(UID).digest('hex')
    expect(hashUserIdForAudit(UID)).not.toBe(oldStyle)
  })

  it('is deterministic for the same uid and key', () => {
    expect(hashUserIdForAudit(UID)).toBe(hashUserIdForAudit(UID))
  })

  it('produces a different hash for a different key (same uid)', () => {
    const first = hashUserIdForAudit(UID)
    vi.stubEnv('AUDIT_LOG_HMAC_KEY', 'a-completely-different-key')
    expect(hashUserIdForAudit(UID)).not.toBe(first)
  })

  it('throws when AUDIT_LOG_HMAC_KEY is missing', () => {
    vi.stubEnv('AUDIT_LOG_HMAC_KEY', '')
    expect(() => hashUserIdForAudit(UID)).toThrow('AUDIT_LOG_HMAC_KEY is not set')
  })
})
