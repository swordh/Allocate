import Link from 'next/link'
import s from './AccountRightsLink.module.css'

/**
 * Issue #350 (GDPR) — the piece that makes `app/privacy/page.tsx`'s "Delete
 * your placeholder directly from Settings" promise true on THIS page too.
 *
 * `/subscribe` is the one screen an admin can be stuck on with no way
 * forward (no plan chosen yet, checkout not started) and no way back (every
 * other `(app)` route redirects here). Before #350, Account Settings — the
 * only self-service surface for Art. 17/20 (Delete Account, Export my data,
 * `components/settings/AccountSettingsForm.tsx`) — was unreachable from
 * here, meaning an admin had to hand over billing before exercising rights
 * that have nothing to do with billing. `evaluateAppAccess` now makes
 * `/settings/account` reachable regardless of plan, but that fixes the
 * `(app)` route group; this page is outside it, so the link still needs to
 * exist here, explicitly.
 *
 * No `'use client'` — a plain server-renderable link with no state — so it
 * composes into both the admin's client `SubscribePage` and the server
 * `NoPlanNotice` without either needing to special-case it. Rendered in
 * BOTH views on purpose: an admin should not have to complete a Stripe
 * checkout before reaching her own data rights any more than a blocked
 * member should.
 */
export default function AccountRightsLink() {
  return (
    <p className={s.wrapper}>
      <Link href="/settings/account" className={s.link}>
        Export or delete your personal data in Account settings
      </Link>
    </p>
  )
}
