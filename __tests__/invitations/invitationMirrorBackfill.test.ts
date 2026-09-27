/**
 * `tools/lib/invitationMirrorBackfill.js` — the pure decision function used
 * by `tools/backfill_invitation_mirrors.js` (issue #297). A plain CommonJS
 * module (same convention as `tools/lib/mailExpireAtCompute.js`), imported
 * here via a normal ESM import — Vite/Vitest's CJS interop resolves the
 * named export off its `module.exports` object literal fine, no `require()`
 * needed.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS tool script, no .d.ts to import against
const { decideMirrorAction } = require('../../tools/lib/invitationMirrorBackfill.js')

describe('decideMirrorAction', () => {
  it('status accepted -> delete', () => {
    expect(decideMirrorAction({ status: 'accepted', expiresAt: '2026-01-01T00:00:00.000Z' })).toEqual({
      action: 'delete',
    })
  })

  it('status revoked -> delete', () => {
    expect(decideMirrorAction({ status: 'revoked' })).toEqual({ action: 'delete' })
  })

  it('an unexpected/legacy status -> delete, same as any other non-pending value', () => {
    expect(decideMirrorAction({ status: 'something-else' })).toEqual({ action: 'delete' })
  })

  it('missing status -> delete (never pending)', () => {
    expect(decideMirrorAction({})).toEqual({ action: 'delete' })
  })

  it('pending with expiresAt and no expireAt -> set_expire_at, matching expiresAt exactly', () => {
    const expiresAt = '2026-09-27T12:00:00.000Z'
    const result = decideMirrorAction({ status: 'pending', expiresAt })
    expect(result).toEqual({ action: 'set_expire_at', expireAtMillis: Date.parse(expiresAt) })
  })

  it('pending with no expiresAt at all -> skip_no_expiry (legacy, never guess an expiry)', () => {
    expect(decideMirrorAction({ status: 'pending' })).toEqual({ action: 'skip_no_expiry' })
  })

  it('pending with a malformed expiresAt string -> skip_no_expiry, not a crash or a garbage TTL', () => {
    expect(decideMirrorAction({ status: 'pending', expiresAt: 'not-a-date' })).toEqual({
      action: 'skip_no_expiry',
    })
  })

  it('pending already carrying expireAt -> ok, nothing to do', () => {
    expect(
      decideMirrorAction({ status: 'pending', expiresAt: '2026-09-27T12:00:00.000Z', expireAt: {} }),
    ).toEqual({ action: 'ok' })
  })

  it('pending with expireAt present takes priority over a missing/malformed expiresAt', () => {
    expect(decideMirrorAction({ status: 'pending', expireAt: {} })).toEqual({ action: 'ok' })
  })
})
