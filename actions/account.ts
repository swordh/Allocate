'use server'

import { createHash } from 'crypto'
import { revalidatePath } from 'next/cache'
import { FieldValue, WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { normalizeEmail } from '@/lib/invite-recipients'
import { memberCountsDelta, readMemberCounts } from '@/lib/companyStats'
import { getDeletionOutcomes, type CompanyDeletionOutcome } from '@/lib/queries/deletionOutcomes'
import { stripe } from '@/lib/stripe'
import type { Role } from '@/types'
import { deleteSession } from './auth'

const BATCH_LIMIT = 490

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
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
 * Sentence for the `close` companies in a `deleteAccount` rejection: the
 * caller is the company's ONLY member, so there is no colleague to promote —
 * `buildBlockedClause`'s advice would be a dead end here. This codebase
 * doesn't yet implement removing a company together with its sole member's
 * account (issue #252 Part 2 / step 5 — the designbrief's "ensam medlem"
 * exception), so today this is a genuine, self-service-free block, and the
 * only honest instruction is to ask a human. An earlier version of this
 * message folded `close` into `buildBlockedClause`'s "make someone else an
 * administrator" advice — which is exactly the bug issue #252 exists to
 * fix, just relocated: a message that tells someone with nobody left to
 * promote to go promote somebody.
 *
 * Names "Help & feedback" (`components/support/SupportModal.tsx`'s modal
 * title, opened via `openHelp()` from `lib/support-context.tsx`), not
 * support@allocate.at: `PrimaryNav` (`components/nav/PrimaryNav.tsx`) renders
 * on every route under `app/(app)/layout.tsx` — including
 * `/settings/account`, where this message is shown — so the user can open it
 * without leaving the page they're already on and without switching to an
 * email client. Pointing at a concrete, already-open surface rather than an
 * address is the same fix `buildBlockedClause` makes by naming
 * "Settings → Team" instead of just saying "ask an admin" — vague-but-true
 * is the failure mode this whole change exists to remove, and a mailto
 * address the user has to go find is still vague in that sense.
 */
function buildCloseClause(companies: CompanyDeletionOutcome[]): string {
  if (companies.length === 1) {
    const company = companies[0]!
    return `you are the only member of ${company.companyName}, so deleting your account would also remove the company. We can't do that automatically yet — open Help & feedback and we'll take care of it.`
  }

  const names = companies.map((company) => company.companyName).join(', ')
  return `you are the only member of ${companies.length} companies — ${names} — so deleting your account would also remove them. We can't do that automatically yet — open Help & feedback and we'll take care of it.`
}

/**
 * Builds the message for `deleteAccount`'s sole-admin block from one or more
 * `getDeletionOutcomes` results (lib/queries/deletionOutcomes.ts) whose
 * outcome is `blocked` or `close`.
 *
 * These two outcomes get genuinely different sentences, not a shared
 * "make someone else an administrator" line: `blocked` companies have a
 * colleague to promote, `close` companies don't. A user who is `blocked` in
 * one company and `close` in another sees BOTH sentences — the designbrief
 * is explicit that consequences must be reported per company, never
 * collapsed into one verdict, and a merged message here would hide the
 * `close` company's completely different fix behind the `blocked` company's
 * advice.
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
  const closeCompanies = blocking.filter((company) => company.outcome === 'close')

  const clauses: string[] = []
  if (blockedCompanies.length > 0) clauses.push(buildBlockedClause(blockedCompanies))
  if (closeCompanies.length > 0) clauses.push(buildCloseClause(closeCompanies))

  // ' Also, ' joins at most two clauses today (one `blocked`, one `close`) —
  // if a future outcome type needs a third clause here, this join still
  // works (`Array.join` handles any length), but the "Also," wording was
  // only proven to read naturally for exactly two; re-check it out loud
  // before adding a third clause kind.
  return `Cannot delete account: ${clauses.join(' Also, ')}`
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
 * Three phases:
 *   1. Pre-flight sole-admin guard — read-only, best-effort, exists only to
 *      fail fast with a clear message; never authoritative on its own.
 *   2. Commit loop — one `runTransaction` per company, sequential: the
 *      authoritative guard, the company-side member doc delete, and the
 *      memberCounts delta (lib/companyStats.ts) all happen together. Skips a
 *      company outright if it no longer exists (a stale membership pointer),
 *      and is idempotent against a retry whose member doc is already gone.
 *   3. Anonymisation — a chunked WriteBatch over bookings/equipment/units/
 *      invitations/Stripe, followed by session + Auth-record deletion. Only
 *      reached if every company in phase 2 succeeded or was safely skipped.
 */
export async function deleteAccount(): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  const uid = session.uid

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

  // `close` still counts as "blocking" here — this codebase doesn't yet
  // implement removing a company together with its sole member's account
  // (issue #252 Part 2 / step 5), so a `close` company genuinely can't be
  // deleted through today. It is NOT folded into the same message as
  // `blocked`, though — see `buildSoleAdminMessage`'s docblock: a sole
  // member has no colleague to promote, so "make someone else an
  // administrator" would be advice they cannot act on, which is the exact
  // failure mode issue #252 point 1 exists to fix.
  const blocking = outcomes.filter((o) => o.outcome === 'blocked' || o.outcome === 'close')
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
  const companyIds = membershipsSnap.docs.map(d => d.data().companyId as string).filter(Boolean)
  let completedCompanies = 0

  for (const companyId of companyIds) {
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
        if (counts.members <= 1) {
          const companyName = (companySnap.data()?.name as string | undefined) ?? ''
          const blockingOutcome: CompanyDeletionOutcome = {
            companyId,
            companyName,
            role: (role as Role | undefined) ?? 'crew',
            memberCount: counts.members,
            otherAdminCount: Math.max(counts.admins - (role === 'admin' ? 1 : 0), 0),
            outcome: 'close',
          }
          throw guardError('sole-admin', buildSoleAdminMessage([blockingOutcome]))
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
            memberCount: counts.members,
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

      // Units: read all units in company, filter in-code for user references
      const unitsSnap = await adminDb
        .collectionGroup('units')
        .where('companyId', '==', companyId)
        .get()
      for (const doc of unitsSnap.docs) {
        const data = doc.data()
        const updates: Record<string, null> = {}
        if (data.createdBy === uid) updates.createdBy = null
        if (data.updatedBy === uid) updates.updatedBy = null
        if (data.deactivatedBy === uid) updates.deactivatedBy = null
        if (Object.keys(updates).length > 0) await addOp(doc.ref, updates)
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

export async function exportUserData(): Promise<{ json?: string; error?: string }> {
  const session = await getVerifiedSession()
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
