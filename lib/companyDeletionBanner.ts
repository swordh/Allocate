import { formatDateFullInZone } from '@/lib/dates'
import { canCancelCompanyDeletionInProduct } from '@/lib/companyDeletionUi'
import type { CompanyDeletion, CompanyDeletionState, Role } from '@/types'
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
 * happy-path `requested` case.
 *
 * Reuses `canCancelCompanyDeletionInProduct` rather than re-deriving "is this
 * still `requested`" here, so this banner and `CompanySettingsForm` /
 * `SubscriptionView` can never disagree about whether the cancel path is
 * honest to offer. Only `state` is read from `deletion` by that function, so
 * a `{ state }`-only value stands in for the full `CompanyDeletion` shape
 * this banner never has.
 */
export function getCompanyDeletionBannerDisplay(
  deletion: CompanyDeletionBannerData | null,
  role: Role,
  timezone: string,
): CompanyDeletionBannerDisplay | null {
  if (!deletion) return null

  const isAdmin = role === 'admin'
  const date = formatDateFullInZone(deletion.scheduledFor, timezone)

  switch (deletion.state) {
    case 'requested': {
      const cancelable = isAdmin && canCancelCompanyDeletionInProduct({ state: deletion.state } as CompanyDeletion)
      return {
        tone: 'danger',
        message: isAdmin
          ? `This company is scheduled for deletion on ${date}. Every member will lose access when it happens — cancel it below if that's not intended.`
          : `This company is scheduled for deletion on ${date}. Every member, including you, will lose access when it happens. Only an administrator can cancel it.`,
        cancelHref: cancelable ? '/settings/company' : undefined,
      }
    }

    case 'executing':
      // The sweep has already claimed the purge — `canCancelCompanyDeletionInProduct`
      // is false here for every role, so no cancel path is offered to anyone,
      // admin included. Deliberately no date: the deletion is happening now,
      // not "scheduled" any more, and by the time a purge is claimed the
      // scheduled instant has already passed or is about to.
      return {
        tone: 'danger',
        message: 'This company is being deleted now. This can no longer be stopped, and access will end shortly.',
      }

    case 'failed':
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
