import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import { toIso } from '@/lib/companyDeletionCancelWrites'
import type { CompanyDeletionState, Role } from '@/types'

/**
 * What deleting the caller's account would do to ONE company they belong to.
 * Issue #252 point 1 — this is what turns "you are the only admin of one of
 * your companies" (true but unusable) into a message that names the company,
 * the headcount, and the way out. See the designbrief at
 * plan/designbrief-radering-av-konto.md — this file implements only the
 * outcome computation it describes, not the UI around it.
 *
 *   - `close`   — the caller is the company's ONLY member. Per the
 *                 designbrief's "ensam medlem"-undantag, the company is
 *                 removed together with the account — no successor exists to
 *                 hand admin rights to, so none is needed.
 *   - `blocked` — the caller is the sole admin AND other members exist. The
 *                 company has people relying on it; someone else must become
 *                 admin first (`updateMemberRole`, actions/team.ts).
 *   - `leave`   — anything else: the caller can leave and the company carries
 *                 on unaffected (a regular member, or an admin among admins).
 *   - `unknown` — the outcome could not be determined (a read failed). Kept
 *                 distinct from `blocked` on purpose: `blocked` hands the
 *                 user something to do (promote a colleague); `unknown` means
 *                 the system couldn't tell and the honest instruction is
 *                 "try again," not a fabricated company name or count.
 */
export type DeletionOutcome = 'close' | 'blocked' | 'leave' | 'unknown'

export interface CompanyDeletionOutcome {
  companyId: string
  companyName: string
  /** The caller's own role in this company, e.g. for deciding whether `blocked` can even apply. */
  role: Role
  /** Total members in the company, the caller included. */
  memberCount: number
  /** Admins other than the caller. Meaningful chiefly when `role === 'admin'`;
   *  for a non-admin caller this is just the company's admin count, since none
   *  of them can be the caller anyway. */
  otherAdminCount: number
  outcome: DeletionOutcome
  /** Mirrors `companies/{cid}.deletion` when present — issue #383's refusal guard reads this. */
  pendingDeletion?: { state: CompanyDeletionState | undefined; scheduledFor: string }
}

/**
 * Reads `companies/{id}/_meta/memberCounts` (lib/companyStats.ts) with the
 * same self-healing aggregate fallback `readMemberCounts` uses for a missing
 * counter doc — but NOT `readMemberCounts` itself, and deliberately not
 * inside a `Transaction`:
 *
 * `readMemberCounts` takes a `Transaction` because its caller (the
 * `deleteAccount` commit loop) needs the heal to compose atomically with the
 * membership delete it's about to perform — the heal write and the guard
 * decision must see the same snapshot. This function has no write to compose
 * with; it only reports a number for display, so wrapping it in a fabricated
 * transaction just to reuse `readMemberCounts` would buy nothing and cost a
 * real transaction slot for a read that was never going to write anything.
 * A plain `.get()` with the same fallback shape (this function does NOT
 * persist the heal — that's `readMemberCounts`'s job the next time an
 * authoritative caller runs) is the honest read-only equivalent, and mirrors
 * the aggregate-fallback the old pre-flight guard in actions/account.ts used
 * before this file replaced it.
 */
async function readCompanyCounts(
  companyId: string,
): Promise<{ members: number; admins: number; source: 'counter' | 'aggregate' }> {
  const metaSnap = await adminDb.doc(`companies/${companyId}/_meta/memberCounts`).get()
  if (metaSnap.exists) {
    const data = metaSnap.data()!
    return {
      members: (data.members as number | undefined) ?? 0,
      admins: (data.admins as number | undefined) ?? 0,
      source: 'counter',
    }
  }

  const membersCollection = adminDb.collection(`companies/${companyId}/members`)
  const [membersCountSnap, adminsCountSnap] = await Promise.all([
    membersCollection.count().get(),
    membersCollection.where('role', '==', 'admin').count().get(),
  ])

  return { members: membersCountSnap.data().count, admins: adminsCountSnap.data().count, source: 'aggregate' }
}

