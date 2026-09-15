'use server'

import { revalidatePath } from 'next/cache'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { pauseSubscriptionForDeletion, recordStripeOutcome } from '@/lib/companyDeletionStripe'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import { applyCancelWrites, finishCancellation, toIso } from '@/lib/companyDeletionCancelWrites'
import type { CancelTokenState } from '@/lib/queries/companyDeletionCancel'
import type { CompanyDeletionCancelToken, CompanyDeletionRecord } from '@/types'

/**
 * Server actions for deleting a COMPANY (issue #252 step 5, PR F2). Deleting
 * an ACCOUNT lives in actions/account.ts and is a different action with a
 * different tempo — see the design brief's "Två separata handlingar". The two
 * meet in exactly one place: `deleteAccount`'s sole-member branch, which is
 * the only caller in this codebase allowed to create a `mode: 'immediate'`
 * request.
 *
 * Everything here writes `mode: 'window'`, always, unconditionally. See
 * `requestCompanyDeletion` below.
 */

/** Seven days, per the design brief. Not configurable, and not derived from anything. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 24 months — when the ledger row's *identity* fields become eligible for
 * redaction (PR G's `purgeCompanyDeletionLogsSweep`), not when the row is
 * deleted. The row itself is kept; see the GDPR note on
 * `CompanyDeletionRecord` in types/company.ts.
 */
const IDENTITY_RETENTION_MS = 730 * 24 * 60 * 60 * 1000

type GuardCode = 'not-found' | 'forbidden' | 'confirmation' | 'in-progress'
type GuardError = Error & { code: GuardCode }

function guardError(code: GuardCode, message: string): GuardError {
  return Object.assign(new Error(message), { code })
}

// ── Request ───────────────────────────────────────────────────────────────────

export interface RequestCompanyDeletionResult {
  /** ISO string — when the company will actually be deleted. */
  scheduledFor?: string
  /** True when a request already existed and this call changed nothing. */
  alreadyRequested?: boolean
  error?: string
}

/**
 * Starts the seven-day deletion window for the caller's active company.
 *
 * Three things about this function are load-bearing:
 *
 * 1. **The role is read live, inside the transaction**, from
 *    `companies/{cid}/members/{uid}` — never from `session.role`. Custom
 *    Claims are baked into a session cookie when it is minted and do not
 *    change when somebody is demoted; `actions/account.ts`'s commit loop
 *    already works this way for the same reason. A demoted admin holding an
 *    hour-old cookie must not be able to schedule a company's destruction.
 *
 * 2. **`mode` is always `'window'`.** Not "window unless there's one member",
 *    not "window if the counter says so" — always. An admin who asks for her
 *    one-person company to be deleted is still around to change her mind, so
 *    she gets the same seven days as anyone else. This is a CHANGED decision
 *    (an earlier draft of the plan derived `mode` from the member count); see
 *    "Fattade beslut" in plan/det-k-nns-som-att-stateless-conway.md and the
 *    doc comment on `CompanyDeletionMode` in types/company.ts. Deriving
 *    `mode` from a member count here would re-introduce the exact failure the
 *    decision removes: a counter that drifts low would delete a working
 *    company instantly, with no window for anyone to notice. There is
 *    deliberately no member count read anywhere in this function — not even
 *    an unused one.
 *
 * 3. **An existing request is a success, not an error.** Two clicks on a
 *    confirm button, or a retried request, must not produce two ledger rows
 *    or a scary error message. The transaction is what makes that race-free:
 *    both attempts read the same company document, but only one commits.
 *
 * The Stripe pause happens after the commit, not inside it — a Firestore
 * transaction callback can be retried, and retrying an external side effect
 * is not something a transaction can offer. A failed pause is recorded on the
 * ledger and does not fail the request; see lib/companyDeletionStripe.ts.
 */
