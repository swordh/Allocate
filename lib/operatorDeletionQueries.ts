import 'server-only'

import { adminDb } from '@/lib/firebase-admin'
import { iso, isoOrNull, type TimestampLike } from '@/lib/firestore-timestamps'
import type { CompanyDeletionRow } from '@/types/operator'

/**
 * Firestore reads for the operator's read-only deletion views (issue #252
 * step 6, PR 4). Every query here targets `companyDeletions` — the ledger —
 * never `companies/{cid}.deletion`, per the plan's "läs ledgern, inte
 * spegeln" (see the docblock on `CompanyDeletionRow` in types/operator.ts).
 *
 * Callers are expected to wrap these in their own `safeRead`-style
 * try/catch (both app/operator/customers/[companyId]/page.tsx and
 * app/operator/deletions/page.tsx already have one) so a missing composite
 * index or a transient Firestore error degrades one section instead of
 * 500ing the page — that is why nothing here catches its own errors.
 */

// Both `PAGE_LIMIT`s below are a safety cap, not a real expectation of
// hitting it — see the "capped" flag each caller derives from
// `docs.length === limit`, same convention as NOTES_LIMIT on the customer
// detail page.
export const COMPANY_HISTORY_LIMIT = 50
export const LIST_VIEW_LIMIT = 200

function mapDeletionDoc(doc: FirebaseFirestore.QueryDocumentSnapshot): CompanyDeletionRow {
  const d = doc.data()
  return {
    requestId: d.requestId ?? doc.id,
    companyId: d.companyId ?? '',
    companyName: d.companyName ?? '',
    mode: d.mode === 'immediate' ? 'immediate' : 'window',
    state: d.state,

    requestedAt: iso(d.requestedAt),
    // Passed through untouched — `null` (redacted) and `undefined` (field
    // never written) must survive exactly as Firestore returned them. Do
    // NOT introduce a `?? null` or `?? ''` here; see identityDisplay in
    // lib/operatorDeletionView.ts for why that distinction is load-bearing.
    requestedByUid: d.requestedByUid,
    requestedByName: d.requestedByName,
    requestedByEmail: d.requestedByEmail,
    scheduledFor: iso(d.scheduledFor),

    canceledAt: isoOrNull(d.canceledAt) ?? undefined,
    canceledByUid: d.canceledByUid,
    canceledByName: d.canceledByName,
    canceledByEmail: d.canceledByEmail,
    cancelSource: d.cancelSource,

    completedAt: isoOrNull(d.completedAt) ?? undefined,

    stripePause: d.stripePause
      ? { at: iso(d.stripePause.at), effect: d.stripePause.effect, error: d.stripePause.error }
      : undefined,
    stripeResume: d.stripeResume
      ? { at: iso(d.stripeResume.at), effect: d.stripeResume.effect, error: d.stripeResume.error }
      : undefined,

    operatorActions: Array.isArray(d.operatorActions)
      ? d.operatorActions.map((a: Record<string, unknown>) => ({
          action: String(a.action ?? ''),
          // `?? null` is safe here, unlike on requestedByUid/canceledByUid above:
          // the only writer that exists today is the 24-month retention job
          // (functions/src/company/purgeLogs.ts), and it always sets both fields
          // to an explicit `null`, never omits them — `CompanyDeletionOperatorAction`
          // also types them as `string | null`, not optional, so there is no
          // "never had an identity" case to collapse into "redacted" yet. The
          // step 6 authoring path that appends operator-written entries has not
          // been built (see the docblock on that type in types/company.ts). If a
          // future writer on that path ever omits byUid/byName instead of writing
          // null, this line will silently misreport "redacted" for an entry that
          // in fact never carried an actor — replace `?? null` with a pass-through
          // (like requestedByUid above) at that point.
          byUid: (a.byUid as string | null) ?? null,
          byName: (a.byName as string | null) ?? null,
          at: iso(a.at as TimestampLike),
          note: a.note as string | undefined,
        }))
      : undefined,

    phase: d.phase,
    completedPhases: Array.isArray(d.completedPhases) ? d.completedPhases : undefined,
    phaseCounts: d.phaseCounts,

    attempts: typeof d.attempts === 'number' ? d.attempts : 0,
    lastHeartbeatAt: isoOrNull(d.lastHeartbeatAt) ?? undefined,
    lastError: d.lastError,
  }
}

/**
 * Full history for one company, newest request first — a company can go
 * "requested, canceled, requested again, completed" across several separate
 * ledger rows (each `requestCompanyDeletion` call mints a new `requestId`;
 * cancellation updates the existing row rather than creating one). This is
 * the read the per-company detail page renders as its timeline, and is also
 * what lets that page render a fully-purged company (no `companies/{cid}`
 * doc left) instead of 404ing — see that page's own comment.
 *
 * Needs the composite index on (companyId ASC, requestedAt DESC) — added to
 * firestore.indexes.json by this PR.
 */
export async function queryDeletionsByCompany(companyId: string): Promise<CompanyDeletionRow[]> {
  const snap = await adminDb
    .collection('companyDeletions')
    .where('companyId', '==', companyId)
    .orderBy('requestedAt', 'desc')
    .limit(COMPANY_HISTORY_LIMIT)
    .get()
  return snap.docs.map(mapDeletionDoc)
}

/**
 * Rows whose `state` is one of `states`, newest first. Used for both the
 * "in progress" segment (`['requested', 'executing']`) and the "stuck"
 * segment's coarse pre-filter (`['failed', 'executing']` — refined in
 * memory afterwards by `isStuckDeletion`, since Firestore can't express
 * "executing AND heartbeat stale" together with a state-`in` filter without
 * a second composite index this view doesn't otherwise need).
 *
 * Both callers share the one composite index on (state ASC, requestedAt
 * DESC) — a Firestore `in` query is evaluated as the union of per-value
 * equality queries against that same index, so one index serves every
 * `states` combination this function is called with.
 */
export async function queryDeletionsByStates(states: string[]): Promise<CompanyDeletionRow[]> {
  const snap = await adminDb
    .collection('companyDeletions')
    .where('state', 'in', states)
    .orderBy('requestedAt', 'desc')
    .limit(LIST_VIEW_LIMIT)
    .get()
  return snap.docs.map(mapDeletionDoc)
}

/**
 * Every ledger row, newest first — the "all history" segment. No composite
 * index needed: a single-field `orderBy` is covered by Firestore's
 * automatic per-field index.
 */
export async function queryAllDeletions(): Promise<CompanyDeletionRow[]> {
  const snap = await adminDb
    .collection('companyDeletions')
    .orderBy('requestedAt', 'desc')
    .limit(LIST_VIEW_LIMIT)
    .get()
  return snap.docs.map(mapDeletionDoc)
}
