'use server'

import { revalidatePath } from 'next/cache'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase-admin'
import { getOperatorSession, rethrowRedirect, type OperatorSession } from '@/lib/operator-dal'
import { applyCancelWrites, finishCancellation } from '@/lib/companyDeletionCancelWrites'
import { applyFailedTransitionNext } from '@/lib/companyDeletionFailWrites'
import { pauseSubscriptionForDeletion, recordStripeOutcome } from '@/lib/companyDeletionStripe'
import { confirmationMatchesCompanyName } from '@/lib/companyDeletionUi'
import { STALE_LEASE_MS } from '@/lib/operatorDeletionView'
import type { CompanyDeletionOperatorAction, CompanyDeletionRecord } from '@/types'

/**
 * Server actions for the operator view's FOUR destructive/corrective moves
 * on a company deletion (issue #252 step 6, PR 5; issue #331/#335 added the
 * fourth):
 *
 *   1. `cancelCompanyDeletionAsOperator` — stop a pending deletion when there
 *      is no administrator left to do it from the product.
 *   2. `requestCompanyDeletionAsOperator` — start a deletion on the
 *      customer's behalf, when they can't do it themselves.
 *   3. `requeueFailedCompanyDeletion` — resume a purge that exhausted its
 *      retry budget, WITHOUT restarting it from phase one.
 *   4. `markStuckCompanyDeletionFailed` — issue #335's whole reason for
 *      being: a purge that times out on EVERY invocation is SIGKILLed
 *      before `runCompanyPurge`'s catch block ever runs, so `attempts`
 *      never grows and the row can sit in `executing` forever with no path
 *      to `requeueFailedCompanyDeletion` above (which requires `state ===
 *      'failed'`). This gives an operator a way to declare such a row
 *      `failed` by hand — the SAME transition `applyFailedTransition`
 *      (functions/src/company/failDeletion.ts) and `claimStaleLease`'s own
 *      no-progress detection (lease.ts) already make automatically, just
 *      triggered by a human instead of a threshold — after which
 *      `requeueFailedCompanyDeletion` applies normally.
 *
 * A FIFTH move the design brief also lists — "Slutföra en kontoradering som
 * den automatiska kontrollen inte kunde avgöra" — is an ACCOUNT deletion
 * action (deleteAccount's "could not determine" outcome), not a COMPANY
 * deletion action, and is out of this PR's scope; it is not implemented
 * here.
 *
 * ── Security, shared by all three ──────────────────────────────────────────
 * Every function below calls `getOperatorSession()` itself, first thing,
 * inside its own try/catch with `rethrowRedirect` — never assumes the page
 * that rendered a button already checked. A server action in this codebase
 * is a public endpoint to anyone holding a session cookie; `proxy.ts` never
 * sees it (see the docblock on `confirmationMatches` in
 * actions/companyDeletion.ts, and `getOperatorSession`'s own callers). None of
 * these three touch, weaken, or add an alternative to the operator
 * allowlist/claim/revocation check `getOperatorSession` already performs.
 *
 * ── Traceability, shared by all three ──────────────────────────────────────
 * Every one of these appends a `CompanyDeletionOperatorAction` entry to the
 * ledger's `operatorActions` array — this file is the writer named in that
 * type's own docblock (types/company.ts:199-216), and PR 4's read view
 * already renders the result (see `DeletionHistoryList.tsx`). `byUid` and
 * `byName` are ALWAYS set explicitly, to a real string — never omitted —
 * because `lib/operatorDeletionQueries.ts`
 * (PR 4) collapses an OMITTED field to `null`, i.e. "redacted by the 24-month
 * retention job". Omitting them here would make a brand-new operator action
 * misrepresent itself as a two-year-old redacted one the moment it's read.
 * `byName` is the operator's EMAIL (the only identity `getOperatorSession()`
 * carries — there is a single operator today, and no separate display name
 * anywhere in this codebase), which satisfies the design brief's "läsbart —
 * namn eller e-post, inte bara ett internt id": an email survives the
 * customer side's account being deleted, an internal id would not mean
 * anything to anyone reading this trail later.
 *
 * ── The two things that must never happen, and why nothing here can do them ─
 * "Ett raderat företag får inte kunna återskapas": none of these three act on
 * a `completed` ledger row, and #2 refuses outright once `companies/{id}` no
 * longer exists — there is nothing left here to resurrect.
 * "Ett ångerfönster som löpt ut får inte kunna förlängas i efterhand": none of
 * these three ever write `scheduledFor`. #2 only computes one when it is
 * creating a BRAND NEW ledger row (no existing `deletion` on the company);
 * an already-requested company returns the EXISTING `scheduledFor` unchanged,
 * exactly like `requestCompanyDeletion`'s own double-click guard.
 */

