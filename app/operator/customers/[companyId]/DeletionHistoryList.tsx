import Link from 'next/link'
import Chip from '@/components/ui/Chip'
import EmptyState from '@/components/ui/EmptyState'
import { formatDateFullInZone } from '@/lib/dates'
import {
  LEDGER_STATE_LABELS,
  PHASE_LABELS,
  MAX_PURGE_ATTEMPTS,
  STRIPE_EFFECT_LABELS,
  identityDisplay,
  isStuckDeletion,
  nowMs,
  phaseProgressLabel,
  timeRemaining,
  type OutcomeTone,
} from '@/lib/operatorDeletionView'
import type { CompanyDeletionRow } from '@/types/operator'
import styles from './deletion.module.css'

/**
 * Renders a `CompanyDeletionRow`'s history — shared by the per-company
 * detail page (one company, its own timeline) and the two site-wide list
 * entries under /operator/deletions (many companies, one row each).
 *
 * Zone note: every absolute instant here renders in UTC, not the company's
 * own `preferences.timezone` the way the customer-facing banner does
 * (lib/companyDeletionBanner.ts). That banner's zone choice exists so a
 * member reads the SAME calendar date their own bookings are dated in — a
 * concern that doesn't apply to an operator, who has no bookings of their
 * own in any company's zone and, on the site-wide views, is looking at many
 * companies with different zones side by side; picking any one company's
 * zone there would make dates inconsistent from row to row, and picking
 * "the operator's own zone" isn't meaningful either — this is a server
 * render with no browser-local zone to read. UTC is the one zone every row
 * agrees on. The more important signal for "is there still time to act" —
 * `timeRemaining` below — is a duration, not an instant, so it carries no
 * zone dependency at all; the UTC date is secondary, supporting context.
 */
const ZONE = 'UTC'

function chipTone(tone: OutcomeTone): 'neutral' | 'accent' | 'danger' {
  return tone
}

function IdentityLine({ label, value, email }: { label: string; value: string | null | undefined; email?: string | null }) {
  const display = identityDisplay(value)
  if (display.kind === 'known') {
    return (
      <span className={styles.metaLine}>
        {label} <strong>{display.text}</strong>
        {email ? ` (${email})` : ''}
      </span>
    )
  }
  if (display.kind === 'redacted') {
    return (
      <span className={styles.metaLine}>
        {label} <em className={styles.redacted}>redacted (24-month retention)</em>
      </span>
    )
  }
  return null // 'never' — nothing to render, the whole line is omitted.
}

function StripeOutcomeLine({ label, outcome }: { label: string; outcome: CompanyDeletionRow['stripePause'] }) {
  if (!outcome) return null
  const info = STRIPE_EFFECT_LABELS[outcome.effect as keyof typeof STRIPE_EFFECT_LABELS]
  return (
    <div className={styles.stripeLine}>
      <span className={styles.metaLine}>{label}</span>
      <Chip size="tag" interactive={false} tone={chipTone(info?.tone ?? 'neutral')}>
        {info?.label ?? outcome.effect}
      </Chip>
      {outcome.error && <span className={styles.errorText}>{outcome.error}</span>}
    </div>
  )
}

