'use client'

import Button from '@/components/ui/Button'
import LeaveFacts from './LeaveFacts'
import styles from './LeaveCompanyReceipt.module.css'

interface LeaveCompanyReceiptProps {
  companyName: string
  /** False when the left company was the caller's only membership. */
  hadOtherMemberships: boolean
  email: string
  bookingCount: number
  onContinue: () => void
  onSignOut: () => void
}

/** "20 SEP 2026" — see the same helper in LeaveCompanyFlow for why this is
 *  not `toLocaleDateString`. */
const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function formatShortUpper(date: Date): string {
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/**
 * Post-leave receipt — a full-screen page of its own, not a panel inside the
 * flow's modal: by this point the membership is gone and there is nothing
 * behind it to go back to.
 */
export default function LeaveCompanyReceipt({
  companyName,
  hadOtherMemberships,
  email,
  bookingCount,
  onContinue,
  onSignOut,
}: LeaveCompanyReceiptProps) {
  return (
    <div className={styles.screen}>
      <div className={styles.body}>
        <span className={styles.wordmark}>ALLOCATE</span>
        <p className={styles.eyebrow}>
          Left {companyName} · {formatShortUpper(new Date())}
        </p>
        <h1 className={styles.title}>
          {hadOtherMemberships ? `You have left ${companyName}.` : 'You are not in any company.'}
        </h1>
        <p className={styles.lead}>
          {hadOtherMemberships
            ? 'Your access there has ended. Allocate has moved you to another of your companies.'
            : 'Your access there has ended. You are not a member of any company right now.'}
        </p>

        <LeaveFacts
          className={styles.facts}
          facts={[
            { label: 'Access', value: `Removed from ${companyName}.` },
            {
              label: 'Bookings',
              value: bookingCount > 0
                ? `${bookingCount} bookings kept in the company history, now without your name.`
                : 'The bookings you made are kept in the company history, now without your name.',
            },
            { label: 'Coming back', value: `Only a new invitation from an administrator at ${companyName}.` },
            { label: 'Receipt', value: `Sent to ${email}.` },
          ]}
        />
      </div>

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
