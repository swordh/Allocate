/**
 * lib/invite-token.ts — shared parsing and expiry helpers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseInviteToken, isInviteExpired } from '@/lib/invite-token'

describe('parseInviteToken', () => {
  it('extracts the token from an /invite/<token> URL', () => {
    expect(parseInviteToken('https://allocate.at/invite/abc123')).toBe('abc123')
  })

  it('extracts the token from a ?token= query param', () => {
    expect(parseInviteToken('https://allocate.at/signup?token=abc123')).toBe('abc123')
  })

  it('accepts a raw token', () => {
    expect(parseInviteToken('abc123')).toBe('abc123')
  })

  it('trims whitespace around a raw token', () => {
    expect(parseInviteToken('  abc123  ')).toBe('abc123')
  })

  it('returns null for empty input', () => {
    expect(parseInviteToken('   ')).toBeNull()
  })

  it('returns null for a token with disallowed characters', () => {
    expect(parseInviteToken('abc-123!')).toBeNull()
  })

  it('returns null for a token over 40 characters', () => {
    expect(parseInviteToken('a'.repeat(41))).toBeNull()
  })
})

describe('isInviteExpired', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false when expiresAt is undefined (never expires — backward compat)', () => {
    expect(isInviteExpired(undefined)).toBe(false)
  })

  it('returns false when expiresAt is in the future', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    expect(isInviteExpired('2026-08-12T00:00:00.000Z')).toBe(false)
  })

  it('returns true when expiresAt is in the past', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
    expect(isInviteExpired('2026-08-01T00:00:00.000Z')).toBe(true)
  })
})