export async function requestCompanyDeletion(
  confirmationText: string,
): Promise<RequestCompanyDeletionResult> {
  const session = await getVerifiedSession()
  const companyId = session.activeCompanyId
  const uid = session.uid

  // Generated before the transaction so a transaction retry reuses the same
  // id and the same instant rather than minting a new one per attempt.
  const requestId = adminDb.collection('companyDeletions').doc().id
  const now = Timestamp.now()
  const scheduledFor = Timestamp.fromMillis(now.toMillis() + WINDOW_MS)
  const purgeAfter = Timestamp.fromMillis(now.toMillis() + IDENTITY_RETENTION_MS)

  let created = false
  let resultScheduledFor = ''

  try {
    await adminDb.runTransaction(async (tx) => {
      // Reset on EVERY attempt. Firestore retries a transaction callback when
      // it loses a write conflict, and anything the aborted attempt assigned
      // to a variable out here survives that abort even though its writes do
      // not. See the long note on the same reset in
      // `cancelCompanyDeletionByToken` below — an emulator test caught this
      // for real there, and leaving it out here would let a retry that
      // short-circuits on an already-existing request still pause Stripe as
      // if it had just created one.
      created = false
      resultScheduledFor = ''

      const companyRef = adminDb.doc(`companies/${companyId}`)
      const memberRef = adminDb.doc(`companies/${companyId}/members/${uid}`)

      const [companySnap, memberSnap] = await Promise.all([tx.get(companyRef), tx.get(memberRef)])

      if (!companySnap.exists) {
        throw guardError('not-found', 'That company no longer exists.')
      }

      // Live role — see point 1 in this function's docblock.
      const role = memberSnap.exists ? (memberSnap.data()?.role as string | undefined) : undefined
      if (role !== 'admin') {
        throw guardError('forbidden', 'Only administrators can delete a company.')
      }

      const companyData = companySnap.data() ?? {}
      const companyName = (companyData.name as string | undefined) ?? ''

      // Checked BEFORE the already-requested short-circuit below, not after.
      // The short-circuit exists for double-clicks, which resend the same
      // (correct) text anyway — so nothing legitimate is lost by demanding it
      // every time, and a caller who never typed the name never gets a
      // success out of this action.
      if (!confirmationMatchesCompanyName(confirmationText, companyName)) {
        throw guardError(
          'confirmation',
          `To delete this company, type its name exactly: ${companyName}`,
        )
      }

      const existing = companyData.deletion as { scheduledFor?: unknown } | undefined
      if (existing) {
        resultScheduledFor = toIso(existing.scheduledFor)
        return
      }

      const requestedByName =
        (memberSnap.data()?.name as string | undefined) || session.email || 'An administrator'
      const requestedByEmail = (memberSnap.data()?.email as string | undefined) || session.email || ''

      const ledger: Omit<CompanyDeletionRecord, 'requestedAt' | 'scheduledFor' | 'purgeAfter'> & {
        requestedAt: Timestamp
        scheduledFor: Timestamp
        purgeAfter: Timestamp
      } = {
        requestId,
        companyId,
        companyName,
        mode: 'window',
        state: 'requested',
        requestedAt: now,
        requestedByUid: uid,
        requestedByName,
        requestedByEmail,
        scheduledFor,
        attempts: 0,
        purgeAfter,
      }

      tx.set(adminDb.doc(`companyDeletions/${requestId}`), ledger)
      tx.update(companyRef, {
        deletion: {
          state: 'requested',
          requestId,
          requestedAt: now,
          requestedByName,
          scheduledFor,
          mode: 'window',
        },
      })

      created = true
      resultScheduledFor = scheduledFor.toDate().toISOString()
    })
  } catch (err) {
    const code = (err as { code?: GuardCode }).code
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/companyDeletion]', {
      uid: uid.slice(0, 8) + '...',
      companyId,
      error: message,
      action: 'request_company_deletion_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not schedule the deletion. Nothing was changed — please try again.' }
  }

  if (!created) {
    console.log('[actions/companyDeletion]', { companyId, action: 'request_company_deletion_already_requested' })
    return { scheduledFor: resultScheduledFor, alreadyRequested: true }
  }

  console.log('[actions/companyDeletion]', {
    uid: uid.slice(0, 8) + '...',
    companyId,
    action: 'company_deletion_requested',
  })

  // The mail and the cancel token are NOT sent from here — that is
  // `onCompanyDeletionCreated`'s job (functions/src/company/onDeletionCreated.ts),
  // triggered by the ledger document this transaction just wrote. Doing it
  // there makes the send idempotent and restartable, and keeps a slow HTTP
  // response from being the reason an admin never got her cancel link. Do not
  // "helpfully" queue mail here too.
  const stripeOutcome = await pauseSubscriptionForDeletion(companyId)
  await recordStripeOutcome(requestId, 'stripePause', stripeOutcome)

  revalidatePath('/settings/subscription')
  revalidatePath('/settings/company')

  return { scheduledFor: resultScheduledFor }
}

