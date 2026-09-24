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
      // happening now, not "scheduled" any more, and deliberately no claim
      // about WHEN access ends either — the only thing this state can
      // honestly promise is that the deletion has started and cannot be
      // stopped from here, so that is all this message says.
      return {
        tone: 'danger',
        message: "This company's deletion has started and can no longer be stopped from here.",
      }

    case 'failed':
      // Issue #331 fixed `applyFailedTransition` to mirror `'failed'` onto
      // `companies/{cid}.deletion.state`, not just the `companyDeletions`
      // ledger — so this branch is now reachable from `app/(app)/layout.tsx`.
      // A failed purge has exhausted its retry budget (or been marked failed
      // by an operator — issue #335) and is terminal until an operator
      // intervenes; it will NOT resume on its own. The scheduled date is no
      // longer a true statement about what will happen, so it is
      // deliberately omitted here (see the design brief: "säg inte 'raderas
      // den 22:a' om raderingen har misslyckats"). Nothing in the product can
      // fix this, for any role — support is already aware (the
      // `companyDeletionFailed` mail went to admins the moment this
      // happened) and will follow up, so the message says that rather than
      // asking the reader to act.
      return {
        tone: 'danger',
        message: isAdmin
          ? "This company's deletion ran into a problem and hasn't finished. Our support team can see this and will follow up."
          : "This company's deletion ran into a problem and hasn't finished. Our support team is already aware.",
      }

    default:
      // Defensive only — CompanyDeletionState has exactly these three
      // values. If a fourth is ever added, fail closed to nothing rather
      // than crash the whole app shell over a banner.
      return null
  }
}
