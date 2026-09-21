/**
 * Issue #350 (GDPR) — `lib/subscriptionAccess.ts`.
 *
 * The bug this closes: `app/(app)/layout.tsx` used to fail-closed to
 * `/subscribe` for any subscription status it didn't explicitly whitelist,
 * including `undefined` (no `subscription` field at all — a company that
 * never started checkout). That blocked `/settings/account`, the one page
 * that carries Art. 17/20 (Delete Account, Export my data) and the URL
 * `app/privacy/page.tsx` already promises works "directly from Settings".
 *
 * `evaluateAppAccess` is tested table-driven across the role/status matrix,
 * with the prefix-hole regression named explicitly (it's the exact shape of
 * bug a bare `startsWith` reintroduces), plus the two structural invariants
 * the plan calls out: the data-table lock on `SETTINGS_ITEMS` and the
 * coupling invariant between `settingsItemsFor` and `evaluateAppAccess`.
 */

import { describe, it, expect } from 'vitest'
import { evaluateAppAccess, hasFullAccess, needsSubscription } from '@/lib/subscriptionAccess'
import { SETTINGS_ITEMS, settingsItemsFor } from '@/components/nav/nav-items'
import type { Role } from '@/types'

const ROLES: Role[] = ['admin', 'crew', 'viewer']

describe('hasFullAccess / needsSubscription', () => {
  it('are exact inverses', () => {
    const cases: [string | undefined, string | null][] = [
      ['active', null],
      ['trialing', '2026-06-01'],
      ['trialing', null],
      ['past_due', null],
      ['canceled', null],
      [undefined, null],
    ]
    for (const [status, trialEnd] of cases) {
      expect(hasFullAccess(status, trialEnd)).toBe(!needsSubscription(status, trialEnd))
    }
  })
})

describe('evaluateAppAccess — full access', () => {
  it('allows any pathname, any role, when the subscription is active', () => {
    for (const role of ROLES) {
      expect(evaluateAppAccess({ pathname: '/bookings', role, subStatus: 'active', trialEnd: null })).toEqual({
        allowed: true,
      })
    }
  })

  it('allows a real Stripe trial (trialEnd set)', () => {
    expect(
      evaluateAppAccess({ pathname: '/equipment', role: 'admin', subStatus: 'trialing', trialEnd: '2026-06-01' }),
    ).toEqual({ allowed: true })
  })
})

describe('evaluateAppAccess — fail-closed pathname, role-aware', () => {
  // Not knowing the path is not a license to ignore the role split: an
  // admin still goes to /subscribe (the only role that can act there), and
  // a non-admin still goes to /settings/account, never /subscribe — same as
  // every other rejection branch in evaluateAppAccess.
  const MISSING_PATHNAMES: (string | null | undefined)[] = [null, undefined, '']

  for (const pathname of MISSING_PATHNAMES) {
    it(`admin with pathname=${JSON.stringify(pathname)} redirects to /subscribe`, () => {
      expect(evaluateAppAccess({ pathname, role: 'admin', subStatus: undefined, trialEnd: null })).toEqual({
        allowed: false,
        redirectTo: '/subscribe',
      })
    })

    it(`crew with pathname=${JSON.stringify(pathname)} redirects to /settings/account, never /subscribe`, () => {
      expect(evaluateAppAccess({ pathname, role: 'crew', subStatus: undefined, trialEnd: null })).toEqual({
        allowed: false,
        redirectTo: '/settings/account',
      })
    })

    it(`viewer with pathname=${JSON.stringify(pathname)} redirects to /settings/account, never /subscribe`, () => {
      expect(evaluateAppAccess({ pathname, role: 'viewer', subStatus: undefined, trialEnd: null })).toEqual({
        allowed: false,
        redirectTo: '/settings/account',
      })
    })
  }
})

describe('evaluateAppAccess — bare /settings pass-through', () => {
  it('allows bare /settings regardless of role or plan', () => {
    for (const role of ROLES) {
      expect(evaluateAppAccess({ pathname: '/settings', role, subStatus: undefined, trialEnd: null })).toEqual({
        allowed: true,
      })
    }
  })
})