// ── Cancel ────────────────────────────────────────────────────────────────────
//
// `finishCancellation` — everything that has to happen after a cancellation
// has been COMMITTED (resuming Stripe, mailing admins) — now lives in
// lib/companyDeletionCancelWrites.ts, alongside `applyCancelWrites`. It moved
// there so `actions/operatorCompanyDeletion.ts` (issue #252 step 6, PR 5)
// could share the exact same post-cancel effects for its own cancel path,
// rather than the operator cancel being the one path out of three that never
// tells a company's administrators their deletion was stopped. See that
// function's docblock for why it deliberately is NOT exported as a server
// action itself.

export interface CancelCompanyDeletionResult {
  ok?: true
  /** True when there was nothing to cancel — treated as success, see below. */
  nothingToCancel?: boolean
  error?: string
}

/**
 * Cancels the pending deletion of the caller's active company, from inside
 * the product. Any administrator may cancel, not just the one who requested
 * it (design brief: "Vilken administratör som helst kan avbryta").
 *
 * Like `requestCompanyDeletion`, the role is read live inside the
 * transaction. Unlike it, the failure modes lean permissive: cancelling is
 * the safe direction. "There was no deletion to cancel" is reported as
 * success, because the caller's intent — that this company not be deleted —
 * is satisfied.
 *
 * `executing` and `failed` are the one refusal: the purge has started and
 * this action cannot put a company back together. Saying "cancelled" there
 * would be a lie with a week's worth of consequences behind it.
 */