/** Mirrors `WINDOW_MS` in actions/companyDeletion.ts. Duplicated, not
 *  imported — a `'use server'` module may only export async functions, so
 *  no plain constant can cross that boundary; same reason this file can't
 *  import `applyCancelWrites` FROM there either (it now lives in
 *  lib/companyDeletionCancelWrites.ts precisely so both files can share it). */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Mirrors `IDENTITY_RETENTION_MS` in actions/companyDeletion.ts. Duplicated
 *  for the same reason as `WINDOW_MS` above. */
const IDENTITY_RETENTION_MS = 730 * 24 * 60 * 60 * 1000

type GuardCode =
  | 'not-found'
  | 'forbidden'
  | 'confirmation'
  | 'in-progress'
  | 'not-failed'
  | 'not-executing'
  | 'not-stuck'
  | 'contacts-redacted'
type GuardError = Error & { code: GuardCode }

function guardError(code: GuardCode, message: string): GuardError {
  return Object.assign(new Error(message), { code })
}

/**
 * Every `companyId`/`requestId` this file receives comes straight from a
 * server action's arguments — client-controlled input, arriving with none of
 * `proxy.ts`'s validation (server actions are their own endpoint; see this
 * file's own "Security, shared by all three" docblock above). Every caller
 * below builds a Firestore document path directly from one of these
 * (`companies/${companyId}`, `companyDeletions/${requestId}`), so a value
 * containing a `/` could otherwise address an ARBITRARY document path
 * instead of the single company/ledger segment this action is supposed to
 * be confined to — e.g. `../mail/{id}` style traversal, or simply a
 * multi-segment path that resolves somewhere this operator surface was
 * never meant to reach. Real ids in this codebase (Firestore auto-ids,
 * `requestId`s minted by `adminDb.collection(...).doc().id`) are always a
 * single alphanumeric-ish segment, so this is a real restriction, not a
 * theoretical one loosened for convenience. Refused the same way a
 * genuinely missing document is — `not-found` — so this never tells a
 * caller anything about WHY the guard tripped.
 */
const VALID_DOC_ID = /^[A-Za-z0-9_-]{1,128}$/

function assertValidDocId(id: string, notFoundMessage: string): void {
  if (!VALID_DOC_ID.test(id)) {
    throw guardError('not-found', notFoundMessage)
  }
}

function toIso(value: unknown): string {
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString()
  }
  return typeof value === 'string' ? value : ''
}

/** Operator free text about a customer — capped so a pasted essay (or something worse) can't sit on the ledger's `operatorActions` array forever. Same 500-character bar as every other free-text field an operator can attach in this codebase's admin surfaces. */
const MAX_NOTE_LENGTH = 500

function trimmedNote(note: string): string | undefined {
  const trimmed = note.trim().slice(0, MAX_NOTE_LENGTH)
  return trimmed.length > 0 ? trimmed : undefined
}

// ── 1. Cancel ────────────────────────────────────────────────────────────────

export interface OperatorCancelResult {
  ok?: true
  nothingToCancel?: boolean
  error?: string
}

