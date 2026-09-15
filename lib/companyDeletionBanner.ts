import { formatDateFullInZone } from '@/lib/dates'
import { canCancelCompanyDeletionInProduct } from '@/lib/companyDeletionUi'
import type { CompanyDeletionState, Role } from '@/types'
import type { NoticeTone } from '@/components/ui/ErrorBanner'

/**
 * What `app/(app)/layout.tsx` hands down to `CompanyDeletionBanner` — only
 * the two fields the banner actually renders, not the whole `CompanyDeletion`
 * mirror. The layout reads the company document as raw Firestore data (see
 * its own comment on why it does not go through `docToCompany`), so this is
 * also the shape the layout normalizes Firestore `Timestamp`s into before
 * anything crosses to a component: `scheduledFor` here is always an ISO
 * string, never a `Timestamp`.
 */
export interface CompanyDeletionBannerData {
  state: CompanyDeletionState
  scheduledFor: string // ISO string
}

export interface CompanyDeletionBannerDisplay {
  tone: NoticeTone
  message: string
  /** Present only when the viewer is an admin AND the deletion can actually be cancelled from the product. */
  cancelHref?: string
}

/**
 * Issue #252 step 6, PR 3 — "Alla i företaget måste veta" in the design
 * brief. Unlike `SubscriptionView`'s notice (lib/subscription-state.ts),
 * which is admin-only and treats every `deletion` presence as one
 * `DELETION_PENDING` state, this banner is shown to EVERY member — including
 * crew and viewers, who are never mailed about a deletion request or a
 * cancellation — so it must say something true and actionable (or honestly
 * inactionable) for `requested`, `executing` AND `failed`, not just the
 * happy-path `requested` case. See the `'failed'` case below for a note on
 * why that branch is currently unreachable from the data this banner is
 * actually given, and why it is kept anyway.
 *
 * Reuses `canCancelCompanyDeletionInProduct` rather than re-deriving "is this
 * still `requested`" here, so this banner and `CompanySettingsForm` /
 * `SubscriptionView` can never disagree about whether the cancel path is
 * honest to offer. That function takes `Pick<CompanyDeletion, 'state'>`
 * precisely so a caller with only `CompanyDeletionBannerData` — never the
 * full `CompanyDeletion` mirror — can pass `deletion` straight through
 * without a cast.
 */
export function getCompanyDeletionBannerDisplay(
  deletion: CompanyDeletionBannerData | null,
  role: Role,
  timezone: string,
): CompanyDeletionBannerDisplay | null {
  if (!deletion) return null

  const isAdmin = role === 'admin'
  const date = formatDateFullInZone(deletion.scheduledFor, timezone)
  // formatDateFullInZone's own "cannot render this" sentinel. `scheduledFor`
  // should always be a real ISO string by the time it reaches here, but
  // app/(app)/layout.tsx can hand down '' if the company document ever has
  // `deletion.state` set without `deletion.scheduledFor` (should not happen,
  // nothing upstream guarantees it structurally). "scheduled for deletion on
  // —" would be a strange sentence, not a false one, but it is also not
  // useful — if we don't know when, the honest sentence has no date clause
  // at all rather than a placeholder standing in for one.
  const hasKnownDate = date !== '—'

  switch (deletion.state) {
    case 'requested': {
      const cancelable = isAdmin && canCancelCompanyDeletionInProduct(deletion)
      const dateClause = hasKnownDate ? ` on ${date}` : ''
      return {
        tone: 'danger',
        message: isAdmin
          ? `This company is scheduled for deletion${dateClause}. Every member will lose access when it happens — cancel it below if that's not intended.`
          : `This company is scheduled for deletion${dateClause}. Every member, including you, will lose access when it happens. Only an administrator can cancel it.`,
        cancelHref: cancelable ? '/settings/company' : undefined,
      }
    }

    case 'executing':
      // The sweep has claimed the purge — `canCancelCompanyDeletionInProduct`
      // is false here for every role, so no cancel path is offered to
      // anyone, admin included. Deliberately no date: the deletion is
      // happening now, not "scheduled" any more.
      //
      // Deliberately no claim about WHEN access ends, either. `executing` is
      // also the state a member sees if the purge has exhausted its retry
      // budget on the ledger (`companyDeletions/{requestId}.state ===
      // 'failed'`) without that ever reaching the company document's own
      // mirror — see the `'failed'` case below for why. In that situation
      // nothing is progressing and access will NOT end "shortly"; it won't
      // end at all until an operator intervenes. The only thing this state
      // can honestly promise, in both the normal and the stuck case, is that
      // the deletion has started and cannot be stopped from here — so that
      // is all this message says.
      return {
        tone: 'danger',
        message: "This company's deletion has started and can no longer be stopped from here.",
      }

    case 'failed':
      // NOTE ON REACHABILITY (current state of the code, not a permanent
      // warning — safe to delete this note without changing anything else
      // once it stops being true): `CompanyDeletionState` declares `'failed'`
      // and the `companyDeletions/{requestId}` ledger does use it —
      // `runCompanyPurge` sets it there once the retry budget is exhausted
      // (functions/src/company/purge.ts:552). But nothing writes `'failed'`
      // onto the COMPANY document's `deletion` mirror that this banner
      // actually reads: `claimRequestedLease`/`claimStaleLease`
      // (functions/src/company/lease.ts) only ever flip the mirror
      // `requested` -> `executing`, and the purge's failure path updates the
      // ledger alone. So today, this branch cannot be reached from
      // `app/(app)/layout.tsx` — a stuck purge is seen by this banner as
      // `executing` forever (see that case's comment). The branch is kept
      // rather than deleted because it becomes reachable, correctly, the day
      // the mirror gets fixed to carry `'failed'` too — removing it now
      // would just mean rebuilding the same thing then.
      //
      // A failed purge has exhausted its retry budget and is terminal until
      // an operator intervenes (see functions/src/company/purge.ts) — it will
      // NOT resume on its own. The scheduled date is no longer a true
      // statement about what will happen, so it is deliberately omitted here
      // (see the design brief: "säg inte 'raderas den 22:a' om raderingen har
      // misslyckats"). Nothing in the product can fix this, for any role, so
      // the message points at support rather than at a control that does
      // not exist.
      return {
        tone: 'danger',
        message: isAdmin
          ? "This company's deletion ran into a problem and is stuck. Contact support to resolve it."
          : "This company's deletion ran into a problem and is stuck. An administrator will need to contact support.",
      }

    default:
      // Defensive only — CompanyDeletionState has exactly these three
      // values. If a fourth is ever added, fail closed to nothing rather
      // than crash the whole app shell over a banner.
      return null
  }
}