export function DeletionRow({ row, showCompanyName, linkToCompany }: {
  row: CompanyDeletionRow
  showCompanyName?: boolean
  linkToCompany?: boolean
}) {
  const now = nowMs()
  const stuck = isStuckDeletion(row, now)
  const remaining = row.state === 'requested' ? timeRemaining(row.scheduledFor, now) : null

  return (
    <div className={styles.historyRow}>
      <div className={styles.historyRowHeader}>
        {/*
         * `accent` is this app's genuine-success tone — STRIPE_EFFECT_LABELS.applied
         * (lib/operatorDeletionView.ts) uses it for a Stripe action that actually
         * succeeded. 'requested' is a pending, destructive, time-sensitive state, not
         * a success, so it must never render in that tone — an operator scanning the
         * list would read "DELETION REQUESTED" as "this went fine". 'canceled' is a
         * resolved, harmless outcome (the deletion was averted) rather than a success
         * to celebrate either, so it groups with 'completed' instead of `accent`.
         * Only `danger` (failed/stuck) and `accent` (executing — the one state still
         * genuinely "in flight towards a positive Stripe-style outcome") keep a
         * non-neutral tone; everything already resolved, including 'requested'
         * pending resolution, falls back to `neutral`. The row's own "Scheduled for
         * ... — N days left" text (`styles.remaining`) carries the actual urgency
         * signal for 'requested', not this chip's color — see Chip.tsx, whose three
         * tones (neutral | accent | danger) have no fourth "caution" option to spend
         * on that here.
         */}
        <Chip
          size="tag"
          interactive={false}
          tone={
            row.state === 'failed' || stuck
              ? 'danger'
              : row.state === 'executing'
                ? 'accent'
                : 'neutral'
          }
        >
          {LEDGER_STATE_LABELS[row.state]}
        </Chip>
        {stuck && (
          <Chip size="tag" interactive={false} tone="danger">
            STUCK
          </Chip>
        )}
        <span className={styles.metaLine}>{row.mode === 'immediate' ? 'Immediate (no window)' : 'Window'}</span>
        {showCompanyName && (
          linkToCompany ? (
            <Link href={`/operator/customers/${row.companyId}`} className={styles.companyLink}>
              {row.companyName || row.companyId}
            </Link>
          ) : (
            <span className={styles.companyLink}>{row.companyName || row.companyId}</span>
          )
        )}
      </div>

      <div className={styles.historyBody}>
        <span className={styles.metaLine}>
          Requested {formatDateFullInZone(row.requestedAt, ZONE)}
        </span>
        <IdentityLine label="by" value={row.requestedByName} email={row.requestedByEmail ?? undefined} />

        {row.state === 'requested' && remaining && (
          <span className={remaining.expired ? styles.metaLine : styles.remaining}>
            Scheduled for {formatDateFullInZone(row.scheduledFor, ZONE)} — {remaining.label}
          </span>
        )}

        {row.canceledAt && (
          <>
            <span className={styles.metaLine}>Canceled {formatDateFullInZone(row.canceledAt, ZONE)}</span>
            <IdentityLine label="by" value={row.canceledByName} email={row.canceledByEmail ?? undefined} />
            {row.cancelSource && (
              <span className={styles.metaLine}>
                via {row.cancelSource === 'cancel_link' ? 'emailed cancel link' : 'admin UI'}
              </span>
            )}
          </>
        )}

        {row.completedAt && (
          <span className={styles.metaLine}>Completed {formatDateFullInZone(row.completedAt, ZONE)}</span>
        )}

        {(row.state === 'failed' || row.state === 'executing') && (
          <div className={styles.progressBlock}>
            <span className={styles.metaLine}>{phaseProgressLabel(row.phase)}</span>
            <span className={styles.metaLine}>
              {row.attempts} of {MAX_PURGE_ATTEMPTS} attempts
            </span>
            {row.completedPhases && row.completedPhases.length > 0 && (
              <span className={styles.metaLine}>
                Finished: {row.completedPhases.map((p) => PHASE_LABELS[p as keyof typeof PHASE_LABELS] ?? p).join(', ')}
              </span>
            )}
            {row.lastHeartbeatAt && (
              <span className={styles.metaLine}>Last heartbeat {formatDateFullInZone(row.lastHeartbeatAt, ZONE)}</span>
            )}
            {row.lastError === null && (
              <span className={styles.metaLine}><em className={styles.redacted}>Error detail redacted (24-month retention)</em></span>
            )}
            {typeof row.lastError === 'string' && row.lastError && (
              <span className={styles.errorText}>{row.lastError}</span>
            )}
          </div>
        )}

        <StripeOutcomeLine label="Stripe pause" outcome={row.stripePause} />
        <StripeOutcomeLine label="Stripe resume" outcome={row.stripeResume} />

        {row.operatorActions && row.operatorActions.length > 0 && (
          <div className={styles.operatorActions}>
            <span className={styles.sectionLabelSmall}>OPERATOR ACTIONS</span>
            {row.operatorActions.map((a, i) => (
              <div key={i} className={styles.operatorActionRow}>
                <span className={styles.metaLine}>{a.action} — {formatDateFullInZone(a.at, ZONE)}</span>
                <IdentityLine label="by" value={a.byName} />
                {a.note && <span className={styles.metaLine}>{a.note}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function DeletionHistoryList({
  rows,
  showCompanyName,
  linkToCompany,
  emptyHeading,
  emptyBody,
}: {
  rows: CompanyDeletionRow[]
  showCompanyName?: boolean
  linkToCompany?: boolean
  emptyHeading: string
  emptyBody?: string
}) {
  if (rows.length === 0) {
    return <EmptyState variant="inline" heading={emptyHeading} body={emptyBody} />
  }
  return (
    <div className={styles.historyList}>
      {rows.map((row) => (
        <DeletionRow key={row.requestId} row={row} showCompanyName={showCompanyName} linkToCompany={linkToCompany} />
      ))}
    </div>
  )
}
