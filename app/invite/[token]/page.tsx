import { adminDb } from '@/lib/firebase-admin'
import Link from 'next/link'
import type { InvitationMirror } from '@/types'
import InviteAcceptClient from './InviteAcceptClient'
import styles from './InvitePage.module.css'

interface InvitePageProps {
  params: Promise<{ token: string }>
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params

  // Read the top-level mirror — publicly readable (see firestore.rules)
  const mirrorSnap = await adminDb.collection('invitations').doc(token).get()

  if (!mirrorSnap.exists) {
    return <InviteShell><InvalidState reason="This invitation link is invalid or has expired." /></InviteShell>
  }

  const mirror = mirrorSnap.data() as InvitationMirror

  if (mirror.status !== 'pending') {
    const label = mirror.status === 'accepted' ? 'already been accepted' : 'been revoked'
    return (
      <InviteShell>
        <InvalidState reason={`This invitation has ${label}.`} />
      </InviteShell>
    )
  }

  // Read company name
  const companySnap = await adminDb.doc(`companies/${mirror.companyId}`).get()
  const companyName: string = companySnap.exists
    ? ((companySnap.data()?.name as string) ?? 'a company')
    : 'a company'

  return (
    <InviteShell>
      {/* Client component: handles already-signed-in users and renders CTAs
          for unauthenticated visitors. */}
      <InviteAcceptClient
        token={token}
        companyName={companyName}
        email={mirror.email}
      />
    </InviteShell>
  )
}

// ── Shell layout ───────────────────────────────────────────────────────────────

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.wordmark}>ALLOCATE</span>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <p>© 2026 ALLOCATE. ALL RIGHTS RESERVED.</p>
      </footer>
    </div>
  )
}

function InvalidState({ reason }: { reason: string }) {
  return (
    <div className={styles.card}>
      <p className={styles.invalidLabel}>Invalid invitation</p>
      <p className={styles.invalidReason}>{reason}</p>
      <Link href="/login" className={styles.btnPrimary}>
        Go to sign in
      </Link>
    </div>
  )
}
