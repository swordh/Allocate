'use server'

import { createHash } from 'crypto'
import { revalidatePath } from 'next/cache'
import { FieldValue, Timestamp, WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession, verifyAuthenticatedSession } from '@/lib/dal'
import { normalizeEmail } from '@/lib/invite-recipients'
import { memberCountsDelta, readMemberCounts } from '@/lib/companyStats'
import {
  confirmSoleMember,
  getDeletionOutcomes,
  type CompanyDeletionOutcome,
} from '@/lib/queries/deletionOutcomes'
import { stripe } from '@/lib/stripe'
import { deleteSession } from './auth'

const BATCH_LIMIT = 490

/**
 * 24 months, for the `purgeAfter` field on a `companyDeletions` ledger row —
 * when its IDENTITY fields become eligible for redaction (PR G), not when the
 * row is deleted. Same value and same meaning as the constant of the same
 * name in actions/companyDeletion.ts; both are the plan's "revisionsloggen
 * bevarar läsbar identitet i 24 månader". Duplicated rather than shared
 * because a `'use server'` module can only export async functions, so neither
 * file can export it to the other.
 */
const IDENTITY_RETENTION_MS = 730 * 24 * 60 * 60 * 1000

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
}

// issue #349: the CONFIRM button can fire 2-3 near-simultaneous invocations
// of `deleteAccount` for the same uid (observed ~14ms apart in the network
// log). `deleteAccount` is partially destructive and only idempotent against
// a *sequential* retry, not a *concurrent* one, so two overlapping runs can
// race (e.g. one reads a membership another has already deleted). This lock
// is what actually closes that window — the client-side `disabled` state
// (AccountSettingsForm.tsx) helps but isn't atomic against a fast double
// click.
const LOCK_TTL_MS = 5 * 60 * 1000

const ACCOUNT_DELETION_IN_PROGRESS_ERROR =
  'Account deletion is already in progress. Please wait a moment and try again.'

/**
 * Acquires a per-uid lock via `accountDeletionLocks/{uid}`, using
 * `DocumentReference.create()` rather than a transaction: `create()` is
 * already atomic (it fails with ALREADY_EXISTS if the doc exists) without
 * adding an `adminDb.runTransaction` call, which would otherwise inflate the
 * transaction-count assertions `__tests__/account/deleteAccount.test.ts`
 * makes against the per-company commit loop below.
 *
 * `LOCK_TTL_MS` guards against a permanently stuck lock if a process dies
 * before reaching `releaseAccountDeletionLock`'s `finally` (e.g. a killed
 * instance mid-anonymisation) — a lock older than that is taken over.
 */
async function acquireAccountDeletionLock(uid: string): Promise<boolean> {
  const lockRef = adminDb.collection('accountDeletionLocks').doc(uid)
  try {
    await lockRef.create({ startedAt: FieldValue.serverTimestamp() })
    return true
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code !== 6) throw err // not ALREADY_EXISTS — an unexpected failure, not a held lock

    const snap = await lockRef.get()
    const startedAt = (snap.data()?.startedAt as Timestamp | undefined)?.toMillis()
    if (startedAt === undefined || Date.now() - startedAt > LOCK_TTL_MS) {
      await lockRef.set({ startedAt: FieldValue.serverTimestamp() })
      return true
    }

    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', action: 'delete_account_lock_held' })
    return false
  }
}

async function releaseAccountDeletionLock(uid: string): Promise<void> {
  try {
    await adminDb.collection('accountDeletionLocks').doc(uid).delete()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', error: message, action: 'delete_account_lock_release_failed' })
  }
}

/** Typed sentinel thrown inside `deleteAccount`'s per-company transaction,
 * mapped to a user-facing string in the catch block — same pattern as
 * `actions/equipment.ts`'s `createEquipment` and `actions/team.ts`'s
 * `updateMemberRole`/`removeMember`. */
type DeleteAccountGuardError = Error & { code: 'sole-admin' }

function guardError(code: DeleteAccountGuardError['code'], message: string): DeleteAccountGuardError {
  return Object.assign(new Error(message), { code })
}

// Distinct from the sole-admin message below: this is what the user sees
// when the guard itself couldn't be evaluated (a read failed, a transaction
// couldn't be completed) — "nothing was deleted" is the fact this message
// needs to convey, as opposed to "you were blocked on purpose." It is also
// what `deleteAccount` shows for a `getDeletionOutcomes` result of
// `'unknown'` — see that type's docblock for why `unknown` must never be
// confused with `blocked`: one hands the user something to do, the other
// means the system couldn't tell.
const COULD_NOT_VERIFY_ERROR =
  'Could not verify your company administrators right now. Nothing was deleted — please try again in a moment.'

/**
 * How many people, besides the caller, work at a `blocked` company — phrased
 * for `buildBlockedClause` below. A `blocked` outcome always has at least one
 * other member (that's what distinguishes it from `close`), so `otherCount`
 * is never expected to be 0 here; the 0 branch exists only as a defensive
 * fallback, not a case this function's callers should ever hit in practice.
 *
 * No "there" in any branch — the caller embeds this after "where ...", and
 * "where" already establishes the location. An earlier version returned
 * "no one else works"/"N other people work" and the caller ALSO appended
 * " there" after it, producing "where 3 other people work there" — two
 * location words doing the job of one. Read every branch below out loud
 * before touching it again.
 */
function otherPeoplePhrase(otherCount: number): string {
  if (otherCount <= 0) return 'no one else works'
  if (otherCount === 1) return '1 other person works'
  return `${otherCount} other people work`
}