export async function cancelCompanyDeletion(): Promise<CancelCompanyDeletionResult> {
  const session = await getVerifiedSession()
  const companyId = session.activeCompanyId
  const uid = session.uid
  const now = Timestamp.now()

  let cancelled: { requestId: string; ledger: CompanyDeletionRecord; name: string } | null = null

  try {
    await adminDb.runTransaction(async (tx) => {
      // Reset on every attempt — see `cancelCompanyDeletionByToken` below.
      cancelled = null

      const companyRef = adminDb.doc(`companies/${companyId}`)
      const memberRef = adminDb.doc(`companies/${companyId}/members/${uid}`)
      const [companySnap, memberSnap] = await Promise.all([tx.get(companyRef), tx.get(memberRef)])

      if (!companySnap.exists) throw guardError('not-found', 'That company no longer exists.')

      const role = memberSnap.exists ? (memberSnap.data()?.role as string | undefined) : undefined
      if (role !== 'admin') {
        throw guardError('forbidden', 'Only administrators can stop a company deletion.')
      }

      const deletion = companySnap.data()?.deletion as
        | { requestId?: string; state?: string }
        | undefined
      if (!deletion?.requestId) return

      if (deletion.state !== 'requested') {
        throw guardError(
          'in-progress',
          'This deletion has already started and can no longer be stopped here. Contact support.',
        )
      }

      const ledgerRef = adminDb.doc(`companyDeletions/${deletion.requestId}`)
      const ledgerSnap = await tx.get(ledgerRef)
      if (!ledgerSnap.exists) {
        // A mirror pointing at a ledger that isn't there. Clear the mirror —
        // leaving it would keep a banner up and keep the sweep interested in
        // a request it can never act on (`claimRequestedLease` returns null
        // for a missing ledger, forever).
        tx.update(companyRef, { deletion: FieldValue.delete() })
        console.error('[actions/companyDeletion]', {
          companyId,
          requestId: deletion.requestId,
          action: 'cancel_orphan_deletion_mirror_cleared',
        })
        return
      }

      const ledger = ledgerSnap.data() as CompanyDeletionRecord
      const name = (memberSnap.data()?.name as string | undefined) || session.email || 'An administrator'

      applyCancelWrites(tx, companyId, deletion.requestId, now, 'admin_ui', {
        uid,
        name,
        email: (memberSnap.data()?.email as string | undefined) || session.email,
      })

      cancelled = { requestId: deletion.requestId, ledger, name }
    })
  } catch (err) {
    const code = (err as { code?: GuardCode }).code
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/companyDeletion]', {
      uid: uid.slice(0, 8) + '...',
      companyId,
      error: message,
      action: 'cancel_company_deletion_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not stop the deletion. Nothing was changed — please try again.' }
  }

  if (!cancelled) {
    revalidatePath('/settings/subscription')
    return { ok: true, nothingToCancel: true }
  }

  const done: { requestId: string; ledger: CompanyDeletionRecord; name: string } = cancelled
  console.log('[actions/companyDeletion]', {
    uid: uid.slice(0, 8) + '...',
    companyId,
    action: 'company_deletion_canceled',
    source: 'admin_ui',
  })

  await finishCancellation(companyId, done.requestId, done.ledger, done.name, now.toDate().toISOString())

  revalidatePath('/settings/subscription')
  revalidatePath('/settings/company')
  return { ok: true }
}

export interface CancelByTokenResult {
  state: CancelTokenState
  companyName?: string
}

/**
 * Cancels a deletion from the link mailed to administrators.
 *
 * NOT reachable by a GET. This is a server action, invoked from a form the
 * cancel page renders — the page itself only reads. Mail scanners, link
 * prefetchers and "safe links" rewriters fetch URLs out of emails
 * automatically, and a deletion stopped by a robot is exactly as wrong as one
 * executed by a robot. The design brief permits a cancel link to exist at all
 * precisely because it cannot execute anything; that argument only holds if
 * the link also doesn't silently *do* the cancelling on load.
 *
 * No session is required and none is checked. The token IS the
 * authorisation: it was mailed only to administrators, it lives in a
 * top-level collection no client can read (firestore.rules denies it by
 * default — see the comment block there), it is one-time, and it expires with
 * the window it belongs to. That is also why the sole-admin-of-a-one-person-
 * company case works at all: there may be no session left to require.
 *
 * Every check `lookupCancelToken` makes for rendering is repeated here inside
 * a transaction, because that one is a read and this one is the guard. In
 * particular, spending the token (`usedAt`) and cancelling the deletion
 * commit together or not at all — two people clicking the same link at the
 * same second cannot produce two cancellations, and a failed cancellation
 * cannot burn the token.
 */
