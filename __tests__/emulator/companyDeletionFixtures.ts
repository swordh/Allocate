import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { adminAuth } from '@/lib/firebase-admin'

/**
 * The object literals below are written by hand to match
 * `CompanyDeletionDocument` and `CompanyDeletionMirror`
 * (functions/src/types.ts) — not imported, since functions/src is a
 * separate compilation unit with no path alias back to this one (see the
 * boundary notes in functions/src/companyStats.ts). Kept in lockstep
 * manually, same discipline as every other cross-boundary duplication in
 * this codebase.
 */
export interface SeededCompanyDeletion {
  companyId: string
  requestId: string
}

/**
 * Seeds a minimal `companies/{cid}` + `companyDeletions/{requestId}` pair in
 * the state the sweep/purge expect to find a `mode: 'window'` request in:
 * `deletion.state: 'requested'`, `scheduledFor` in the past (so the sweep's
 * overdue pass picks it up), zero `attempts`. Callers seed members and any
 * subtree data on top of this.
 */
export async function seedRequestedDeletion(
  db: Firestore,
  opts: {
    companyId: string
    requestId: string
    companyName?: string
    scheduledFor?: Timestamp
    attempts?: number
    completedPhases?: string[]
    phase?: string
    stripeCustomerId?: string
  },
): Promise<void> {
  const now = Timestamp.now()
  const scheduledFor = opts.scheduledFor ?? Timestamp.fromMillis(now.toMillis() - 60_000)
  const companyName = opts.companyName ?? 'Acme Film AB'

  await db.doc(`companies/${opts.companyId}`).set({
    name: companyName,
    createdAt: now,
    createdBy: 'requester-uid',
    stripeCustomerId: opts.stripeCustomerId ?? '',
    subscription: { status: 'active', plan: 'starter', currentPeriodEnd: now, limits: { equipment: 25, users: 10 } },
    deletion: {
      state: 'requested',
      requestId: opts.requestId,
      requestedAt: now,
      requestedByName: 'Requester Name',
      scheduledFor,
      mode: 'window',
    },
  })

  await db.doc(`companyDeletions/${opts.requestId}`).set({
    requestId: opts.requestId,
    companyId: opts.companyId,
    companyName,
    mode: 'window',
    state: 'requested',
    requestedAt: now,
    requestedByUid: 'requester-uid',
    requestedByName: 'Requester Name',
    requestedByEmail: 'requester@example.com',
    scheduledFor,
    attempts: opts.attempts ?? 0,
    ...(opts.phase ? { phase: opts.phase } : {}),
    ...(opts.completedPhases ? { completedPhases: opts.completedPhases } : {}),
    purgeAfter: Timestamp.fromMillis(now.toMillis() + 1000 * 60 * 60 * 24 * 30),
  })
}

/**
 * Seeds one `companies/{cid}/members/{uid}` doc plus the matching user-side
 * docs, AND a real Auth-emulator user for that uid. The real Auth user
 * matters since a PR E review: `cleanupOneMember` now treats a failed
 * `setCustomUserClaims` call as a genuine failure (it throws inside
 * `runMembersPhase`, per `claimsUpdated` — see memberCleanup.ts) rather than
 * silently swallowing it, so a member fixture with no real Auth record
 * would make every purge test touching her fail the members phase instead
 * of exercising the behavior under test.
 */
export async function seedMember(
  db: Firestore,
  companyId: string,
  uid: string,
  opts: { name?: string; email?: string; role?: 'admin' | 'crew' | 'viewer'; otherCompanyId?: string } = {},
): Promise<void> {
  const name = opts.name ?? `Member ${uid}`
  const email = opts.email ?? `${uid}@example.com`
  const role = opts.role ?? 'crew'

  try {
    await adminAuth.createUser({ uid, email })
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code
    if (code !== 'auth/uid-already-exists' && code !== 'auth/email-already-exists') throw err
  }

  await db.doc(`companies/${companyId}/members/${uid}`).set({ uid, name, email, role, joinedAt: Timestamp.now() })
  await db.doc(`users/${uid}/memberships/${companyId}`).set({ companyId, role, joinedAt: Timestamp.now() })
  await db.doc(`users/${uid}`).set(
    { name, email, activeCompanyId: companyId },
    { merge: true },
  )

  if (opts.otherCompanyId) {
    await db
      .doc(`users/${uid}/memberships/${opts.otherCompanyId}`)
      .set({ companyId: opts.otherCompanyId, role: 'crew', joinedAt: Timestamp.now() })
  }
}