/**
 * Sentence for the `blocked` companies in a `deleteAccount` rejection: the
 * caller is the sole admin, but other members exist, so promoting one of
 * them (Settings → Team) is a real, actionable way out. Returns a single
 * sentence group covering however many `blocked` companies were passed —
 * never just the first — so a user blocked in two companies at once isn't
 * sent to fix one, retry, and get blocked again by a company they were never
 * told about (issue #252 point 1: "a user in several companies at once"
 * needs a per-company account, not the worst single outcome).
 */
function buildBlockedClause(companies: CompanyDeletionOutcome[]): string {
  if (companies.length === 1) {
    const company = companies[0]!
    const otherCount = Math.max(company.memberCount - 1, 0)
    return `you are the only administrator of ${company.companyName}, where ${otherPeoplePhrase(otherCount)}. Make someone else an administrator under Settings → Team, then try again.`
  }

  const perCompany = companies
    .map((company) => `${company.companyName} (${otherPeoplePhrase(Math.max(company.memberCount - 1, 0))})`)
    .join('; ')
  return `you are the only administrator of ${companies.length} companies — ${perCompany}. Make someone else an administrator in each one under Settings → Team, then try again.`
}

/**
 * Builds the message for `deleteAccount`'s sole-admin block from one or more
 * `getDeletionOutcomes` results (lib/queries/deletionOutcomes.ts) whose
 * outcome is `blocked`.
 *
 * REMOVED HERE in issue #252 step 5 (PR F2): a `buildCloseClause` that told a
 * sole member to "open Help & feedback and we'll take care of it", because
 * removing a company together with its last member's account wasn't
 * implemented. It is implemented now — `deleteAccount`'s commit loop creates
 * a `mode: 'immediate'` company deletion for exactly that case — so `close`
 * is no longer a blocking outcome and no longer reaches this function. That
 * message was the last remnant of the dead end issue #252 exists to remove;
 * do not re-add a clause here for `close`.
 *
 * `blocked` is now the only outcome this builds for, and it keeps the
 * per-company reporting the designbrief requires: a user who is the sole
 * admin of two companies is told about both, not sent to fix one and then
 * blocked again by a company nobody mentioned.
 */
function buildSoleAdminMessage(blocking: CompanyDeletionOutcome[]): string {
  // `otherAdminCount` (lib/queries/deletionOutcomes.ts) is 0 for every
  // company reaching this function BY DEFINITION: `blocked` means the caller
  // is the sole admin (so `admins <= 1` — no OTHER admin exists), and
  // `close` means the caller is the sole member (so `admins <= 1` too, since
  // a company can't have more admins than members). Neither clause builder
  // below needs the value for its wording (the sentences describe total
  // headcount, not admin headcount), but the field is still part of what
  // `getDeletionOutcomes` returns, and a company that reaches here with a
  // NON-zero `otherAdminCount` would mean that definition broke somewhere
  // upstream — worth knowing about even though nothing here would act on it
  // differently. Logged, not thrown: this function only builds a string, and
  // a data anomaly here is not a reason to fail the whole rejection message.
  for (const company of blocking) {
    if (company.otherAdminCount !== 0) {
      console.error('[actions/account]', {
        companyId: company.companyId,
        outcome: company.outcome,
        otherAdminCount: company.otherAdminCount,
        action: 'sole_admin_message_unexpected_other_admin_count',
      })
    }
  }

  const blockedCompanies = blocking.filter((company) => company.outcome === 'blocked')
  if (blockedCompanies.length === 0) return COULD_NOT_VERIFY_ERROR

  return `Cannot delete account: ${buildBlockedClause(blockedCompanies)}`
}

/**
 * Structured, per-company result of `getAccountDeletionPreview` below.
 * Deliberately two-level: `status: 'error'` is the TOP-LEVEL failure (the
 * membership list itself couldn't be read — nothing to show at all), kept
 * distinct from a per-company `outcome: 'unknown'` inside `companies`, which
 * means every OTHER company's outcome is still trustworthy and only this one
 * company's read failed. Collapsing the two would force the UI to treat "we
 * know nothing" and "we know everything except this one company" the same
 * way, which is exactly the "blocked and unknown look identical" problem the
 * designbrief calls out for the existing `{ error: string }` shape.
 */
export type AccountDeletionPreview = { status: 'ready'; companies: CompanyDeletionOutcome[] } | { status: 'error' }

/**
 * Read-only, per-company preview of what `deleteAccount` would do — issue
 * #252 step 6 PR 2, designbrief "Del 1": "Förstå exakt vad som händer med
 * varje företag hen tillhör, innan raderingen påbörjas." A thin wrapper
 * around `getDeletionOutcomes` (lib/queries/deletionOutcomes.ts, already
 * read-only) that turns a thrown error into the same `'error'` shape
 * `deleteAccount`'s own pre-flight falls back to (COULD_NOT_VERIFY_ERROR).
 *
 * ADVISORY ONLY — never authoritative, and must never become authoritative.
 * `deleteAccount`'s commit loop re-reads live, per company, inside the
 * transaction that actually deletes the membership (`confirmSoleMember`
 * exists specifically because a counter can drift between two reads). This
 * function's result can be stale the instant it's returned — a colleague
 * could leave or a counter could heal in the time between rendering this
 * preview and the user pressing confirm. Do not add logic anywhere that
 * lets `deleteAccount` skip or shortcut its own guard because a preview
 * already looked safe; that guard is the actual protection, this is only
 * what the user reads beforehand.
 */
