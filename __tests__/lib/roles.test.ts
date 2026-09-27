/**
 * `toRole` (lib/roles.ts) — the app-side mirror of
 * `functions/src/auth/role.ts`'s guard (issue #398). Covers the same
 * behaviour matrix: valid roles pass through, `null`/`undefined` fall back
 * to `crew` silently, and any other invalid value — including the removed
 * legacy `'viewer'` role — falls back to `crew` with a `console.warn`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ALLOWED_ROLES, toRole } from '@/lib/roles'

const ctx = { fn: 'testFn', path: 'companies/acme/members/uid1' }

describe('ALLOWED_ROLES', () => {
  it('is exactly admin and crew — viewer is gone (issue #397)', () => {
    expect(ALLOWED_ROLES).toEqual(['admin', 'crew'])
  })
})

describe('toRole', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each(['admin', 'crew'] as const)('passes %s through unchanged', (role) => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole(role, ctx)).toBe(role)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls back to crew for undefined without logging', () => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole(undefined, ctx)).toBe('crew')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('falls back to crew for null without logging', () => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole(null, ctx)).toBe('crew')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'empty string'],
    ['owner', 'unknown role string'],
    ['Admin', 'wrong casing'],
    ['viewer', 'removed legacy role'],
    [42, 'a number'],
    [{}, 'an object'],
  ] as const)('falls back to crew and warns once for %s (%s)', (value) => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole(value, ctx)).toBe('crew')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[roles] invalid_role',
      expect.objectContaining({ fn: ctx.fn, path: ctx.path }),
    )
  })

  it("falls back to crew and warns for '__proto__'", () => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole('__proto__', ctx)).toBe('crew')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it("falls back to crew and warns for 'constructor'", () => {
    const warnSpy = vi.spyOn(console, 'warn')
    expect(toRole('constructor', ctx)).toBe('crew')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
