import { logger } from 'firebase-functions/v2';
import { UserRole } from '../types';

/**
 * Mirror of `ALLOWED_ROLES` in `lib/roles.ts` — functions/ compiles as its
 * own project with no path alias back to the repo root, so this can't be
 * imported, only kept in lockstep by hand.
 *
 * `viewer` is gone (issue #397) — `crew` is the lowest role and the
 * fallback.
 */
export const ALLOWED_ROLES: readonly UserRole[] = ['admin', 'crew'];

/**
 * Validates a role value read off an invitation doc, a member/membership
 * doc, or Auth Custom Claims before it's written into a member doc, a
 * membership doc, or Custom Claims (issue #398 — every claims write on the
 * server routes through this one guard).
 *
 * `value` is `unknown` on purpose — it comes straight off `DocumentData` or
 * decoded claims, which are untyped. The `typeof value === 'string'` check
 * (rather than just `ALLOWED_ROLES.includes(value as UserRole)`) is what
 * keeps a non-string `value` — including a prototype-pollution attempt like
 * `'__proto__'` or `'constructor'` — from ever reaching `.includes` as
 * anything but a plain string comparison; `Array.prototype.includes` does a
 * strict `===` check against the allowlist, so those two strings simply
 * don't match any entry.
 *
 * `null`/`undefined` (the common case — most invitations never set a role,
 * and the `invitations/{token}` mirror docs never carry one at all) fall
 * back to `crew` silently, matching the previous `?? 'crew'` behaviour.
 *
 * Any other invalid value — including the removed `'viewer'` role — is
 * logged so a bad write upstream doesn't fail silent.
 */
export function toRole(value: unknown, ctx: { fn: string; path: string }): UserRole {
  if (value === null || value === undefined) {
    return 'crew';
  }

  if (typeof value === 'string' && (ALLOWED_ROLES as readonly string[]).includes(value)) {
    return value as UserRole;
  }

  let described: string;
  try {
    described = String(value).slice(0, 32);
  } catch {
    described = '<unstringifiable>';
  }

  logger.warn('toRole: invalid role, falling back to crew', {
    fn: ctx.fn,
    path: ctx.path,
    role: described,
  });

  return 'crew';
}
