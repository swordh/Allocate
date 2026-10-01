'use client'

import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'
import type { DeletionOutcome } from '@/lib/queries/deletionOutcomes'
import styles from './LeaveCompanyEntry.module.css'

interface LeaveCompanyEntryProps {
  companyName: string
  /** Advisory only — the same per-company reading the delete-account panel
   *  uses (`getDeletionOutcomes`). It decides the copy and whether the
   *  blocked reason is shown up front; `leaveCompany` re-decides for real
   *  when the user actually acts. */
  outcome: DeletionOutcome
  /** Total members including the caller — the blocked reason names how many
   *  would be left behind. */
  memberCount: number
  onOpen: () => void
}

function bodyCopy(companyName: string, outcome: DeletionOutcome): string {
  switch (outcome) {
    case 'leave':
      return 'You lose access to bookings, equipment and the team right away. Your bookings stay in the history without your name.'
    case 'blocked':
      return 'Hand the administrator role to someone else first — you are the only one at the moment.'
    case 'close':
      return `You are the only member, so leaving ends ${companyName}. Same seven days as an ordinary company deletion.`
    case 'unknown':
      return 'Something went wrong reading this company. That is a technical problem, not something blocking you — try again in a moment.'
  }
}

/**
 * The "Leave {company}" card on both settings entry points (issue #352):
 * Account → My companies (one per membership) and Company → My membership
 * (the active company). A blocked membership says so here, before the flow
 * opens, rather than letting the user press Leave and bounce off a guard.
 */
export default function LeaveCompanyEntry({
  companyName,
  outcome,
  memberCount,
  onOpen,
}: LeaveCompanyEntryProps) {
  const blocked = outcome === 'blocked'
  const othersLeftBehind = Math.max(memberCount - 1, 0)

  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} ${blocked ? styles.cardBlocked : ''}`}>
        <div className={styles.text}>
          <p className={styles.title}>Leave {companyName}</p>
          <p className={styles.body}>{bodyCopy(companyName, outcome)}</p>
        </div>
        <Button
          variant={blocked ? 'secondary' : 'danger'}
          size="sm"
          onClick={onOpen}
          className={styles.action}
        >
          {blocked ? 'SEE WHAT IS NEEDED' : 'LEAVE COMPANY…'}
        </Button>
      </div>

      {blocked && (
        <div className={styles.reason}>
          <Chip size="tag" tone="accent" interactive={false}>
            Blocked
          </Chip>
          <p className={styles.reasonText}>
            {othersLeftBehind} {othersLeftBehind === 1 ? 'member' : 'members'} would be left with nobody who
            can manage equipment, invite people or handle billing.
          </p>
        </div>
      )}
    </div>
  )
}