export async function getAccountDeletionPreview(): Promise<AccountDeletionPreview> {
  const session = await getVerifiedSession()

  try {
    const companies = await getDeletionOutcomes(session.uid)
    return { status: 'ready', companies }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'account_deletion_preview_failed' })
    return { status: 'error' }
  }
}

export async function updateUserProfile(data: {
  name?: string
  defaultBookingView?: 'list' | 'week' | 'month' | '4weeks'
}): Promise<{ error?: string }> {
  const session = await getVerifiedSession()

  try {
    await adminDb.collection('users').doc(session.uid).update(data)
    revalidatePath('/settings/account')
    console.log('[actions/account]', { uid: session.uid.slice(0, 8) + '...', action: 'profile_updated' })
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'update_profile_failed' })
    return { error: 'Failed to save profile' }
  }
}

/**
 * Deletes the caller's own account (GDPR Art. 17): erases/anonymises their
 * PII across every company they belong to, then deletes their Firebase Auth
 * record.
 *
 * A thin wrapper around `runAccountDeletion` (see that function's docblock
 * for the three phases) that holds the issue #349 per-uid lock
 * (`acquireAccountDeletionLock`/`releaseAccountDeletionLock` above) for the
 * duration of the run, so at most one deletion can be in flight per uid at a
 * time.
 */
export async function deleteAccount(): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  const uid = session.uid

  // issue #349: acquire the per-uid lock before any of the work below — see
  // acquireAccountDeletionLock's docblock. A failure to even acquire it
  // (anything other than the lock being held) is treated like every other
  // unexpected read failure in this file: log it, tell the caller nothing
  // was deleted, never let it throw out of a Server Action.
  let lockAcquired: boolean
  try {
    lockAcquired = await acquireAccountDeletionLock(uid)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', error: message, action: 'delete_account_lock_acquire_failed' })
    return { error: COULD_NOT_VERIFY_ERROR }
  }
  if (!lockAcquired) {
    return { error: ACCOUNT_DELETION_IN_PROGRESS_ERROR }
  }

  // Released in `finally` so it always comes off, on every return path of
  // `runAccountDeletion` below, including success — unlike `users/{uid}`,
  // `accountDeletionLocks/{uid}` is a separate doc that the anonymisation
  // batch never touches.
  try {
    return await runAccountDeletion(session, uid)
  } finally {
    await releaseAccountDeletionLock(uid)
  }
}

/**
 * Three phases:
 *   1. Pre-flight sole-admin guard — read-only, best-effort, exists only to
 *      fail fast with a clear message; never authoritative on its own.
 *   2. Commit loop — one `runTransaction` per company, sequential: the
 *      authoritative guard, the company-side member doc delete, and the
 *      memberCounts delta (lib/companyStats.ts) all happen together. Skips a
 *      company outright if it no longer exists (a stale membership pointer),
 *      and is idempotent against a retry whose member doc is already gone.
 *      For a company whose sole member this is, the same transaction ALSO
 *      writes a `mode: 'immediate'` deletion request — see that branch.
 *   3. Anonymisation — a chunked WriteBatch over bookings/equipment/units/
 *      invitations/Stripe, followed by session + Auth-record deletion. Only
 *      reached if every company in phase 2 succeeded or was safely skipped,
 *      and it skips any company phase 2 scheduled for immediate deletion.
 *
 * NOT side-effect free on failure. Phase 2 can start an irreversible company
 * purge before a later company's transaction fails, in which case this
 * function returns an error while a company is already being deleted. See the
 * long note in phase 2's catch block; it is the one thing about this function
 * that a reader is most likely to get wrong.
 *
 * Only ever called by `deleteAccount` above, which holds the issue #349
 * per-uid lock for the duration of this call — nothing here needs to worry
 * about a concurrent invocation for the same uid.
 */