/**
 * Confirms a `members <= 1` reading from `_meta/memberCounts` against a live
 * aggregate count on `companies/{id}/members`, and returns whichever the two
 * disagree on the LIVE value wins.
 *
 * Only `close` gets this extra read — `blocked`/`leave`/`unknown` do not —
 * and that asymmetry is deliberate, not an oversight to tidy up later:
 * `close` is the one classification issue #252 Part 2 (step 5) will wire to
 * an IRREVERSIBLE action (deleting the company along with the account). A
 * stale-LOW counter is the fail-closed, harmless direction everywhere else in
 * this codebase (`readMemberCounts`'s self-heal, the old pre-flight guard) —
 * worst case it blocks a deletion that should have gone through, and the
 * user retries. The same stale-LOW counter feeding `close` in step 5 stops
 * being harmless: a five-person company whose counter was wrongly stuck at
 * `members: 1` would be deleted along with one member's account, and there
 * would be four other people's data and work gone with no transaction to
 * retry. This function is the hardening for that future failure mode, added
 * now — while `close` still only drives a rejection message — specifically
 * so nobody has to remember to add it in step 5, on the day it stops being
 * optional.
 *
 * THAT DAY HAS ARRIVED (issue #252 step 5, PR F2). `close` no longer just
 * builds a rejection message: `deleteAccount`'s commit loop (actions/
 * account.ts) now creates a `mode: 'immediate'` deletion request for a
 * `close` company, which the purge executes with no window and no undo. That
 * is why this function is now EXPORTED and takes an optional `tx`:
 *
 *   - Exported, because `deleteAccount`'s authoritative per-company
 *     transaction has to run the same confirmation the read-only pre-flight
 *     does. A second, hand-inlined copy of "read the live aggregate, prefer
 *     it, log the mismatch" in actions/account.ts is exactly how the two
 *     would drift, and the plan is explicit that this live read IS the whole
 *     protection ("tas det bort i en framtida 'förenkling' är felet tyst
 *     tills dagen det inte är det").
 *   - `tx`, because in that caller the confirmation must compose atomically
 *     with the writes it authorises. A plain `.count().get()` inside a
 *     transaction callback is a non-transactional read: it would not be part
 *     of the transaction's read set, so a member joining between this read
 *     and the commit would not cause a retry, and the company would be torn
 *     down anyway. Passing the aggregate query through `tx.get` puts it in
 *     the read set, which is the difference between "we looked" and "we
 *     looked and nothing changed under us."
 *
 * Callers MUST prefer the returned value over the counter's — returning the
 * live number rather than a boolean is deliberate, so a caller can't keep
 * using its own stale reading after asking.
 *
 * Every disagreement is logged with its own `action` string
 * (`close_outcome_counter_mismatch`) precisely so a live-vs-counter drift
 * shows up in Cloud Logging on its own, distinguishable from every other
 * `[lib/queries/deletionOutcomes]` log line — the counter being wrong is an
 * operational fact worth knowing about even on the days it doesn't change
 * the outcome (e.g. counter says 1, live says 1 too — still checked, still
 * would have logged had they differed).
 */
export async function confirmSoleMember(
  companyId: string,
  counterMembers: number,
  tx?: FirebaseFirestore.Transaction,
): Promise<number> {
  const countQuery = adminDb.collection(`companies/${companyId}/members`).count()
  const liveSnap = tx ? await tx.get(countQuery) : await countQuery.get()
  const liveMembers = liveSnap.data().count

  if (liveMembers !== counterMembers) {
    console.error('[lib/queries/deletionOutcomes]', {
      companyId,
      counterMembers,
      liveMembers,
      action: 'close_outcome_counter_mismatch',
    })
  }

  return liveMembers
}

