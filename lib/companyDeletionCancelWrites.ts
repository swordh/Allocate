import 'server-only'

import { FieldValue, type Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { recordStripeOutcome, resumeSubscriptionAfterCancel } from '@/lib/companyDeletionStripe'
import type { CompanyDeletionCancelSource, CompanyDeletionOperatorAction, CompanyDeletionRecord } from '@/types'

/** e.g. "12 September 2026" — matches functions/src/company/format.ts's `formatDateFull`,
 *  duplicated because functions/ compiles as its own project with no alias back here. */
export function formatDateFull(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Firestore `Timestamp` (or an already-ISO string, or neither) -> ISO string. */
export function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  return typeof value === 'string' ? value : ''
}

/**
 * The writes that turn a `requested` deletion into a cancelled one.
 *
 * Extracted out of `actions/companyDeletion.ts` (which cannot export it
 * directly — a `'use server'` module may only export async functions, and
 * this is synchronous) so `actions/operatorCompanyDeletion.ts` (issue #252
 * step 6, PR 5) can share the EXACT same writes for its own cancel path,
 * rather than re-deriving them and risking drift on the one thing that must
 * never drift: what "cancelled" means on the ledger and the mirror.
 *
 * `FieldValue.delete()` on `deletion`, rather than a `state: 'canceled'`
 * value on it, is the data model's own rule: absence of the field is the ONLY
 * "nothing is going on" signal, so every reader — the sweep's query, the
 * banner, `docToCompany` — gets the right answer without learning a new
 * state. See the docblock on `CompanyDeletionState` in types/company.ts.
 *
 * `operatorActions`, when passed, REPLACES the array on the ledger wholesale
 * — callers pass the full array (existing entries plus their new one), not a
 * delta, matching the read-modify-write convention already used for
 * `formerMemberContacts` in functions/src/company/purge.ts's members phase.
 * Only the operator cancel path passes this; the two customer-facing callers
 * (`cancelCompanyDeletion`, `cancelCompanyDeletionByToken`) never do, so their
 * writes are byte-for-byte what they always were.
 */
export function applyCancelWrites(
  tx: FirebaseFirestore.Transaction,
  companyId: string,
  requestId: string,
  now: Timestamp,
  source: CompanyDeletionCancelSource,
  identity: { uid?: string; name: string; email?: string },
  operatorActions?: CompanyDeletionOperatorAction[],
): void {
  tx.update(adminDb.doc(`companies/${companyId}`), { deletion: FieldValue.delete() })
  tx.update(adminDb.doc(`companyDeletions/${requestId}`), {
    state: 'canceled',
    canceledAt: now,
    canceledByName: identity.name,
    ...(identity.uid ? { canceledByUid: identity.uid } : {}),
    ...(identity.email ? { canceledByEmail: identity.email } : {}),
    cancelSource: source,
    ...(operatorActions ? { operatorActions } : {}),
  })
}

/**
 * Everything that has to happen AFTER a cancellation has been COMMITTED —
 * resuming Stripe collection and mailing every admin that the deletion was
 * stopped. Shared by all THREE cancel paths (`cancelCompanyDeletion`,
 * `cancelCompanyDeletionByToken` in actions/companyDeletion.ts, and
 * `cancelCompanyDeletionAsOperator` in actions/operatorCompanyDeletion.ts, PR
 * 5) so none of them can drift on what "cancelled" means for the customer —
 * an operator-initiated cancel that skipped this step would be the one path
 * out of three that never tells a company's administrators their deletion
 * was stopped, even though they were told it was requested.
 *
 * Deliberately NOT exported as a server action itself (this file has no
 * `'use server'` directive, unlike actions/companyDeletion.ts, which is
 * exactly why this function lives here and not there): every parameter
 * here — `companyId`, `requestId`, the whole `ledger`, an arbitrary
 * `cancelledByName` — is taken on trust. A `'use server'` export is a public,
 * unauthenticated RPC endpoint to anyone holding a session cookie (see the
 * docblock on `confirmationMatches` in actions/companyDeletion.ts); exporting
 * this directly would let any signed-in caller queue a fake
 * "your deletion was cancelled by <anyone>" mail to any company's admins and
 * poke `resumeSubscriptionAfterCancel` at any Stripe subscription by id, with
 * none of the guards every real caller's own transaction enforces first.
 * Every caller must do its own auth/state checks BEFORE calling this.
 *
 * Both effects are best-effort and neither can un-cancel the deletion: by
 * the time this runs, the company document no longer carries a `deletion`
 * field and the ledger says `canceled`. Failing here must never turn a
 * successful cancellation into an error the caller sees, because the one
 * thing worse than a missing confirmation email is an admin who believes
 * her cancellation did not take and goes looking for another way to stop a
 * deletion that is already stopped.
 */
export async function finishCancellation(
  companyId: string,
  requestId: string,
  ledger: CompanyDeletionRecord,
  cancelledByName: string,
  cancelledAtIso: string,
): Promise<void> {
  const stripeOutcome = await resumeSubscriptionAfterCancel(companyId)
  await recordStripeOutcome(requestId, 'stripeResume', stripeOutcome)

  // "Deletion stopped" goes to every ADMIN, mirroring who was told it was
  // requested. Crew are never mailed about the deletion lifecycle — the
  // in-product banner vanishing is their signal (design brief, "Mail går
  // bara till administratörer"). This is unconditional on WHICH of the three
  // cancel paths called it, operator included: a company that still has
  // administrators is told a cancellation happened regardless of who
  // performed it.
  try {
    const adminsSnap = await adminDb
      .collection(`companies/${companyId}/members`)
      .where('role', '==', 'admin')
      .get()

    const openUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.allocate.at'}/bookings`
    const scheduledForFormatted = formatDateFull(toIso(ledger.scheduledFor))
    const cancelledAtFormatted = formatDateFull(cancelledAtIso)

    const batch = adminDb.batch()
    let queued = 0
    for (const adminDoc of adminsSnap.docs) {
      const email = adminDoc.data().email as string | undefined
      if (!email) continue
      batch.set(adminDb.collection('mail').doc(), {
        to: email,
        status: 'queued',
        template: 'companyDeletionCancelled',
        companyId,
        data: {
          companyName: ledger.companyName ?? '',
          cancelledByName,
          cancelledAtFormatted,
          scheduledForFormatted,
          openUrl,
        },
      })
      queued++
    }
    if (queued > 0) await batch.commit()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lib/companyDeletionCancelWrites]', {
      companyId,
      requestId,
      error: message,
      action: 'cancel_notification_mail_failed',
    })
  }
}
