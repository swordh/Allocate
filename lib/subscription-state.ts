// Client-safe five-state subscription model shared by the settings
// subscription view and (indirectly) the standalone /subscribe page.
//
// Ports `SUB_STATES` from design_handoff_allocate/screens/settings/
// "12-16 Inställningar.dc.html" (desktop) verbatim in shape — label, accent,
// cycle(), notice, cta, tone — with the prototype's hardcoded demo dates
// replaced by formatters over the real `currentPeriodEnd` / `trialEnd`
// fields on `Subscription`. No `server-only` import: this is read directly
// by the client component in components/settings/SubscriptionView.tsx.
//
// `accent` drives the status pill / left-border color (amber / red / grey).
// `tone` maps 1:1 onto ErrorBanner's NoticeTone ('info' | 'danger' | 'neutral').

import type { Subscription } from '@/types'
import { PLAN_CATALOG, PLAN_ORDER, type PlanId } from '@/lib/plans'

export type SubStateKey = 'NONE' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED'

export type StateAccent = 'accent' | 'danger' | 'neutral'
export type NoticeTone = 'info' | 'danger' | 'neutral'

interface SubStateDef {
  label: string
  accent: StateAccent
  cycle: (sub: Subscription | null) => string
  /** null on ACTIVE — the only state that renders no notice banner. */
  notice: ((sub: Subscription | null, companyName: string) => string) | null
  cta: string
  tone: NoticeTone
}

export interface SubStateDisplay {
  key: SubStateKey
  hasSub: boolean
  label: string
  accent: StateAccent
  cycle: string
  notice: string | null
  cta: string
  tone: NoticeTone
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysLeft(iso: string | null | undefined): number {
  if (!iso) return 0
  const end = new Date(iso).getTime()
  if (Number.isNaN(end)) return 0
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000))
}

/**
 * Maps a Firestore-mirrored Subscription onto one of five display states.
 *
 * - `null` (no subscription doc / field)         → NONE
 * - `trialing`                                    → TRIAL
 * - `active` with `cancelAtPeriodEnd: true`        → CANCELED (Stripe does
 *   not flip `status` until the period actually ends; the design's "Access
 *   ends <date>" copy is exactly this situation, so it renders as CANCELED
 *   even though Stripe still reports `active`)
 * - `active` otherwise                             → ACTIVE
 * - `past_due` or `incomplete`                     → PAST_DUE (both are
 *   "payment is not going through, Stripe/we are still trying" from the
 *   user's point of view — incomplete is the initial-payment-failed case,
 *   past_due is the recurring-payment-failed case)
 * - `canceled`                                     → CANCELED
 */
export function toSubState(sub: Subscription | null): SubStateKey {
  if (!sub) return 'NONE'

  switch (sub.status) {
    case 'trialing':
      return 'TRIAL'
    case 'active':
      return sub.cancelAtPeriodEnd ? 'CANCELED' : 'ACTIVE'
    case 'past_due':
    case 'incomplete':
      return 'PAST_DUE'
    case 'canceled':
      return 'CANCELED'
    default:
      // Fail closed: an unrecognised status is treated as no subscription.
      return 'NONE'
  }
}

const SUB_STATES: Record<SubStateKey, SubStateDef> = {
  ACTIVE: {
    label: 'ACTIVE',
    accent: 'accent',
    cycle: (sub) =>
      `${sub?.interval === 'year' ? 'Billed yearly' : 'Billed monthly'} · renews ${formatDate(sub?.currentPeriodEnd)}`,
    notice: null,
    cta: '',
    tone: 'neutral',
  },
  TRIAL: {
    label: 'TRIAL',
    accent: 'accent',
    cycle: (sub) => `Trial · ${daysLeft(sub?.trialEnd)} days left`,
    notice: (sub) =>
      `Your trial ends ${formatDate(sub?.trialEnd)}. Add a payment method before then to keep your bookings and equipment.`,
    cta: 'ADD PAYMENT METHOD',
    tone: 'info',
  },
  PAST_DUE: {
    label: 'PAST DUE',
    accent: 'danger',
    cycle: () => 'Payment failed · Stripe is retrying',
    notice: (sub) =>
      `We could not charge your card. Bookings still work until ${formatDate(sub?.currentPeriodEnd)}, after which the workspace becomes read-only.`,
    cta: 'UPDATE CARD',
    tone: 'danger',
  },
  CANCELED: {
    label: 'CANCELED',
    accent: 'neutral',
    cycle: (sub) => `Access ends ${formatDate(sub?.currentPeriodEnd)}`,
    notice: (sub) =>
      `This subscription is canceled. You keep full access until ${formatDate(sub?.currentPeriodEnd)} — after that, bookings are read-only.`,
    cta: 'RESUME PLAN',
    tone: 'neutral',
  },
  NONE: {
    // Desktop design has label: '' / cta: '' here, which would render an
    // empty pill and an empty button. The mobile file uses 'NO PLAN' /
    // 'PICK A PLAN' for the same state — using those on both breakpoints.
    label: 'NO PLAN',
    accent: 'neutral',
    cycle: () => '',
    notice: (_sub, companyName) =>
      `${companyName} has no active subscription. Pick a plan to start creating bookings again.`,
    cta: 'PICK A PLAN',
    tone: 'neutral',
  },
}

/**
 * CTA copy for a single plan card in the plan picker grid.
 *
 * The prototype this was ported from hardcodes `current = 'Starter'`, so its
 * `current ? 'CURRENT PLAN' : 'UPGRADE'` branch only ever fires from the
 * cheaper plan looking at the more expensive one — it never covers being on
 * the higher plan and picking the cheaper one. Direction here is derived
 * from `PLAN_ORDER` (cheapest first, see lib/plans.ts) rather than from a
 * hardcoded plan-name comparison, so it keeps working if a third plan is
 * ever added.
 */
export function getPlanCardCta(plan: PlanId, sub: Subscription | null): string {
  if (!sub) return `CHOOSE ${PLAN_CATALOG[plan].name.toUpperCase()}`
  if (sub.plan === plan) return 'CURRENT PLAN'
  return PLAN_ORDER.indexOf(plan) < PLAN_ORDER.indexOf(sub.plan) ? 'DOWNGRADE' : 'UPGRADE'
}

/** Resolves the full display payload for a subscription — the single entry point components should use. */
export function getSubStateDisplay(sub: Subscription | null, companyName: string): SubStateDisplay {
  const key = toSubState(sub)
  const def = SUB_STATES[key]
  return {
    key,
    hasSub: key !== 'NONE',
    label: def.label,
    accent: def.accent,
    cycle: def.cycle(sub),
    notice: def.notice ? def.notice(sub, companyName) : null,
    cta: def.cta,
    tone: def.tone,
  }
}