export async function cancelCompanyDeletionByToken(token: string): Promise<CancelByTokenResult> {
  const now = Timestamp.now()

  if (typeof token !== 'string' || token.trim().length === 0) return { state: 'unknown' }

  let outcome: CancelByTokenResult = { state: 'unknown' }
  let cancelled: { companyId: string; requestId: string; ledger: CompanyDeletionRecord } | null = null

  try {
    await adminDb.runTransaction(async (tx) => {
      // ── Reset on EVERY attempt, not just the first ──────────────────────
      //
      // Firestore retries this callback when it loses a write conflict. The
      // aborted attempt's WRITES are discarded; its assignments to these two
      // variables are not, because they live outside the callback.
      //
      // This is not hypothetical. Two simultaneous clicks on the same link
      // used to produce exactly one cancellation (correct) and TWO
      // "deletion stopped" emails (wrong): the loser's first attempt set
      // `cancelled`, lost the commit, retried, correctly reported `used`
      // from the re-read — and then `finishCancellation` ran anyway, off the
      // stale value from the attempt that never happened. Caught by the
      // concurrent-click test in
      // __tests__/emulator/companyDeletionCancel.emulator.ts, which is the
      // only place a real transaction retry actually occurs; a stubbed
      // `runTransaction` that just invokes its callback once can never
      // reproduce it.
      outcome = { state: 'unknown' }
      cancelled = null

      const tokenRef = adminDb.doc(`companyDeletionCancelTokens/${token}`)
      const tokenSnap = await tx.get(tokenRef)
      if (!tokenSnap.exists) {
        outcome = { state: 'unknown' }
        return
      }

      const tokenDoc = tokenSnap.data() as CompanyDeletionCancelToken
      const ledgerRef = adminDb.doc(`companyDeletions/${tokenDoc.requestId}`)
      const ledgerSnap = await tx.get(ledgerRef)
      if (!ledgerSnap.exists) {
        outcome = { state: 'unknown' }
        return
      }

      const ledger = ledgerSnap.data() as CompanyDeletionRecord
      const companyName = ledger.companyName ?? ''

      // Same ordering as lookupCancelToken: the outcome the visitor cares
      // about ("is this company safe?") is decided before anything about the
      // link itself.
      if (ledger.state === 'canceled') {
        outcome = { state: 'already_canceled', companyName }
        return
      }
      if (ledger.state === 'completed') {
        outcome = { state: 'company_gone', companyName }
        return
      }
      if (tokenDoc.usedAt) {
        outcome = { state: 'used', companyName }
        return
      }

      const expiresAt = toIso(tokenDoc.expiresAt)
      if (expiresAt && Date.parse(expiresAt) < now.toMillis()) {
        outcome = { state: 'expired', companyName }
        return
      }
      if (ledger.state !== 'requested') {
        outcome = { state: 'too_late', companyName }
        return
      }

      const companyRef = adminDb.doc(`companies/${ledger.companyId}`)
      const companySnap = await tx.get(companyRef)
      if (!companySnap.exists) {
        outcome = { state: 'company_gone', companyName }
        return
      }

      const mirror = companySnap.data()?.deletion as { state?: string; requestId?: string } | undefined
      if (!mirror || mirror.requestId !== ledger.requestId || mirror.state !== 'requested') {
        // The ledger and the company disagree. Refuse rather than guess: the
        // company's own field is what the sweep and the purge act on, and
        // writing "cancelled" on the ledger while the company still points at
        // a live request would make the ledger lie.
        outcome = { state: 'too_late', companyName }
        return
      }

      tx.update(tokenRef, { usedAt: now })
      applyCancelWrites(tx, ledger.companyId, ledger.requestId, now, 'cancel_link', {
        // No uid/email: a bearer token carries no identity. Naming a person
        // here would be a fabrication in an audit trail, and the audit trail
        // is the whole reason this ledger survives the company. `cancelSource:
        // 'cancel_link'` is the honest record of who did it.
        name: 'An administrator (cancellation link)',
      })

      outcome = { state: 'valid', companyName }
      cancelled = { companyId: ledger.companyId, requestId: ledger.requestId, ledger }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/companyDeletion]', {
      error: message,
      action: 'cancel_company_deletion_by_token_failed',
    })
    throw new Error('Could not stop the deletion right now. Please try again.')
  }

  if (cancelled) {
    const done: { companyId: string; requestId: string; ledger: CompanyDeletionRecord } = cancelled
    console.log('[actions/companyDeletion]', {
      companyId: done.companyId,
      action: 'company_deletion_canceled',
      source: 'cancel_link',
    })
    await finishCancellation(
      done.companyId,
      done.requestId,
      done.ledger,
      'An administrator',
      now.toDate().toISOString(),
    )
  }

  return outcome
}