describe('evaluateAppAccess — the prefix hole (named regression tests)', () => {
  // The bug a bare `p.startsWith(href)` would reintroduce: '/settings/accountant'
  // shares a string prefix with '/settings/account' but is a wholly unrelated
  // route with no claim to always-available status.
  it('rejects /settings/accountant', () => {
    expect(evaluateAppAccess({ pathname: '/settings/accountant', role: 'admin', subStatus: undefined, trialEnd: null })).toEqual({
      allowed: false,
      redirectTo: '/subscribe',
    })
  })

  it('rejects /settings/account-export', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/account-export', role: 'crew', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: false, redirectTo: '/settings/account' })
  })

  it('allows /settings/account/export (a true sub-route, segment-prefixed)', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/account/export', role: 'viewer', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: true })
  })

  it('allows /settings/account itself (exact match)', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/account', role: 'viewer', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: true })
  })
})

describe('evaluateAppAccess — statuses outside SubscriptionStatus (the issue\'s actual regression class)', () => {
  const UNMAPPED_STATUSES = ['unpaid', 'paused', 'incomplete_expired', 'nonsense']

  for (const status of UNMAPPED_STATUSES) {
    it(`'${status}' reaches /settings/account for a non-admin`, () => {
      expect(
        evaluateAppAccess({ pathname: '/settings/account', role: 'crew', subStatus: status, trialEnd: null }),
      ).toEqual({ allowed: true })
    })

    it(`'${status}' blocked from a non-always-available route redirects a non-admin to /settings/account, not /subscribe`, () => {
      expect(evaluateAppAccess({ pathname: '/bookings', role: 'crew', subStatus: status, trialEnd: null })).toEqual({
        allowed: false,
        redirectTo: '/settings/account',
      })
    })

    it(`'${status}' blocked from a non-always-available route redirects an admin to /subscribe`, () => {
      expect(evaluateAppAccess({ pathname: '/bookings', role: 'admin', subStatus: status, trialEnd: null })).toEqual({
        allowed: false,
        redirectTo: '/subscribe',
      })
    })
  }
})

describe('evaluateAppAccess — role mismatch on an always-available route', () => {
  it('crew hitting /settings/company (admin-only) lands on /settings/account, never /subscribe', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/company', role: 'crew', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: false, redirectTo: '/settings/account' })
  })

  it('viewer hitting /settings/subscription (admin-only) lands on /settings/account', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/subscription', role: 'viewer', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: false, redirectTo: '/settings/account' })
  })

  it('admin reaches /settings/company with no plan', () => {
    expect(
      evaluateAppAccess({ pathname: '/settings/company', role: 'admin', subStatus: undefined, trialEnd: null }),
    ).toEqual({ allowed: true })
  })
})

describe('evaluateAppAccess — decision: non-admin never sent to /subscribe', () => {
  it('crew blocked anywhere lands on /settings/account', () => {
    expect(evaluateAppAccess({ pathname: '/equipment', role: 'crew', subStatus: 'canceled', trialEnd: null })).toEqual(
      { allowed: false, redirectTo: '/settings/account' },
    )
  })

  it('viewer blocked anywhere lands on /settings/account', () => {
    expect(evaluateAppAccess({ pathname: '/bookings', role: 'viewer', subStatus: 'past_due', trialEnd: null })).toEqual(
      { allowed: false, redirectTo: '/settings/account' },
    )
  })

  it('admin blocked anywhere lands on /subscribe', () => {
    expect(evaluateAppAccess({ pathname: '/bookings', role: 'admin', subStatus: 'canceled', trialEnd: null })).toEqual(
      { allowed: false, redirectTo: '/subscribe' },
    )
  })
})

describe('data-table lock — SETTINGS_ITEMS.alwaysAvailable', () => {
  it('is exactly Account, Company, Subscription — a flag flip here is a loud, named failure, not a silent Team/Preferences opening', () => {
    const alwaysAvailableHrefs = SETTINGS_ITEMS.filter((i) => i.alwaysAvailable).map((i) => i.href)
    expect(alwaysAvailableHrefs).toEqual(['/settings/account', '/settings/company', '/settings/subscription'])
  })
})

describe('coupling invariant — settingsItemsFor and evaluateAppAccess never disagree', () => {
  it('every item settingsItemsFor(role, false) shows is allowed=true in evaluateAppAccess for that same role/plan', () => {
    for (const role of ROLES) {
      const items = settingsItemsFor(role, false)
      expect(items.length).toBeGreaterThan(0) // Account always shows for every role
      for (const item of items) {
        const decision = evaluateAppAccess({ pathname: item.href, role, subStatus: undefined, trialEnd: null })
        expect(decision).toEqual({ allowed: true })
      }
    }
  })
})
