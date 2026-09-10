import Link from 'next/link'
import AuthShell from '@/components/auth/AuthShell'
import AuthCard from '@/components/auth/AuthCard'
import styles from '../[token]/InviteAccept.module.css'

/**
 * Single, case-agnostic landing page for every invalid invitation link —
 * missing mirror/private doc, revoked, already accepted, or expired.
 * `app/invite/[token]/page.tsx` redirects here for all four instead of
 * rendering a distinct card per case, so the copy deliberately doesn't say
 * which one applies (no reason to leak that to whoever is holding the link).
 *
 * Static segment `invalid` takes priority over the `[token]` dynamic route,
 * so this doesn't collide with `/invite/<token>`.
 */
export default function InvalidInvitePage() {
  return (
    <AuthShell>
      <AuthCard width={440} gap={24}>
        <div className={styles.titleBlock}>
          <span className={`${styles.eyebrow} ${styles.eyebrowDanger}`}>INVITATION NOT VALID</span>
          <h1 className={styles.title}>Link no longer valid</h1>
          <span className={styles.lede}>
            This invitation link can&rsquo;t be used. Ask whoever invited you to send a new one.
          </span>
        </div>

        <div className={styles.actions}>
          <Link className={styles.linkPrimary} href="/login">
            Go to sign in
          </Link>
          <Link className={styles.linkSecondary} href="/signup">
            Create a new company
          </Link>
        </div>
      </AuthCard>
    </AuthShell>
  )
}
