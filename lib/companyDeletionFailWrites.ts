import 'server-only'

import type { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { formatDateFull, toIso } from '@/lib/companyDeletionCancelWrites'
import type { CompanyDeletionFailureReason, CompanyDeletionRecord } from '@/types'

/**
 * Mirrors functions/src/company/failDeletion.ts's `applyFailedTransition` —
 * see that file's own (much longer) docblock for the full rationale. This is
 * the THIRD caller its docblock already names: App Hosting cannot import
 * `functions/src` (a different runtime entirely — see the pattern this file
 * follows, lib/companyDeletionCancelWrites.ts's `applyCancelWrites`), so the
 * operator's "mark as failed" action (`markStuckCompanyDeletionFailed`,
 * actions/operatorCompanyDeletion.ts) needs its own copy of the exact same
 * writes. `__tests__/company/failWritesParity.test.ts` runs both builders
 * over the same inputs and asserts identical writes, which is the only thing
 * standing between this file and silent drift.
 *
 * Writes, all inside the caller's transaction, IN THE SAME ORDER as the
 * functions-side original:
 *
 *   1. The ledger: `state: 'failed'`, `failureReason`, `failedAt: now`, and
 *      `lastHeartbeatAt: now`.
 *   2. The member-visible mirror, `companies/{companyId}.deletion.state`,
 *      only when `companySnap` exists AND its `deletion.requestId` still
 *      matches this ledger's `requestId` — same double guard, same reason
 *      (the company doc can be gone entirely, or a newer request can have
 *      overwritten the mirror since).
 *   3. `companyDeletionFailed` mail to admins, falling back to
 *      `ledger.requestedByEmail` in `mode: 'window'` when no admin remains,
 *      gated on `!ledger.failedNotifiedAt` so a retried transaction can
 *      never send it twice.
 *
 * Does NOT touch `attempts`/`lastError`/`operatorActions` — those are each
 * caller's own responsibility, exactly as on the functions side. The ONE
 * caller today is `markStuckCompanyDeletionFailed`, which appends its own
 * `operatorActions` entry in the SAME transaction, in its own `tx.update`
 * call, the same way purge.ts's catch block writes `attempts`/`lastError`
 * alongside this function's own writes.
 *
 * `db`/`logger` are the two things this file CANNOT copy verbatim from the
 * functions-side original: there is no `Firestore` instance to thread
 * through (this file reaches `adminDb` directly, matching
 * `applyCancelWrites`'s own convention above), and there is no
 * `firebase-functions` logger — `console.error` stands in, with the exact
 * same `action: 'company_deletion_marked_failed'` tag so the log-based alert
 * the plan calls for fires regardless of which side wrote the failure. Never
 * logs an email address, same rule as the functions-side original.
 */
export interface ApplyFailedTransitionNextArgs {
  ledgerRef: FirebaseFirestore.DocumentReference
  ledger: CompanyDeletionRecord
  /** Pre-read `companies/{companyId}` snapshot, or `null` if the caller has nothing to offer. */
  companySnap: FirebaseFirestore.DocumentSnapshot | null
  /** Pre-read `companies/{companyId}/members` query, filtered to `role == 'admin'`, or `null`. */
  adminsSnap: FirebaseFirestore.QuerySnapshot | null
  reason: CompanyDeletionFailureReason
  now: Timestamp
}

export function applyFailedTransitionNext(
  tx: FirebaseFirestore.Transaction,
  { ledgerRef, ledger, companySnap, adminsSnap, reason, now }: ApplyFailedTransitionNextArgs,
): void {
  tx.update(ledgerRef, {
    state: 'failed',
    failureReason: reason,
    failedAt: now,
    lastHeartbeatAt: now,
  })

  if (companySnap && companySnap.exists) {
    const deletion = companySnap.data()?.deletion as { requestId?: string } | undefined
    if (deletion?.requestId === ledger.requestId) {
      tx.update(companySnap.ref, { 'deletion.state': 'failed' })
    }
  }

  if (!ledger.failedNotifiedAt) {
    // Each recipient tagged with WHICH kind she is — see the
    // functions-side original's identical comment for why: the footer
    // sentence has to be true for her specifically, and the admin footer is
    // false for the requestedByEmail fallback below.
    const recipients: { email: string; recipientRole: 'admin' | 'requester' }[] = []
    if (adminsSnap) {
      for (const adminDoc of adminsSnap.docs) {
        const email = adminDoc.data().email as string | undefined
        if (email) recipients.push({ email, recipientRole: 'admin' })
      }
    }
    // No admin left with an email — fall back to the requester, 'window'
    // mode only. Same reasoning as the functions-side original: an
    // 'immediate' request's sole admin had her account deleted as part of
    // the same purge that just failed, so her address is not a live inbox.
    if (recipients.length === 0 && ledger.mode === 'window' && ledger.requestedByEmail) {
      recipients.push({ email: ledger.requestedByEmail, recipientRole: 'requester' })
    }

    if (recipients.length > 0) {
      const requestedAtFormatted = formatDateFull(toIso(ledger.requestedAt))
      const failedAtFormatted = formatDateFull(now.toDate().toISOString())
      const openUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.allocate.at'}/`
      // Same computation as the functions-side original — see its comment.
      const billingStopped = (ledger.completedPhases ?? []).includes('stripe')

      for (const { email, recipientRole } of recipients) {
        const mailRef = adminDb.collection('mail').doc()
        tx.set(mailRef, {
          to: email,
          status: 'queued',
          template: 'companyDeletionFailed',
          companyId: ledger.companyId,
          data: {
            companyName: ledger.companyName,
            requestedAtFormatted,
            failedAtFormatted,
            openUrl,
            recipientRole,
            billingStopped,
          },
        })
      }

      tx.update(ledgerRef, {
        failedNotifiedAt: now,
        failedNotifiedCount: recipients.length,
      })
    }
  }

  console.error('[lib/companyDeletionFailWrites]', {
    action: 'company_deletion_marked_failed',
    reason,
    requestId: ledger.requestId,
    companyId: ledger.companyId,
  })
}