/**
 * Cancels a pending company deletion from the operator view. This is
 * `cancelCompanyDeletion`'s (actions/companyDeletion.ts) role in the world —
 * "the important action, and the harmless one: it restores a company to its
 * normal state" — for the ONE case that action cannot serve: there is no
 * administrator left to click it, or none is willing to.
 *
 * Deliberately NOT a call to `cancelCompanyDeletion()` itself: that function
 * requires the caller to hold a live `companies/{cid}/members/{uid}` document
 * with `role === 'admin'`. An operator is never a member of the company they
 * are helping, so reusing it here would make the operator view unable to
 * cancel EXACTLY the companies it exists to rescue — the whole reason step 6
 * needs its own write path (design brief: "Måste fungera även när det inte
 * finns en enda administratör kvar i företaget").
 *
 * ── Why this only accepts `state === 'requested'`, same bar as the customer
 * path, not wider ─────────────────────────────────────────────────────────
 * "Avbryta" is described in the design brief as the SAFE action, precisely
 * because a `requested` deletion has not run a single purge phase — nothing
 * has been touched yet, so undoing it is just deleting the mirror and
 * marking the ledger row `canceled`. The moment a purge has actually STARTED
 * (`executing`) or exhausted its retries (`failed`), that safety is gone:
 * `runCompanyPurge` (functions/src/company/purge.ts) can have already
 * cancelled the Stripe subscription outright, revoked members' Auth claims,
 * or deleted entire subcollections — see its phase list (stripe →
 * invitations → members → subtree → orphans → finalize). Writing "canceled"
 * on a ledger row in that state would be a LIE with real consequences behind
 * it: the company would look "safe" while parts of its data are already
 * gone. That is exactly the "osant påstående" failure class this PR is
 * warned against. A stuck or failed purge is fixed by MARKING it failed
 * (`markStuckCompanyDeletionFailed`, if it hasn't already reached `failed`
 * on its own) and then RESUMING it correctly (`requeueFailedCompanyDeletion`
 * below) — never by pretending it never started.
 */
export async function cancelCompanyDeletionAsOperator(
  companyId: string,
  note: string,
): Promise<OperatorCancelResult> {
  let session: OperatorSession
  try {
    session = await getOperatorSession()
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Not authorized.' }
  }

  const now = Timestamp.now()
  let cancelled: { requestId: string; ledger: CompanyDeletionRecord } | null = null

  try {
    assertValidDocId(companyId, 'That company no longer exists.')

    await adminDb.runTransaction(async (tx) => {
      // Reset on every attempt — a transaction retry must not resurrect a
      // result from an aborted attempt. See the long note on this same
      // pattern in actions/companyDeletion.ts's `cancelCompanyDeletionByToken`.
      cancelled = null

      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)
      if (!companySnap.exists) throw guardError('not-found', 'That company no longer exists.')

      const deletion = companySnap.data()?.deletion as
        | { requestId?: string; state?: string }
        | undefined
      if (!deletion?.requestId) return // nothing to cancel

      if (deletion.state !== 'requested') {
        throw guardError(
          'in-progress',
          "This deletion has already started and can't be cancelled. If it's stuck, mark it as failed and then requeue it.",
        )
      }

      const ledgerRef = adminDb.doc(`companyDeletions/${deletion.requestId}`)
      const ledgerSnap = await tx.get(ledgerRef)
      if (!ledgerSnap.exists) {
        // Mirror points at a ledger that isn't there — clear the orphan
        // mirror rather than leave a banner up for nothing. Same recovery
        // `cancelCompanyDeletion` performs for the identical case.
        tx.update(companyRef, { deletion: FieldValue.delete() })
        return
      }

      const ledger = ledgerSnap.data() as CompanyDeletionRecord
      const operatorAction: CompanyDeletionOperatorAction = {
        action: 'cancel',
        byUid: session.uid,
        byName: session.email,
        at: now.toDate().toISOString(),
        ...(trimmedNote(note) ? { note: trimmedNote(note) } : {}),
      }
      const operatorActions = [...(ledger.operatorActions ?? []), operatorAction]

      applyCancelWrites(
        tx,
        companyId,
        deletion.requestId,
        now,
        'operator',
        { uid: session.uid, name: session.email, email: session.email },
        operatorActions,
      )

      cancelled = { requestId: deletion.requestId, ledger }
    })
  } catch (err) {
    const code = (err as { code?: GuardCode }).code
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/operatorCompanyDeletion]', {
      operator: session.email,
      companyId,
      error: message,
      action: 'operator_cancel_company_deletion_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not cancel the deletion. Nothing was changed — please try again.' }
  }

  if (!cancelled) {
    revalidatePath(`/operator/customers/${companyId}`)
    return { ok: true, nothingToCancel: true }
  }

  const done: { requestId: string; ledger: CompanyDeletionRecord } = cancelled
  console.log('[actions/operatorCompanyDeletion]', {
    operator: session.email,
    companyId,
    requestId: done.requestId,
    action: 'operator_cancelled_company_deletion',
  })

  // Same post-cancel effects every cancel path performs — Stripe resume AND
  // mailing every remaining admin that the deletion was stopped. Sharing
  // `finishCancellation` (not just the Stripe half) is the fix for this
  // action being the one cancel path out of three that used to never queue
  // that mail: the design brief's central case is zero admins left (nothing
  // to mail), but an operator can just as well cancel for a company that
  // STILL has administrators, and they deserve the same "it's stopped" mail
  // any other cancellation gives them.
  await finishCancellation(companyId, done.requestId, done.ledger, session.email, now.toDate().toISOString())

  revalidatePath(`/operator/customers/${companyId}`)
  revalidatePath('/operator/deletions')
  return { ok: true }
}