async function runAccountDeletion(
  session: Awaited<ReturnType<typeof getVerifiedSession>>,
  uid: string,
): Promise<{ error?: string }> {
  // ── 1. Pre-flight sole-admin guard (read-only, best-effort) ────────────────
  // Exists purely to return a clear rejection before doing ANY work, for the
  // common case. It is deliberately not authoritative — the commit loop in
  // step 2 below re-checks per company, live, inside the transaction that
  // also deletes that company's membership, which is the only place this
  // guard can be both correct and race-free. A wrong answer here (stale in
  // either direction) is always caught by step 2: a false "safe" here gets
  // rejected for real by step 2 on the actual blocking company; a false
  // "blocked" here just means a legitimate deletion returns this error and
  // the user retries, which is safe because retrying is idempotent (see the
  // `!memberSnap.exists` branch in step 2).
  //
  // issue #252 point 1: this used to compute its own admin counts inline and
  // return one generic, un-named message. `getDeletionOutcomes`
  // (lib/queries/deletionOutcomes.ts) is that same computation — per-company
  // membership pointer skipping, `_meta/memberCounts` read, aggregate
  // fallback — pulled out so `deleteAccount` isn't the only caller who can
  // ever know it, and so the message below can name the blocking compan(y/ies)
  // instead of saying "one of your companies."
  let outcomes: CompanyDeletionOutcome[]
  try {
    outcomes = await getDeletionOutcomes(uid)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_preflight_failed' })
    return { error: COULD_NOT_VERIFY_ERROR }
  }

  // 'unknown' means a per-company read failed inside getDeletionOutcomes —
  // kept out of the blocking set below on purpose (see that type's
  // docblock): a company we couldn't evaluate is not evidence the user is
  // blocked, but it's also not evidence they're safe, so this fails closed
  // with the same "try again" message the top-level catch above uses, rather
  // than silently treating an unreadable company as safe to leave.
  if (outcomes.some((o) => o.outcome === 'unknown')) {
    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', action: 'delete_account_preflight_unknown_outcome' })
    return { error: COULD_NOT_VERIFY_ERROR }
  }

  // `close` is NO LONGER blocking (issue #252 step 5, PR F2). A company whose
  // only member is deleting her account is now removed along with it, via a
  // `mode: 'immediate'` deletion request created by the commit loop below.
  // `blocked` — sole admin with colleagues still in the company — remains the
  // one genuine block, and it stays a block for the reason it always was:
  // other people's work is in there and somebody has to own it.
  const blocking = outcomes.filter((o) => o.outcome === 'blocked')
  if (blocking.length > 0) {
    console.error('[actions/account]', {
      uid: uid.slice(0, 8) + '...',
      companyIds: blocking.map((b) => b.companyId),
      action: 'delete_account_blocked_sole_admin',
    })
    return { error: buildSoleAdminMessage(blocking) }
  }

  // ── 2. Commit loop: one transaction per company ────────────────────────────
  // Deletes companies/{cid}/members/{uid} and applies the memberCounts delta
  // for each company the user belongs to, one transaction per company,
  // sequentially, and entirely BEFORE the big anonymisation batch in step 3.
  // This is the authoritative guard — see step 1's comment — and it is also
  // what fixes a pre-existing bug (issue #252 point 2): a leftover
  // users/{uid}/memberships/{cid} doc pointing at a company that no longer
  // exists used to be counted as a live admin membership by the old guard,
  // which could never see a second admin appear for a company that will
  // never exist again — permanently blocking account deletion. The
  // `!companySnap.exists` branch below fixes that by skipping such a company
  // outright.
  //
  // Re-read here rather than reach into `getDeletionOutcomes`'s internal
  // read above: that function is a read-only display computation for step 1
  // and intentionally doesn't hand back its raw membership snapshot — this
  // loop needs the authoritative, current list of companies to iterate and
  // delete from, not a helper built for showing the user a message. A second
  // read of a small per-user collection (bounded by how many companies one
  // person can join) is cheap next to the rest of this function's work.
  const membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()
  const unorderedCompanyIds = membershipsSnap.docs.map(d => d.data().companyId as string).filter(Boolean)

  // Companies the pre-flight thinks will be `close` are processed LAST.
  //
  // Ordering only — the authoritative decision is still made per company,
  // live, inside each transaction below, and a company that lands here by a
  // stale pre-flight reading simply gets handled in a different position.
  // What this buys: creating a `mode: 'immediate'` request starts a purge
  // that cannot be undone, while every other company in this loop is a
  // reversible membership removal. If one of those fails transiently, the
  // loop returns an error — and doing the destructive work last means no
  // company has been torn down at the point that happens. The existing
  // "compensation is deliberately not attempted" note below still applies,
  // but the cost of a partial run is now much higher than it was when every
  // step was just a membership delete, so the cheap ordering is worth having.
  const closeFirstGuess = new Set(
    outcomes.filter((o) => o.outcome === 'close').map((o) => o.companyId),
  )
  const companyIds = [
    ...unorderedCompanyIds.filter((id) => !closeFirstGuess.has(id)),
    ...unorderedCompanyIds.filter((id) => closeFirstGuess.has(id)),
  ]

  let completedCompanies = 0
  /** Companies this run has scheduled for immediate deletion — skipped by the anonymisation loop in step 3. */
  const immediatelyDeletedCompanyIds = new Set<string>()

  for (const companyId of companyIds) {
    // Generated outside runTransaction so a transaction retry reuses the same
    // ids and the same instant instead of minting new ones per attempt.
    const requestId = adminDb.collection('companyDeletions').doc().id
    const requestNow = Timestamp.now()
    const purgeAfter = Timestamp.fromMillis(requestNow.toMillis() + IDENTITY_RETENTION_MS)

    try {
      await adminDb.runTransaction(async (tx) => {
        const companyRef = adminDb.doc(`companies/${companyId}`)
        const memberRef = adminDb.doc(`companies/${companyId}/members/${uid}`)

        // Reads first, in any order — readMemberCounts no longer writes
        // during its read phase (see lib/companyStats.ts's `applyHeal`
        // docblock). `applyHeal()` below is the one thing that must come
        // after every read here and before every write.
        const [companySnap, counts, memberSnap] = await Promise.all([
          tx.get(companyRef),
          readMemberCounts(tx, companyId),
          tx.get(memberRef),
        ])

        // Stale membership pointer: see this function's own comment above —
        // there is no company left to guard or delete a membership from.
        if (!companySnap.exists) return

        // Idempotence / partial-failure recovery: if an earlier, failed
        // attempt at this loop already deleted this company's member doc and
        // committed its delta, a retry lands here with the member doc
        // already gone. Returning early — WITHOUT reapplying
        // memberCountsDelta — is what stops the retry from decrementing
        // `admins`/`members` a second time. Skipping this check would drive
        // `_meta/memberCounts` stale-LOW for this company on every retry,
        // which fails closed (blocks a future removal/deletion here) rather
        // than stale-HIGH, but it's still wrong and entirely avoidable.
        if (!memberSnap.exists) return

        const role = memberSnap.data()!.role as string | undefined

        // `close` is checked FIRST, independent of role — mirroring
        // lib/queries/deletionOutcomes.ts's getDeletionOutcomes, which
        // classifies `close` purely from `counts.members <= 1`. An earlier
        // version of this guard only ever reached `close` through the
        // `role === 'admin' && counts.admins <= 1` branch below, which
        // silently relied on an INVARIANT it doesn't itself enforce: that a
        // company's sole member is always its admin. That invariant holds
        // today only because `updateMemberRole` (actions/team.ts) refuses to
        // demote a company's last admin — enforced in a completely different
        // file. This transaction is the AUTHORITATIVE, last-word guard
        // (step 1's own pre-flight comment); it must reach the right answer
        // on its own reads, not by trusting discipline upheld elsewhere. If
        // that invariant is ever weakened, a non-admin sole member must
        // still block here exactly like an admin one does, and checking
        // `members <= 1` first, unconditionally, is what guarantees that.
        //
        // ── The one calculation in step 5 that must not be wrong ───────────
        //
        // `counts.members` comes from `_meta/memberCounts`, a denormalised
        // counter. Everywhere else in this codebase a stale-LOW counter fails
        // closed: it blocks something that should have gone through, the user
        // retries, nothing is lost. Here it would do the opposite. `members
        // <= 1` now authorises tearing a company down with no window and no
        // undo, so a counter wrongly stuck at 1 for a five-person company
        // would delete four other people's bookings, equipment and history,
        // with nothing to retry.
        //
        // `confirmSoleMember` (lib/queries/deletionOutcomes.ts) is the
        // protection, and it is passed `tx` so the live aggregate read is
        // part of THIS transaction's read set — a member joining between the
        // read and the commit aborts and retries rather than being deleted.
        // The live count wins over the counter, always. A live count that is
        // too HIGH just means this company falls through to the ordinary
        // branches below and the account deletion is refused or proceeds
        // normally — harmless. A live count that is too low is what this
        // read exists to make impossible.
        //
        // If a future refactor is tempted to drop this second read because
        // "we already have the count": don't. The failure it prevents is
        // silent right up until the day it isn't.
        let liveMembers = counts.members
        if (liveMembers <= 1) {
          liveMembers = await confirmSoleMember(companyId, counts.members, tx)
        }

        if (liveMembers <= 1) {
          // The designbrief's "ensam medlem i eget företag": the company goes
          // with the account, immediately and without a window. There is
          // nobody left a window could protect, and the account deletion that
          // causes it is itself immediate and irreversible.
          //
          // `mode: 'immediate'` is set HERE AND NOWHERE ELSE in this
          // codebase. `requestCompanyDeletion` (actions/companyDeletion.ts)
          // always writes `'window'`, even for a one-member company — it is
          // the ACTION that picks the tempo, never a member count. This
          // branch is the sole exception, and it is one because the action
          // performed was an account deletion, not a company deletion.
          //
          // Writing the ledger row is what starts the purge:
          // `onCompanyDeletionCreated` (functions/src/company/onDeletionCreated.ts)
          // claims the lease and runs it. Nothing is purged from this
          // process, which is deliberate — a Next.js request must never be
          // the thing holding a whole company's destruction open.
          const companyName = (companySnap.data()?.name as string | undefined) ?? ''
          const memberData = memberSnap.data() ?? {}
          const requesterName = (memberData.name as string | undefined) || session.email || 'Account holder'
          const requesterEmail = (memberData.email as string | undefined) || session.email || ''

          counts.applyHeal()

          tx.set(adminDb.doc(`companyDeletions/${requestId}`), {
            requestId,
            companyId,
            companyName,
            mode: 'immediate',
            state: 'requested',
            requestedAt: requestNow,
            requestedByUid: uid,
            requestedByName: requesterName,
            requestedByEmail: requesterEmail,
            // Immediate mode has no window, so "scheduled for" is now. The
            // sweep's overdue query matches it from the first tick, which is
            // the intended safety net: if the trigger never fires, the sweep
            // picks it up. `claimRequestedLease` makes the two harmless.
            scheduledFor: requestNow,
            attempts: 0,
            purgeAfter,
            // Seeded here, not left for the purge's members phase to fill in
            // (functions/src/company/purge.ts's runMembersPhase, which
            // normally builds formerMemberContacts by reading
            // companies/{companyId}/members). `tx.delete(memberRef)` below
            // removes that very member doc in this same transaction, so by
            // the time the purge's async members phase runs there is nothing
            // left there to read her name/email from — she would never be
            // added to formerMemberContacts, and finalize's companyDeleted
            // mail is only ever queued to uids that ARE in that list (issue
            // #351). `accountStatus: 'already_gone'` is correct by
            // construction: this branch is the one place her account is
            // itself deleted, synchronously, later in this same call.
            formerMemberContacts: [
              { uid, name: requesterName, email: requesterEmail, accountStatus: 'already_gone' },
            ],
          })

          tx.update(companyRef, {
            deletion: {
              state: 'requested',
              requestId,
              requestedAt: requestNow,
              requestedByName: requesterName,
              scheduledFor: requestNow,
              mode: 'immediate',
            },
          })

          tx.delete(memberRef)
          memberCountsDelta(tx, companyId, { members: -1, admins: role === 'admin' ? -1 : 0 })

          immediatelyDeletedCompanyIds.add(companyId)
          return
        }

        if (role === 'admin' && counts.admins <= 1) {
          // Same message shape as the pre-flight (buildSoleAdminMessage),
          // built from what this transaction already read rather than a
          // fixed string — this is the authoritative guard (step 1's own
          // comment), so if it ever disagrees with a stale pre-flight
          // answer, the user should still see a message naming the right
          // company and count, not a generic fallback.
          const companyName = (companySnap.data()?.name as string | undefined) ?? ''
          const blockingOutcome: CompanyDeletionOutcome = {
            companyId,
            companyName,
            role: 'admin',
            // `liveMembers`, not `counts.members`: when the counter read low
            // enough to trigger `confirmSoleMember` above, the live number is
            // the one that just decided this company is NOT being deleted, so
            // it is also the one the user should be told about. Quoting the
            // stale counter here would produce "you are the only
            // administrator of Acme, where no one else works" for a company
            // with four colleagues in it — which reads as a bug in the
            // sentence, not as the counter drift it actually is.
            memberCount: liveMembers,
            otherAdminCount: Math.max(counts.admins - 1, 0),
            outcome: 'blocked',
          }
          throw guardError('sole-admin', buildSoleAdminMessage([blockingOutcome]))
        }

        // Only now that neither early return nor the guard above has fired —
        // a throw discards this whole transaction, including an unpersisted
        // heal, which is fine: the next reader heals it again from the same
        // live aggregate.
        counts.applyHeal()

        tx.delete(memberRef)
        memberCountsDelta(tx, companyId, { members: -1, admins: role === 'admin' ? -1 : 0 })
      })

      completedCompanies += 1
    } catch (err) {
      const code = (err as { code?: string }).code
      const message = err instanceof Error ? err.message : String(err)

      // Compensation is deliberately not attempted here: the member doc's
      // content IS the PII this function exists to erase, so re-creating it
      // to "undo" a partial run would be self-defeating. Whichever companies
      // already had their membership removed stay that way; the caller sees
      // one clear error and can retry, which is safe because of the two
      // early returns above.
      //
      // READ THIS BEFORE TRUSTING THE PARAGRAPH ABOVE: as of issue #252 step
      // 5, a `deleteAccount` that returns an error is NOT side-effect free.
      // "Nothing was deleted" was true when every step of this loop was a
      // reversible membership removal. It stopped being true the moment the
      // loop gained the `mode: 'immediate'` branch: writing that ledger row
      // starts `runCompanyPurge` asynchronously, through
      // `onCompanyDeletionCreated`, and NOTHING here can call it back. So if
      // the loop passes a `close` company and then fails on a later one, the
      // user is told her account could not be deleted while one of her
      // companies is already, irreversibly, on its way out.
      //
      // That behaviour is the right one — trying to unwind a purge that has
      // begun deleting subcollections would be far worse than letting it
      // finish. What must not happen is a future reader concluding from the
      // paragraph above that a failed call left the world untouched. The
      // `closeFirstGuess` ordering where `companyIds` is built is the
      // mitigation: it makes the irreversible work happen last, so a
      // transient failure on an ordinary company almost always lands before
      // any company has been scheduled. "Almost always" is not "never", and
      // that gap is the honest statement of this function's failure mode.
      console.error('[actions/account]', {
        uid: uid.slice(0, 8) + '...',
        companyId,
        error: message,
        action: 'delete_account_partial_membership_removal',
        completed: completedCompanies,
        total: companyIds.length,
      })

      // `message` here is `guardError`'s own message for 'sole-admin' —
      // already the fully-built, company-named string, not a fixed constant
      // (see the throw site above) — so it's used directly rather than
      // mapped to one.
      return { error: code === 'sole-admin' ? message : COULD_NOT_VERIFY_ERROR }
    }
  }

  // ── 3. Anonymize all user data ──────────────────────────────────────────────
  try {
    let batch = adminDb.batch()
    let opCount = 0

    async function addOp(ref: FirebaseFirestore.DocumentReference, data: Record<string, null | string>) {
      batch.update(ref, data)
      opCount++
      if (opCount >= BATCH_LIMIT) {
        batch = await commitAndReset(batch)
        opCount = 0
      }
    }

    async function addDelete(ref: FirebaseFirestore.DocumentReference) {
      batch.delete(ref)
      opCount++
      if (opCount >= BATCH_LIMIT) {
        batch = await commitAndReset(batch)
        opCount = 0
      }
    }

    for (const companyId of companyIds) {
      // A company scheduled for IMMEDIATE deletion in step 2 is skipped here
      // entirely, and that is a correctness requirement, not an optimisation.
      //
      // Creating that ledger row starts `runCompanyPurge` through
      // `onCompanyDeletionCreated`, typically within a second — while this
      // loop is still running. Every `batch.update()` below targets a
      // document the purge is concurrently deleting, and a WriteBatch whose
      // update hits a document that no longer exists fails the ENTIRE batch
      // with NOT_FOUND. That would abort this user's account deletion
      // halfway: her memberships gone, her company being purged, her Auth
      // record still there, and an error message telling her nothing worked.
      //
      // Skipping costs nothing, either. Anonymising fields on documents that
      // are about to be deleted outright achieves the same end state by a
      // longer route, and the purge's own Stripe phase
      // (functions/src/company/purge.ts) cancels the subscription and
      // anonymises the customer — the two things the tail of this loop body
      // would otherwise have done for this company.
      if (immediatelyDeletedCompanyIds.has(companyId)) continue

      const bookingsRef = adminDb.collection(`companies/${companyId}/bookings`)
      const equipmentRef = adminDb.collection(`companies/${companyId}/equipment`)
      const companyRef = adminDb.doc(`companies/${companyId}`)

      // Bookings: userId (also clear userName — GDPR Art. 5(1)(c) data minimisation)
      const byUserId = await bookingsRef.where('userId', '==', uid).get()
      for (const doc of byUserId.docs) await addOp(doc.ref, { userId: null, userName: null })

      // Bookings: cancelledBy
      const byCancelledBy = await bookingsRef.where('cancelledBy', '==', uid).get()
      for (const doc of byCancelledBy.docs) await addOp(doc.ref, { cancelledBy: null })

      // Bookings: approverId
      const byApproverId = await bookingsRef.where('approverId', '==', uid).get()
      for (const doc of byApproverId.docs) await addOp(doc.ref, { approverId: null })

      // Equipment: createdBy
      const byCreatedBy = await equipmentRef.where('createdBy', '==', uid).get()
      for (const doc of byCreatedBy.docs) await addOp(doc.ref, { createdBy: null })

      // Equipment: approverId
      const byEquipmentApprover = await equipmentRef.where('approverId', '==', uid).get()
      for (const doc of byEquipmentApprover.docs) await addOp(doc.ref, { approverId: null })

      // Units: iterate equipment subcollections directly — avoids collectionGroup
      // index requirement. A single-filter collectionGroup('units').where('companyId',
      // ...) query needs a COLLECTION_GROUP_ASC index on companyId that firestore.indexes.json
      // never had, so this threw FAILED_PRECONDITION before the query ever ran, making
      // GDPR Art. 17 deletion fail deterministically for every user (issue #347). No index
      // is needed here because equipmentRef is already scoped to this company. Same pattern
      // as anonymizeMemberReferences in actions/team.ts.
      //
      // The per-equipment units reads are fired in parallel (basic plan caps
      // equipment at 100 — lib/plans.ts — so sequential awaits here, stacked
      // on top of the ~9 other sequential queries this per-company loop
      // already does, could push a user in several near-limit companies
      // toward a Server Action timeout). Only the reads are parallelised:
      // `addOp` mutates the shared `batch`/`opCount` closure state and must
      // stay called one at a time, so the writes below remain a plain
      // sequential loop over the resolved snapshots.
      const allEquipmentSnap = await equipmentRef.get()
      const unitsSnaps = await Promise.all(
        allEquipmentSnap.docs.map((eqDoc) => eqDoc.ref.collection('units').get()),
      )
      for (const unitsSnap of unitsSnaps) {
        for (const doc of unitsSnap.docs) {
          const data = doc.data()
          const updates: Record<string, null> = {}
          if (data.createdBy === uid) updates.createdBy = null
          if (data.updatedBy === uid) updates.updatedBy = null
          if (data.deactivatedBy === uid) updates.deactivatedBy = null
          if (Object.keys(updates).length > 0) await addOp(doc.ref, updates)
        }
      }

      // Invitations: this user's PII shows up on invitation docs in three
      // distinct roles, each requiring a different field to be cleared.
      // Anonymise (like bookings/equipment above), never delete — the record
      // that an invitation happened is company history worth keeping.
      const invitationsRef = adminDb.collection(`companies/${companyId}/invitations`)

      // Invitations: acceptedBy — the invitation that brought this user IN.
      // The fact that someone accepted survives; the accepted address does not.
      const byAcceptedBy = await invitationsRef.where('acceptedBy', '==', uid).get()
      for (const doc of byAcceptedBy.docs) await addOp(doc.ref, { email: null, acceptedBy: null })

      // Invitations: invitedBy — invitations this user SENT to someone else.
      // invitedByName is this user's own display name, so it's their PII even
      // though the document is about a different recipient. Their `email`
      // field belongs to that other person, not the deleted user — leave it.
      const byInvitedBy = await invitationsRef.where('invitedBy', '==', uid).get()
      for (const doc of byInvitedBy.docs) await addOp(doc.ref, { invitedBy: null, invitedByName: null })

      // Invitations: revokedBy
      const byRevokedBy = await invitationsRef.where('revokedBy', '==', uid).get()
      for (const doc of byRevokedBy.docs) await addOp(doc.ref, { revokedBy: null })

      // Pending invitations still addressed TO the deleted user: the invite
      // can never be accepted now, so both the subcollection doc and its
      // top-level invitations/{token} mirror (actions/team.ts ~line 199-217 —
      // the mirror doc id IS the token, read back here from the invite doc's
      // `token` field) are deleted outright rather than anonymised. The
      // mirror is resolvable by anyone holding the invite link, so leaving it
      // behind would keep the email readable outside the company entirely.
      // Matching relies on Invitation.email being written lowercased via
      // normalizeEmail() (actions/team.ts) — session.email is normalized the
      // same way here so the comparison doesn't depend on how Firebase Auth
      // happens to case the token's email claim.
      if (session.email) {
        const normalizedEmail = normalizeEmail(session.email)
        const pendingToUser = await invitationsRef
          .where('email', '==', normalizedEmail)
          .where('status', '==', 'pending')
          .get()
        for (const doc of pendingToUser.docs) {
          await addDelete(doc.ref)
          const token = doc.data().token as string | undefined
          if (token) await addDelete(adminDb.doc(`invitations/${token}`))
        }
      }

      // Company member doc (carries this user's name/email — GDPR Art. 17)
      // and its memberCounts delta are no longer handled here: step 2's
      // per-company transaction, above, already deleted
      // companies/{companyId}/members/{uid} and applied the delta before
      // this anonymisation loop ever started. Doing it there instead of here
      // is what closes a sync risk this loop used to have: the company-side
      // member doc used to be deleted here while the user-side membership
      // doc was deleted later (see the "Delete membership docs" loop below,
      // after this `for` loop) — potentially in a different WriteBatch chunk
      // if a large anonymisation run rotated batches in between. Now the
      // company-side delete is already committed, in its own transaction,
      // before any of that can happen.

      // Company doc: createdBy
      const companySnap = await companyRef.get()
      if (companySnap.exists && companySnap.data()?.createdBy === uid) {
        await addOp(companyRef, { createdBy: null })
      }

      // Stripe customer anonymisation — must run before Auth deletion while
      // stripeCustomerId is still readable. Anonymise rather than delete so
      // invoices are preserved (Bokföringslagen 7 years).
      const stripeCustomerId = companySnap.data()?.stripeCustomerId as string | undefined
      if (stripeCustomerId) {
        try {
          await stripe.customers.update(stripeCustomerId, {
            email: 'deleted@allocate.invalid',
            name: 'Deleted User',
            metadata: { deletedAt: new Date().toISOString() },
          })
        } catch (stripeErr) {
          const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
          console.error('[actions/account] Stripe anonymisation failed', { stripeCustomerId, error: msg })
        }

        // Clear the Stripe link from the company doc if the subscription is
        // already cancelled — it no longer serves a purpose. Keep it for
        // active/trialing subscriptions so the billing portal still works.
        const subStatus = companySnap.data()?.subscription?.status as string | undefined
        if (!subStatus || subStatus === 'canceled') {
          await addOp(companyRef, { stripeCustomerId: '' } as Record<string, null | string>)
        }
      }
    }

    // Delete membership docs (users/{uid}/memberships/*). Deliberately left
    // in this WriteBatch rather than folded into step 2's per-company
    // transaction: this loop iterates ALL of the user's membership docs
    // regardless of company, including any stale pointer whose company no
    // longer exists (step 2 skips those via `!companySnap.exists` — the
    // pointer itself still needs deleting, it's still this user's data). It
    // also naturally belongs with the rest of this function's user-side
    // cleanup (the user doc delete and the audit log write immediately
    // below), which have no equivalent per-company transaction to join. By
    // the time this runs, step 2 has already either deleted every company's
    // member doc or returned an error — so every doc this loop deletes here
    // is safe to remove.
    for (const membershipDoc of membershipsSnap.docs) {
      batch.delete(membershipDoc.ref)
      opCount++
      if (opCount >= BATCH_LIMIT) {
        batch = await commitAndReset(batch)
        opCount = 0
      }
    }

    // Delete user doc
    batch.delete(adminDb.doc(`users/${uid}`))
    opCount++

    // Deletion audit log (sha256 hash only — no PII stored)
    const userIdHash = createHash('sha256').update(uid).digest('hex')
    batch.set(adminDb.collection('deletionAuditLog').doc(), {
      userIdHash,
      deletedAt: FieldValue.serverTimestamp(),
      triggeredBy: 'user_self',
    })

    await batch.commit()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', error: message, action: 'delete_account_anonymise_failed' })
    return { error: 'Failed to delete account' }
  }

  // ── 3. Clear session — user is logged out regardless of what follows ───────
  try {
    await deleteSession()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_session_failed' })
  }

  // ── 4. Delete Firebase Auth record (irreversible — must be last) ───────────
  try {
    await adminAuth.deleteUser(uid)
    console.log('[actions/account]', { uid: uid.slice(0, 8) + '...', action: 'account_deleted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', error: message, action: 'delete_auth_user_failed' })
  }

  return {}
}

