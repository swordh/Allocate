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

import type { CompanyDeletion, Subscription } from '@/types'
import { PLAN_CATALOG, PLAN_ORDER, type PlanId } from '@/lib/plans'

/**
 * `DELETION_PENDING` (issue #252 step 5) is the one state in this union that
 * is NOT derived from the subscription. It comes from `company.deletion`, and
 * `toSubState` never returns it — see that function's own note and
 * `getSubStateDisplay` at the bottom of this file.
 */
export type SubStateKey = 'NONE' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'DELETION_PENDING'

export type StateAccent = 'accent' | 'danger' | 'neutral'
export type NoticeTone = 'info' | 'danger' | 'neutral'

interface SubStateDef {
  label: string
  accent: StateAccent
  cycle: (sub: Subscription | null, deletion?: CompanyDeletion | null) => string
  /** null on ACTIVE — the only state that renders no notice banner. */
  notice:
    | ((sub: Subscription | null, companyName: string, deletion?: CompanyDeletion | null) => string)
    | null
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
 *
 * Deliberately UNCHANGED by issue #252 step 5. `DELETION_PENDING` is never
 * returned from here, because it is not a property of the subscription:
 * `pause_collection` leaves `subscription.status` exactly as it was (see the
 * comment on `Subscription.pauseCollection` in types/company.ts), so a paused
 * subscription is indistinguishable from an unpaused one at this level — and
 * a pause is ambiguous anyway, since we may one day pause for other reasons.
 * The deletion state is read from `company.deletion` in `getSubStateDisplay`.
 *
 * This function is also locked by `__tests__/subscription-state.test.ts` in
 * ways that are load-bearing, in particular that an unrecognised status
 * (including Stripe's own `paused`) maps to `NONE`. Do not route the new
 * state through here.
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
    // `hasPaymentMethod` (below, in getSubStateDisplay) swaps this notice for
    // one that doesn't ask for a card Checkout already collected. Kept here
    // as the definition's own default, not read from `opts` directly — this
    // table has no access to `opts`, see the override in getSubStateDisplay.
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
  /**
   * A company with a deletion scheduled. Overrides every subscription state
   * when `company.deletion` is present, because it is the only thing an admin
   * looking at this screen needs to act on.
   *
   * Why this is not "PAUSED": the design brief requires that "Radering
   * begärd" and "uppsagt" be different messages to an admin deciding whether
   * to stop it, and the word `paused` is already spoken for twice in this
   * codebase with two different meanings (the webhook maps Stripe's `paused`
   * status to `past_due`; the locked test maps `'paused'` to `NONE`). This
   * state describes what is happening to the COMPANY; the billing pause is a
   * consequence of it, mentioned in the notice rather than made the headline.
   *
   * The notice names the no-refund rule on purpose. The brief is explicit
   * that it "ska framgå innan raderingen bekräftas, inte upptäckas efteråt",
   * and this is the surface that stays visible for the whole seven days.
   */
  DELETION_PENDING: {
    label: 'DELETION REQUESTED',
    accent: 'danger',
    cycle: (_sub, deletion) => `Company deleted ${formatDate(deletion?.scheduledFor)} · billing paused`,
    notice: (_sub, companyName, deletion) =>
      `${deletion?.requestedByName || 'An administrator'} asked for ${companyName} to be deleted on ${formatDate(
        deletion?.scheduledFor,
      )}. Everything keeps working until then, and any administrator can stop it. No charges are made while a deletion is scheduled, and time already paid for is not refunded.`,
    cta: 'STOP DELETION',
    tone: 'danger',
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

/**
 * Resolves the full display payload — the single entry point components
 * should use.
 *
 * `deletion` is `company.deletion` (lib/queries/company.ts maps it; see the
 * warning there about fields that exist only in the type). Its mere PRESENCE
 * means a deletion is scheduled or running: the data model has no "cancelled"
 * value, a cancelled deletion removes the field entirely, so absence is the
 * only "nothing is going on" signal and no state comparison is needed or
 * wanted here. See `CompanyDeletionState` in types/company.ts.
 *
 * It overrides every subscription-derived state. An admin whose company is
 * counting down to deletion does not need to be told her card renews first.
 *
 * `hasSub` stays false for `DELETION_PENDING` only when there is genuinely no
 * subscription — it is a question about the subscription, and a deletion does
 * not remove one. The company keeps working for the whole window; nothing
 * about this state is a gate. The four subscription gates in this codebase
 * are deliberately untouched by #252 step 5: `pause_collection` leaves
 * `subscription.status` alone precisely so the product keeps functioning, per
 * the brief's "Företaget fungerar som vanligt — utan undantag".
 */
export function getSubStateDisplay(
  sub: Subscription | null,
  companyName: string,
  deletion?: CompanyDeletion | null,
  /**
   * `hasPaymentMethod` (fix/trial-notice-card-on-file) — whether Stripe
   * already has a payment method on file for this trialing subscription
   * (`lib/trialPaymentMethod.ts`, checked live, never stored). Checkout
   * collects a card at signup, so every trialing company already has one;
   * without this, TRIAL's default notice wrongly asks the admin to "add a
   * payment method" she already added. Only consulted for the TRIAL state —
   * every other state ignores it.
   */
  opts?: { hasPaymentMethod?: boolean },
): SubStateDisplay {
  const key: SubStateKey = deletion ? 'DELETION_PENDING' : toSubState(sub)
  const def = SUB_STATES[key]

  const trialCardOnFile = key === 'TRIAL' && opts?.hasPaymentMethod === true

  let label = def.label
  let cycle = def.cycle(sub, deletion)
  let notice = def.notice ? def.notice(sub, companyName, deletion) : null

  // Issue #331/#335: `DELETION_PENDING`'s table entry above is written for
  // the 'requested' case only — "any administrator can stop it", a scheduled
  // date, all the language of a countdown that is still cancellable. Once
  // the sweep has claimed the purge ('executing') or it has stalled
  // ('failed'), none of that is true any more, and neither state has a
  // meaningful date to quote — 'executing' because the deletion is happening
  // NOW, not "scheduled"; 'failed' because the scheduled date already came
  // and went without finishing. Overridden here, once, rather than in
  // SUB_STATES' own table, so the 'requested' definition above stays the
  // single source of truth for the common case and this stays the one place
  // that departs from it.
  //
  // REVIEW FIX: this used to say "billing paused" / "billing remains
  // paused" unconditionally. `pauseSubscriptionForDeletion`
  // (lib/companyDeletionStripe.ts) runs once, at REQUEST time, and is
  // best-effort/non-fatal by design — its outcome (`stripePause.effect`,
  // which can be `'failed'`) is recorded on the `companyDeletions` LEDGER,
  // never on the `companies/{cid}.deletion` MIRROR this function actually
  // receives. There is no way for this admin-facing surface to know whether
  // the pause actually took, so it can no longer promise that it did —
  // softened to match the same "contact support if you notice a charge"
  // posture the `companyDeletionFailed` mail takes for the same reason (see
  // that template's `billingStopped` field).
  if (key === 'DELETION_PENDING' && deletion && deletion.state !== 'requested') {
    if (deletion.state === 'executing') {
      label = 'DELETION IN PROGRESS'
      cycle = 'Deletion in progress'
      notice =
        "This company's deletion has started and can no longer be stopped from here. Billing should already be paused — contact support if you notice a charge."
    } else if (deletion.state === 'failed') {
      label = 'DELETION STUCK'
      cycle = "Deletion hasn't finished"
      notice =
        "This company's deletion ran into a problem and hasn't finished. Our support team can see this and will follow up. If you notice any further charges, contact support."
    }
  }

  return {
    key,
    hasSub: key === 'DELETION_PENDING' ? sub !== null : key !== 'NONE',
    label,
    accent: def.accent,
    cycle,
    notice: trialCardOnFile ? `Your trial ends ${formatDate(sub?.trialEnd)}. Your card will be charged then.` : notice,
    cta: trialCardOnFile ? '' : def.cta,
    tone: def.tone,
  }
}
