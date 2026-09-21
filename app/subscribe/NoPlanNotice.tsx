import AccountRightsLink from './AccountRightsLink'
import s from './NoPlanNotice.module.css'

/**
 * Issue #350 (GDPR) — what a non-admin sees at `/subscribe` instead of the
 * plan grid. See `app/subscribe/page.tsx`'s docblock for why this route
 * needs its own role split even though `evaluateAppAccess` already keeps a
 * blocked non-admin from being redirected here by the `(app)` layout.
 *
 * Deliberately renders no plan grid and no button. `createCheckoutSession`
 * (actions/subscription.ts) rejects any non-admin with `{ error: 'Only an
 * administrator can change the plan.' }` — that message exists for a direct
 * server-action call, not as UI copy to surface here. A disabled-but-visible
 * plan grid would invite exactly the click that produces it; this component
 * doesn't offer the control at all.
 *
 * A Server Component, like `SubscribePage`'s sibling — no interactive state
 * of its own.
 */
export default function NoPlanNotice() {
  return (
    <div className={s.wrapper}>
      <span className={s.logo}>ALLOCATE</span>

      <div className={s.intro}>
        <span className={s.eyebrow}>NO ACTIVE SUBSCRIPTION</span>
        <h1 className={s.heading}>No active plan</h1>
        <p className={s.subheading}>
          This company has no active subscription. Only an administrator can choose a plan — ask yours to sign in
          and pick one from Settings.
        </p>
      </div>

      <AccountRightsLink />
    </div>
  )
}