/**
 * Computes the account-deletion outcome for every company the given user
 * belongs to. Read-only — this never writes, never deletes anything, and is
 * safe to call speculatively (e.g. to render a warning) as well as from
 * `deleteAccount` (actions/account.ts) to build its blocking message.
 *
 * A company whose document no longer exists (a stale
 * `users/{uid}/memberships/{cid}` pointer) is skipped outright, not reported
 * as `unknown` — the same reasoning `deleteAccount`'s commit loop already
 * applies to `!companySnap.exists`: there is nothing left to report on, and
 * surfacing a phantom company would just be confusing, not honest.
 *
 * Deliberately not wrapped in React's `cache()`, unlike this directory's
 * other read functions (`getCompany`, `listMembers`, `getUserProfile`): those
 * are read paths a Server Component render tree can call more than once per
 * request and want deduplicated. This function's callers care about a fresh
 * answer more than a deduplicated one — `deleteAccount` computes it once, to
 * decide whether to block a destructive operation, and a stale cached answer
 * there is a correctness risk this codebase already goes out of its way to
 * avoid (see `readMemberCounts`'s non-authoritative pre-flight comment).
 */
export async function getDeletionOutcomes(uid: string): Promise<CompanyDeletionOutcome[]> {
  const membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()

  const results = await Promise.all(
    membershipsSnap.docs.map(async (membershipDoc): Promise<CompanyDeletionOutcome | null> => {
      // No null-check on `companyId`: if a membership doc is somehow missing
      // it, `adminDb.doc('companies/undefined')` below just reads a document
      // that (barring an astronomically unlikely real id collision) doesn't
      // exist, and falls into the same `!companySnap.exists` skip as any
      // other stale pointer — it fails safe without needing its own branch.
      const companyId = membershipDoc.data().companyId as string
      const role = (membershipDoc.data().role as Role | undefined) ?? 'crew'

      let companySnap: FirebaseFirestore.DocumentSnapshot
      try {
        companySnap = await adminDb.doc(`companies/${companyId}`).get()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[lib/queries/deletionOutcomes]', { companyId, error: message, action: 'company_read_failed' })
        return { companyId, companyName: '', role, memberCount: 0, otherAdminCount: 0, outcome: 'unknown' }
      }

      // Stale membership pointer — see this function's own docblock. Skipped
      // entirely, not reported.
      if (!companySnap.exists) return null

      const companyName = (companySnap.data()?.name as string | undefined) ?? ''
      // Presence of the field, not `.state`, is what "has a deletion in
      // progress" means — mirrors the `if (existing)` check the sibling
      // guards use (actions/companyDeletion.ts, actions/operatorCompanyDeletion.ts).
      // `state` may still be missing/malformed on the raw doc; that's handed
      // to `buildPendingDeletionMessage`'s default branch rather than hidden
      // here by requiring it.
      //
      // Computed for every outcome (leave/blocked/close alike) since it's a
      // cheap read off data already in hand — only `deleteAccount`'s `close`
      // branch ever acts on it.
      const rawDeletion = companySnap.data()?.deletion as { state?: CompanyDeletionState; scheduledFor?: unknown } | undefined
      const pendingDeletion = rawDeletion
        ? { state: rawDeletion.state, scheduledFor: toIso(rawDeletion.scheduledFor) }
        : undefined

      try {
        const counts = await readCompanyCounts(companyId)
        let members = counts.members
        const admins = counts.admins

        // Harden the `close` reading specifically — see `confirmSoleMember`'s
        // docblock for why this classification alone gets a second, live
        // read. Only worth doing when the counter doc was the source: the
        // 'aggregate' branch of readCompanyCounts IS already a live read (the
        // self-heal fallback for a missing counter doc), so confirming it
        // against itself would just repeat the same query for nothing.
        if (counts.source === 'counter' && members <= 1) {
          members = await confirmSoleMember(companyId, members)
        }

        const otherAdminCount = role === 'admin' ? Math.max(admins - 1, 0) : admins

        let outcome: DeletionOutcome
        if (members <= 1) {
          outcome = 'close'
        } else if (role === 'admin' && admins <= 1) {
          outcome = 'blocked'
        } else {
          outcome = 'leave'
        }

        return { companyId, companyName, role, memberCount: members, otherAdminCount, outcome, ...(pendingDeletion ? { pendingDeletion } : {}) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[lib/queries/deletionOutcomes]', { companyId, error: message, action: 'counts_read_failed' })
        return { companyId, companyName, role, memberCount: 0, otherAdminCount: 0, outcome: 'unknown' }
      }
    }),
  )

  return results.filter((r): r is CompanyDeletionOutcome => r !== null)
}
