/**
 * `toRole` (functions/src/auth/role.ts) — the guard that stands between any
 * untyped `role` value (an invitation doc, a member/membership doc, or a
 * decoded claim) and what gets written into a member doc, a membership doc,
 * or Custom Claims (issue #255, and issue #398's single-guard requirement).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { logger } from 'firebase-functions/v2';
import { toRole } from '../../src/auth/role';

const ctx = { fn: 'testFn', path: 'companies/acme/invitations/inv1' };

describe('toRole', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['admin', 'crew'] as const)('passes %s through unchanged', (role) => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole(role, ctx)).toBe(role);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to crew for undefined without logging', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole(undefined, ctx)).toBe('crew');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to crew for null without logging', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole(null, ctx)).toBe('crew');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'empty string'],
    ['owner', 'unknown role string'],
    ['Admin', 'wrong casing'],
    ['viewer', 'removed legacy role (issue #397)'],
    [42, 'a number'],
    [{}, 'an object'],
  ] as const)('falls back to crew and warns once for %s (%s)', (value) => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole(value, ctx)).toBe('crew');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'toRole: invalid role, falling back to crew',
      expect.objectContaining({ fn: ctx.fn, path: ctx.path }),
    );
  });

  it("falls back to crew and warns for '__proto__'", () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole('__proto__', ctx)).toBe('crew');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to crew and warns for 'constructor'", () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    expect(toRole('constructor', ctx)).toBe('crew');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