// ── 2. Request (on the customer's behalf) ───────────────────────────────────

export interface OperatorRequestResult {
  scheduledFor?: string
  alreadyRequested?: boolean
  error?: string
}

/**
 * Starts the seven-day deletion window for a company, on the customer's
 * behalf — for when the customer asked for their company to be deleted but
 * cannot do it themselves (design brief: "Radera ett företag ... när kunden
 * inte kan göra det själv").
 *
 * ── Why `mode: 'window'`, always ────────────────────────────────────────────
 * This is a REPLACEMENT for the customer's own `requestCompanyDeletion`
 * action, not a new kind of deletion — so it gets exactly that action's
 * tempo: the same seven-day window, unconditionally. `mode: 'immediate'` is
 * reserved for exactly one caller in this codebase, `deleteAccount`'s
 * sole-member-in-own-company branch (see the docblock on
 * `CompanyDeletionMode` in types/company.ts) — this is not that caller, and
 * must never derive `mode` from anything (member count included). There is
 * deliberately no member-count read anywhere in this function.
 *
 * ── Why this is NOT a call to `requestCompanyDeletion()` ────────────────────
 * That action reads the caller's role LIVE from
 * `companies/{cid}/members/{uid}` and requires `admin`. An operator has no
 * such document — reusing it here would always throw `forbidden`.
 *
 * ── Confirmation ─────────────────────────────────────────────────────────
 * Requires the company's name typed exactly, same ritual and same helper
 * (`confirmationMatchesCompanyName`) as the customer's own path. This is a
 * DELIBERATE choice to match the customer-side bar rather than lower it:
 * deleting is the one irreversible-adjacent act in this PR (the window can
 * still be cancelled, but nothing stops the clock from ticking once it
 * starts), and the design brief asks for "en medveten handling" in
 * proportion to acting on someone else's data. A bare confirm click would be
 * the same ritual `cancelCompanyDeletionAsOperator` above correctly does NOT
 * require (that one is the safe direction) applied to the unsafe one.
 */
