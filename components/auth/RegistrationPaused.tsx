import type { ReactNode } from 'react'
import AuthShell from './AuthShell'
import AuthCard from './AuthCard'
import Button from '@/components/ui/Button'
import styles from './RegistrationPaused.module.css'

export const SUPPORT_EMAIL = 'support@allocate.at'

export interface PausedAction {
  label: string
  /** Navigates. Mutually exclusive with `onClick`. */
  href?: string
  /** Only usable when the parent is a Client Component. */
  onClick?: () => void
  disabled?: boolean
}

interface RegistrationPausedProps {
  /** Which switch is on: new account sign-ups, or new company creation. */
  variant: 'accounts' | 'companies'
  /**
   * The signed-in user's email — "companies" only. Shown top-right and in the
   * "JOIN A TEAM INSTEAD" box. Omitted for a logged-out visitor on /signup,
   * who has no email yet: the box is then left out entirely.
   */
  email?: string
  /** Omitted on /no-company, where there is no safe in-app route to an invite. */
  primary?: PausedAction
  secondary: PausedAction
  /**
   * 'page' (default) is the full auth screen from the design. 'embedded' is
   * the same content without wordmark and shell, for the "New company" tab on
   * /signup, where the tab rail above it stays visible.
   */
  layout?: 'page' | 'embedded'
  /** Extra content under the buttons (page layout), e.g. GDPR self-service links. */
  children?: ReactNode
}

const COPY = {
  accounts: {
    heading: 'New accounts are paused',
    lead: "We're not taking new sign-ups right now. It's temporary — please try again later.",
  },
  companies: {
    heading: 'New companies are paused',
    lead: "We're not taking new companies right now. It's temporary — please try again later.",
  },
} as const

function ActionButton({ action, variant }: { action: PausedAction; variant: 'primary' | 'secondary' }) {
  if (action.href) {
    return (
      <Button href={action.href} variant={variant} size="lg" fullWidth>
        {action.label}
      </Button>
    )
  }
  return (
    <Button type="button" variant={variant} size="lg" fullWidth onClick={action.onClick} disabled={action.disabled}>
      {action.label}
    </Button>
  )
}

/**
 * The customer-facing "registration paused" screens
 * (design_handoff_system_controls: Konton pausade / Företag pausade).
 * Shown while an operator kill switch is on — see lib/registrationFlags.ts.
 */
export default function RegistrationPaused({
  variant,
  email,
  primary,
  secondary,
  layout = 'page',
  children,
}: RegistrationPausedProps) {
  const copy = COPY[variant]
  const embedded = layout === 'embedded'
  const showEmail = variant === 'companies' && !!email

  const body = (
    <>
      <span className={styles.chip}>
        <span className={styles.chipDot} />
        TEMPORARILY PAUSED
      </span>

      {embedded ? (
        <h2 className={`${styles.heading} ${styles.headingEmbedded}`}>{copy.heading}</h2>
      ) : (
        <h1 className={styles.heading}>{copy.heading}</h1>
      )}

      <p className={styles.lead}>
        {copy.lead}
        {variant === 'companies' && showEmail && ' Your account is ready and nothing is lost.'}
      </p>

      {variant === 'accounts' && (
        <div className={styles.infoBox}>
          <span className={styles.infoLabel}>GOT AN INVITATION?</span>
          <span className={styles.infoText}>
            Invitations still work. Open the link in your invitation email, or enter the code, to join your team.
          </span>
        </div>
      )}

      {variant === 'companies' && showEmail && (
        <div className={styles.infoBox}>
          <span className={styles.infoLabel}>JOIN A TEAM INSTEAD</span>
          <span className={styles.infoText}>
            Invitations still work. Open the link in the invitation email sent to {email} to join your team.
          </span>
        </div>
      )}

      <div className={styles.actions}>
        {primary && <ActionButton action={primary} variant="primary" />}
        <ActionButton action={secondary} variant="secondary" />
      </div>

      <span className={styles.questions}>
        Questions? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </span>

      {children}
    </>
  )

  if (embedded) return <div className={styles.embedded}>{body}</div>

  return (
    <AuthShell>
      <AuthCard width={440} gap={22} wordmarkAside={showEmail ? email : undefined}>
        {body}
      </AuthCard>
    </AuthShell>
  )
}
