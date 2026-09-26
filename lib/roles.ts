import type { Role } from '@/types'

/**
 * Mirror of `ALLOWED_ROLES`/`toRole` in `functions/src/auth/role.ts` —
 * `functions/` compiles as its own project with no path alias back to the
 * repo root, so this can't be shared by import, only kept in lockstep by
 * hand.
 *
 * `viewer` is gone (issue #397) — `crew` is the lowest role and the
 * fallback. `toRole` below still accepts the string `'viewer'` as input and
 * silently maps it to `crew`; that mapping is a transitional shim for
 * documents/claims written before `tools/migrate_viewer_to_crew.js` has run
 * in every environment, and can be deleted once it has.
 *
 * Deliberately has no `import 'server-only'` — this module is used by
 * `lib/dal.ts` (server-only) but also needs to be importable from
 * client-safe code, and a `server-only` import would poison any client
 * bundle that reaches it transitively.
 */
export const ALLOWED_ROLES: readonly Role[] = ['admin', 'crew']

/**
 * Validates a role value read off a Firestore document or Custom Claims
 * before it's trusted anywhere in the app (issue #398 — every claims write
 * and every read of a role claim routes through this one guard).
 *
 * `value` is `unknown` on purpose — it comes straight off `DocumentData` or
 * decoded claims, which are untyped. The `typeof value === 'string'` check
 * (rather than just `ALLOWED_ROLES.includes(value as Role)`) is what keeps a
 * non-string `value` — including a prototype-pollution attempt like
 * `'__proto__'` or `'constructor'` — from ever reaching `.includes` as
 * anything but a plain string comparison; `Array.prototype.includes` does a
 * strict `===` check against the allowlist, so those two strings simply
 * don't match any entry.
 *
 * `null`/`undefined` (no role claim/field present at all) falls back to
 * `crew` silently.
 *
 * `'viewer'` also falls back to `crew` silently — see the module docblock
 * above. This is the one deliberate exception to "any other invalid value
 * is logged": a document or claim written before the migration ran is not a
 * bug to flag, it's the expected transitional state.
 *
 * Any other invalid value is logged (`console.warn`, matching `lib/dal.ts`'s
 * own log style) so a bad write upstream doesn't fail silent.
 */
export function toRole(value: unknown, ctx: { fn: string; path: string }): Role {
  if (value === null || value === undefined) {
    return 'crew'
  }

  if (value === 'viewer') {
    return 'crew'
  }

  if (typeof value === 'string' && (ALLOWED_ROLES as readonly string[]).includes(value)) {
    return value as Role
  }

  let described: string
  try {
    described = String(value).slice(0, 32)
  } catch {
    described = '<unstringifiable>'
  }

  console.warn('[roles] invalid_role', { fn: ctx.fn, path: ctx.path, role: described })

  return 'crew'
}
