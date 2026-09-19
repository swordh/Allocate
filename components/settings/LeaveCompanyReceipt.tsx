import Button from '@/components/ui/Button'
import styles from './LeaveCompanyReceipt.module.css'

interface LeaveCompanyReceiptProps {
  companyName: string
  /** False when the left company was the caller's only membership. */
  hadOtherMemberships: boolean
  onContinue: () => void
  onSignOut: () => void
}

/** "You have left {company}" result screen — issue #352's leave-company flow. */
export default function LeaveCompanyReceipt({
  companyName,
  hadOtherMemberships,
  onContinue,
  onSignOut,
}: LeaveCompanyReceiptProps) {
  return (
    <div className={styles.wrap}>
      <p className={styles.eyebrow}>You left · today</p>
      <h2 className={styles.title}>
        {hadOtherMemberships ? `You are no longer a member of ${companyName}` : 'You are not in any company'}
      </h2>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Access</dt>
          <dd>Removed now — and on your other devices.</dd>
        </div>
        <div className={styles.fact}>
          <dt>Your data</dt>
          <dd>Anonymised, not deleted. The team keeps the history it needs.</dd>
        </div>
        <div className={styles.fact}>
          <dt>Coming back</dt>
          <dd>Only by invitation from an administrator.</dd>
        </div>
        <div className={styles.fact}>
          <dt>Receipt</dt>
          <dd>An email confirmation was sent to you.</dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <Button variant="primary" size="sm" onClick={onContinue}>
          {hadOtherMemberships ? 'CONTINUE' : 'CREATE A COMPANY'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onSignOut}>
          SIGN OUT
        </Button>
      </div>
    </div>
  )
}