// Uses `verifyAuthenticatedSession` (auth-only), not `getVerifiedSession`:
// this must keep working for a signed-in user with NO active company —
// the "export my data" path /no-company offers a stranded member (issue
// #252 step 5, PR F, design brief "Del 3"). `getVerifiedSession` would
// redirect her away before this function ever ran. Nothing below reads
// `session.activeCompanyId` — the company list already comes from her
// `users/{uid}/memberships` collection, not the session claim.
export async function exportUserData(): Promise<{ json?: string; error?: string }> {
  const session = await verifyAuthenticatedSession()
  const uid = session.uid

  try {
    const userSnap = await adminDb.collection('users').doc(uid).get()
    const userData = userSnap.data() ?? {}

    const membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()

    const companies = await Promise.all(
      membershipsSnap.docs.map(async (membershipDoc) => {
        const membership = membershipDoc.data()
        const companyId = membership.companyId as string

        const companySnap = await adminDb.collection('companies').doc(companyId).get()
        const companyData = companySnap.data() ?? {}

        const bookingsSnap = await adminDb
          .collection(`companies/${companyId}/bookings`)
          .where('userId', '==', uid)
          .get()

        const bookings = bookingsSnap.docs.map((d) => {
          const b = d.data()
          return {
            projectName: b.projectName ?? null,
            startDate:   b.startDate ?? null,
            endDate:     b.endDate ?? null,
            status:      b.status ?? null,
            createdAt:   b.createdAt ?? null,
          }
        })

        return {
          companyId,
          companyName: companyData.name ?? null,
          plan:        companyData.subscription?.plan ?? null,
          role:        membership.role ?? null,
          joinedAt:    membership.joinedAt ?? null,
          bookings,
        }
      })
    )

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      user: {
        name:            userData.name ?? null,
        email:           userData.email ?? null,
        activeCompanyId: userData.activeCompanyId ?? null,
        createdAt:       userData.createdAt ?? null,
      },
      companies,
    }

    console.log('[actions/account]', { uid: uid.slice(0, 8) + '...', action: 'data_exported' })
    return { json: JSON.stringify(exportPayload, null, 2) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'export_data_failed' })
    return { error: 'Failed to export data' }
  }
}