export async function requestCompanyDeletionAsOperator(
  companyId: string,
  confirmationText: string,
  note: string,
): Promise<OperatorRequestResult> {
  let session: OperatorSession
  try {
    session = await getOperatorSession()
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Not authorized.' }
  }

  const requestId = adminDb.collection('companyDeletions').doc().id
  const now = Timestamp.now()
  const scheduledFor = Timestamp.fromMillis(now.toMillis() + WINDOW_MS)
  const purgeAfter = Timestamp.fromMillis(now.toMillis() + IDENTITY_RETENTION_MS)

  let created = false
  let resultScheduledFor = ''

  try {
    assertValidDocId(companyId, 'That company no longer exists.')

    await adminDb.runTransaction(async (tx) => {
      // Reset on every attempt — see the identical note in
      // actions/companyDeletion.ts's `requestCompanyDeletion`.
      created = false
      resultScheduledFor = ''

      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)
      if (!companySnap.exists) throw guardError('not-found', 'That company no longer exists.')

      const companyData = companySnap.data() ?? {}
      const companyName = (companyData.name as string | undefined) ?? ''

      if (!confirmationMatchesCompanyName(confirmationText, companyName)) {
        throw guardError('confirmation', `To delete this company, type its name exactly: ${companyName}`)
      }

      const existing = companyData.deletion as { scheduledFor?: unknown } | undefined
      if (existing) {
        // An existing request — active or not-yet-cleaned-up — is a
        // success, not an error: two clicks (or a retried action) must not
        // produce a second ledger row. `scheduledFor` is read back
        // UNCHANGED, never recomputed — this is the guard that keeps an
        // already-running window from being silently extended.
        resultScheduledFor = toIso(existing.scheduledFor)
        return
      }

      const operatorAction: CompanyDeletionOperatorAction = {
        action: 'request',
        byUid: session.uid,
        byName: session.email,
        at: now.toDate().toISOString(),
        ...(trimmedNote(note) ? { note: trimmedNote(note) } : {}),
      }

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
        // The requester is the OPERATOR — they are the one who actually
        // called this action. This is not a fabrication of "the customer
        // asked for this": it is the honest record of who made the write,
        // exactly the same way `cancel_link`'s cancelSource records "a
        // bearer token", not a guessed name. The `operatorActions` entry
        // above carries the "on whose behalf, and why" — the note/ticket
        // reference — which is the part this field cannot honestly say.
        requestedByUid: session.uid,
        requestedByName: session.email,
        requestedByEmail: session.email,
        scheduledFor,
        attempts: 0,
        purgeAfter,
        operatorActions: [operatorAction],
      }

      tx.set(adminDb.doc(`companyDeletions/${requestId}`), ledger)
      tx.update(companyRef, {
        deletion: {
          state: 'requested',
          requestId,
          requestedAt: now,
          requestedByName: session.email,
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
    console.error('[actions/operatorCompanyDeletion]', {
      operator: session.email,
      companyId,
      error: message,
      action: 'operator_request_company_deletion_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not schedule the deletion. Nothing was changed — please try again.' }
  }

  if (!created) {
    revalidatePath(`/operator/customers/${companyId}`)
    return { scheduledFor: resultScheduledFor, alreadyRequested: true }
  }

  console.log('[actions/operatorCompanyDeletion]', {
    operator: session.email,
    companyId,
    requestId,
    action: 'operator_requested_company_deletion',
  })

  // Same best-effort Stripe pause every request path performs — see
  // lib/companyDeletionStripe.ts's docblock on why it never throws.
  const stripeOutcome = await pauseSubscriptionForDeletion(companyId)
  await recordStripeOutcome(requestId, 'stripePause', stripeOutcome)

  revalidatePath(`/operator/customers/${companyId}`)
  revalidatePath('/operator/deletions')
  return { scheduledFor: resultScheduledFor }
}

// ── 3. Requeue a failed purge ────────────────────────────────────────────────

export interface RequeueResult {
  ok?: true
  error?: string
}

/**
 * Resumes a purge whose ledger row is `failed` — `runCompanyPurge`
 * (functions/src/company/purge.ts) marks a row `failed` once `attempts`
 * reaches `MAX_ATTEMPTS` (5), and its own docblock is explicit that once that
 * happens "NOTHING retries it. `failed` is terminal, and waits for a human."
 * This action is that human's move.
 *
 * ── What is reset, and why exactly this and nothing more ───────────────────
 * `completedPhases`, `phase` and `phaseCounts` are NOT touched — that is the
 * entire point of "utan att behöva börja om från början" (design brief).
 * `runCompanyPurge` skips any phase already in `completedPhases` on its next
 * run, so leaving that array alone is what makes a requeue a RESUME, not a
 * restart. Re-running an already-finished phase would, at minimum, redo work
 * for nothing (`subtree`, `orphans`) and at worst re-queue duplicate
 * `companyDeleted` mail (`finalize` — guarded separately by
 * `finalizeMailQueuedUids`, but there is no reason to lean on that guard when
 * simply not resetting `completedPhases` avoids the situation entirely).
 *
 * Exactly two fields are reset, because exactly two fields are what stands
 * between a `failed` row and the sweep's `resumeStuck` pass
 * (functions/src/company/sweep.ts) picking it up on its next tick:
 *
 * 1. `state: 'executing'` — `resumeStuck` only queries `state == 'executing'`.
 *    A `failed` row is invisible to it, by design (see `claimStaleLease` in
 *    functions/src/company/lease.ts — it explicitly refuses anything that
 *    isn't already `executing`).
 * 2. `attempts: 0` — `resumeStuck` doesn't check `attempts`, but
 *    `runCompanyPurge`'s own catch block does: if left at 5 and the very
 *    next phase attempt throws for any reason, `attempts` becomes 6 and the
 *    row is marked `failed` again after a single try, defeating the entire
 *    point of requeuing it. A fresh budget is what "kör om" should mean.
 *
 * `lastHeartbeatAt` is ALSO written here — not because resuming needs a
 * fresh one, but because `resumeStuck`'s query additionally requires
 * `lastHeartbeatAt <= now - STALE_LEASE_MS` (60 minutes). A row that failed
 * moments ago has a heartbeat from moments ago, which would leave it sitting
 * `executing`-but-invisible to the sweep for up to an hour after an operator
 * asks for it to be requeued. Backdating it comfortably past that bar (see
 * `REQUEUE_HEARTBEAT_BACKDATE_MS` below) makes the very next sweep tick (at
 * most 30 minutes away) pick it up, regardless of how recently it failed.
 * Nothing about the PURGE ITSELF reads this backdated value as meaningful
 * progress — heartbeats exist purely to detect staleness, and
 * `runCompanyPurge` overwrites it for real the moment it resumes.
 *
 * `companies/{cid}.deletion` (the mirror) — REWRITTEN by issue #331: that
 * issue's whole point was that the mirror CAN now disagree with the ledger,
 * because `applyFailedTransition` (functions/src/company/failDeletion.ts)
 * and this file's own `markStuckCompanyDeletionFailed` both flip the mirror
 * to `'failed'` too, not just the ledger. So a requeue must flip it back —
 * this function now does, but ONLY when `companies/{companyId}` still exists
 * AND its `deletion.requestId` still matches this ledger's `requestId`
 * (same double guard `applyFailedTransitionNext` uses for the opposite
 * direction, and for the same reason: the company can be gone entirely, or a
 * newer request can have overwritten the mirror since this row failed).
 *
 * The no-progress baselines (issue #335) are ALSO reset here —
 * `noProgressResumes`, `leaseProgressUnits`, `leaseAttempts` — for the same
 * reason `attempts` is: a stale baseline from the failed run must not carry
 * forward and immediately look like "still no progress" to the very next
 * `claimStaleLease` check, three strikes from re-failing a purge that just
 * resumed. `failureReason` and `failedAt` are cleared with
 * `FieldValue.delete()` — a resumed row isn't failed any more, so neither
 * field describes anything currently true — but `failedNotifiedAt` is
 * DELIBERATELY KEPT: if this exact row fails again later, the mail should
 * not go out a second time for what a support ticket already covered once;
 * `applyFailedTransition`'s own `!ledger.failedNotifiedAt` gate is what makes
 * that idempotent, and clearing it here would defeat it.
 *
 * ── The redaction guard (issue #331/#335, see purgeLogs.ts's own note) ──────
 * Refuses outright when `ledger.contactsRedactedAt` is set: the 90-day
 * contacts-retention rule (functions/src/company/purgeLogs.ts's
 * `CONTACTS_FAILED_RULE`) has already blanked `formerMemberContacts` — the
 * `members` phase's OWN resume marker (see that field's docblock in
 * types/company.ts). Resuming into a members phase with no resume marker
 * left would re-run `cleanupOneMember` for every member of the company all
 * over again, re-deriving `formerMemberContacts` from members who may no
 * longer even be there (subtree may already be gone too, depending on how
 * far the purge got) — silent, wrong, and exactly the corruption that rule's
 * own docblock warns a requeue could cause. There is no code path back from
 * this: the operator has to finish the deletion by hand.
 */

/** Comfortably past `functions/src/company/sweep.ts`'s 60-minute
 *  `STALE_LEASE_MS` bar, so the very next sweep tick — not the one after —
 *  picks this row up regardless of how recently the purge actually failed.
 *  Does NOT feed `purgeLogs.ts`'s `CONTACTS_FAILED_RULE` a false 90-day
 *  clock: that rule only matches `state == 'failed'`, and THIS same write
 *  flips `state` to `'executing'` — so a backdated-but-now-executing row is
 *  simply invisible to that rule, not prematurely eligible for it. */
const REQUEUE_HEARTBEAT_BACKDATE_MS = STALE_LEASE_MS + 10 * 60 * 1000 // 70 minutes

export async function requeueFailedCompanyDeletion(
  requestId: string,
  note: string,
): Promise<RequeueResult> {
  let session: OperatorSession
  try {
    session = await getOperatorSession()
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Not authorized.' }
  }

  const now = Timestamp.now()
  let companyId = ''

  try {
    assertValidDocId(requestId, 'That deletion could not be found.')

    await adminDb.runTransaction(async (tx) => {
      companyId = ''

      const ledgerRef = adminDb.doc(`companyDeletions/${requestId}`)
      const ledgerSnap = await tx.get(ledgerRef)
      if (!ledgerSnap.exists) throw guardError('not-found', 'That deletion could not be found.')

      const ledger = ledgerSnap.data() as CompanyDeletionRecord
      if (ledger.state !== 'failed') {
        throw guardError('not-failed', 'Only a failed deletion can be requeued.')
      }
      if (ledger.contactsRedactedAt) {
        throw guardError(
          'contacts-redacted',
          'This deletion cannot be requeued — the member contacts it would need to resume from have already been redacted (90-day retention). Finish this one by hand.',
        )
      }

      companyId = ledger.companyId

      // Read before write, same Firestore transaction rule every other
      // company-deletion transaction in this file follows — the mirror flip
      // below needs this even though the vast majority of requeues will
      // find it a match.
      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)

      const operatorAction: CompanyDeletionOperatorAction = {
        action: 'requeue',
        byUid: session.uid,
        byName: session.email,
        at: now.toDate().toISOString(),
        ...(trimmedNote(note) ? { note: trimmedNote(note) } : {}),
      }
      const operatorActions = [...(ledger.operatorActions ?? []), operatorAction]

      // Exactly what's reset, and why — see this function's docblock above.
      // completedPhases / phase / phaseCounts are DELIBERATELY absent here.
      tx.update(ledgerRef, {
        state: 'executing',
        attempts: 0,
        lastHeartbeatAt: Timestamp.fromMillis(now.toMillis() - REQUEUE_HEARTBEAT_BACKDATE_MS),
        operatorActions,
        noProgressResumes: 0,
        leaseAttempts: 0,
        leaseProgressUnits: ledger.progressUnits ?? 0,
        failureReason: FieldValue.delete(),
        failedAt: FieldValue.delete(),
        // failedNotifiedAt is DELIBERATELY kept — see this function's docblock.
      })

      if (companySnap.exists) {
        const deletion = companySnap.data()?.deletion as { requestId?: string } | undefined
        if (deletion?.requestId === requestId) {
          tx.update(companyRef, { 'deletion.state': 'executing' })
        }
      }
    })
  } catch (err) {
    const code = (err as { code?: GuardCode }).code
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/operatorCompanyDeletion]', {
      operator: session.email,
      requestId,
      error: message,
      action: 'operator_requeue_company_deletion_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not requeue the deletion. Nothing was changed — please try again.' }
  }

  console.log('[actions/operatorCompanyDeletion]', {
    operator: session.email,
    companyId,
    requestId,
    action: 'operator_requeued_company_deletion',
  })

  if (companyId) revalidatePath(`/operator/customers/${companyId}`)
  revalidatePath('/operator/deletions')
  return { ok: true }
}

// ── 4. Mark a stuck purge as failed ─────────────────────────────────────────

export interface MarkFailedResult {
  ok?: true
  error?: string
}

/**
 * Issue #335's operator move: a purge that times out on EVERY invocation is
 * SIGKILLed before `runCompanyPurge`'s catch block ever runs, so `attempts`
 * never grows and the row can sit `executing` forever — invisible to
 * `requeueFailedCompanyDeletion` above, which requires `state === 'failed'`.
 * `claimStaleLease`'s own no-progress detection (functions/src/company/lease.ts)
 * eventually catches this automatically after `NO_PROGRESS_LIMIT` (3)
 * consecutive stale-lease resumes with zero measured progress, but that is a
 * bound of HOURS (three sweep-driven stale claims, each requiring the prior
 * heartbeat to already be `STALE_LEASE_MS` old), not immediate — this action
 * lets an operator who has already confirmed a row is stuck skip the wait.
 *
 * ── Guards, in order ─────────────────────────────────────────────────────────
 * 1. `state === 'executing'` — mirrors `applyFailedTransition`'s own
 *    precondition. A `requested` row hasn't started (nothing to "mark
 *    failed" — cancel it instead); a `failed` row already is; a `completed`
 *    or `canceled` row is history. `not-executing` names all four.
 * 2. Heartbeat older than `STALE_LEASE_MS` (the SAME bar
 *    `isStuckDeletion`/`claimStaleLease` use) — this is what stops an
 *    operator from declaring a purge that is genuinely, visibly still
 *    working (a huge `bookings` subtree, say — mid-flight, heartbeating
 *    normally) failed out from under it. `not-stuck` names this, and its
 *    message states how long ago the last heartbeat actually was, so the
 *    operator can judge whether to wait a little longer instead of guessing.
 *
 * ── What this writes ─────────────────────────────────────────────────────────
 * The SAME transition every other path to `failed` uses —
 * `applyFailedTransitionNext` (lib/companyDeletionFailWrites.ts, the Next-side
 * twin of `applyFailedTransition` in functions/src/company/failDeletion.ts) —
 * with `reason: 'operator'`, so the ledger, the mirror and the
 * `companyDeletionFailed` mail to admins are all written IDENTICALLY to how
 * an automatic detection would have written them. `attempts` is deliberately
 * NOT touched: this is not a failed purge ATTEMPT, it's an operator
 * declaring an already-stuck row done trying — see `applyFailedTransition`'s
 * own docblock for why `attempts`/`lastError` are each caller's own
 * responsibility, never this function's.
 *
 * Also appends a `mark_failed` `operatorActions` entry, same
 * `byUid`/`byName`-always-set convention as every other writer in this file.
 */
export async function markStuckCompanyDeletionFailed(requestId: string, note: string): Promise<MarkFailedResult> {
  let session: OperatorSession
  try {
    session = await getOperatorSession()
  } catch (err) {
    rethrowRedirect(err)
    return { error: 'Not authorized.' }
  }

  const now = Timestamp.now()
  let companyId = ''

  try {
    assertValidDocId(requestId, 'That deletion could not be found.')

    await adminDb.runTransaction(async (tx) => {
      companyId = ''

      const ledgerRef = adminDb.doc(`companyDeletions/${requestId}`)
      const ledgerSnap = await tx.get(ledgerRef)
      if (!ledgerSnap.exists) throw guardError('not-found', 'That deletion could not be found.')

      const ledger = ledgerSnap.data() as CompanyDeletionRecord
      if (ledger.state !== 'executing') {
        throw guardError('not-executing', 'Only a deletion that is currently executing can be marked as failed.')
      }

      const heartbeat = ledger.lastHeartbeatAt
      const heartbeatMs = heartbeat ? toIso(heartbeat) : ''
      const heartbeatDate = heartbeatMs ? new Date(heartbeatMs) : null
      const heartbeatAgeMs = heartbeatDate && !Number.isNaN(heartbeatDate.getTime()) ? now.toMillis() - heartbeatDate.getTime() : null

      if (heartbeatAgeMs === null || heartbeatAgeMs < STALE_LEASE_MS) {
        const agoText =
          heartbeatAgeMs === null
            ? 'has no heartbeat recorded yet'
            : `was ${Math.round(heartbeatAgeMs / 60000)} minute(s) ago`
        throw guardError(
          'not-stuck',
          `This deletion still looks active — its last heartbeat ${agoText}. Only a purge whose heartbeat has gone stale for over an hour can be marked failed.`,
        )
      }

      companyId = ledger.companyId

      // Reads before writes: everything applyFailedTransitionNext needs.
      const companyRef = adminDb.doc(`companies/${companyId}`)
      const companySnap = await tx.get(companyRef)
      const adminsSnap = await tx.get(
        adminDb.collection(`companies/${companyId}/members`).where('role', '==', 'admin'),
      )

      const operatorAction: CompanyDeletionOperatorAction = {
        action: 'mark_failed',
        byUid: session.uid,
        byName: session.email,
        at: now.toDate().toISOString(),
        ...(trimmedNote(note) ? { note: trimmedNote(note) } : {}),
      }
      const operatorActions = [...(ledger.operatorActions ?? []), operatorAction]

      // attempts is DELIBERATELY untouched — see this function's docblock.
      tx.update(ledgerRef, { operatorActions })

      applyFailedTransitionNext(tx, {
        ledgerRef,
        ledger,
        companySnap,
        adminsSnap,
        reason: 'operator',
        now,
      })
    })
  } catch (err) {
    const code = (err as { code?: GuardCode }).code
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/operatorCompanyDeletion]', {
      operator: session.email,
      requestId,
      error: message,
      action: 'operator_mark_company_deletion_failed_failed',
    })
    if (code) return { error: message }
    return { error: 'Could not mark the deletion as failed. Nothing was changed — please try again.' }
  }

  console.log('[actions/operatorCompanyDeletion]', {
    operator: session.email,
    companyId,
    requestId,
    action: 'operator_marked_company_deletion_failed',
  })

  if (companyId) revalidatePath(`/operator/customers/${companyId}`)
  revalidatePath('/operator/deletions')
  return { ok: true }
}
