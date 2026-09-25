/**
 * Issue #396 — `onUserCreate` (functions/src/auth/onUserCreate.ts) used to
 * read `companyId` off the invitation doc's own fields. The private
 * `companies/{cid}/invitations/{id}` doc (written by actions/team.ts) has no
 * such field — only its public mirror at `invitations/{token}` does — so
 * every real signup-with-a-pending-invite read `undefined`, wrote to
 * `companies/undefined`, and silently never joined the company. Fixed by
 * deriving `companyId` from the doc's own path instead.
 *
 * `onUserCreate` is a firebase-functions v1 `.auth.user().onCreate(handler)`
 * trigger. Its exported CloudFunction carries a `.run(data, context)` that
 * invokes the handler directly (see firebase-functions/lib/v1/cloud-functions.js)
 * — no firebase-functions-test wrapping needed, same "trigger is a thin
 * wrapper" property blockMemberWrite's own doc comment relies on. `data` is
 * a real UserRecord (fetched via `adminAuth.getUser` after `createUser`, not
 * hand-built) since the handler reads `.email`/`.uid`/`.displayName`/
 * `.customClaims` off it; `context` is unused by the handler (it destructures
 * only `user`), so an empty object stands in for it.
 */
import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { onUserCreate } from '../../functions/src/auth/onUserCreate'

const HOUR = 60 * 60 * 1000

async function seedActiveCompany(companyId: string, name: string) {
  await adminDb.doc(`companies/${companyId}`).set({
    name,
    createdAt: Timestamp.now(),
    createdBy: 'someone-else',
    stripeCustomerId: '',
    subscription: {
      status: 'active',
      plan: 'starter',
      currentPeriodEnd: null,
      limits: { equipment: 25, users: 10 },
    },
  })
}

async function seedPrivateInvite(opts: {
  companyId: string
  inviteId: string
  email: string
  token?: string
  role?: string
}) {
  const expiresAt = new Date(Date.now() + 24 * HOUR).toISOString()
  // `token` is only spread in when provided — the Admin SDK throws on an
  // explicit `undefined` field value (no `ignoreUndefinedProperties` set),
  // so a "missing token" fixture has to omit the key entirely, matching
  // what a real hand-edited/corrupt doc would look like.
  await adminDb.doc(`companies/${opts.companyId}/invitations/${opts.inviteId}`).set({
    id: opts.inviteId,
    email: opts.email,
    role: opts.role ?? 'crew',
    invitedBy: 'someone-else',
    invitedByName: 'Someone Else',
    invitedAt: new Date().toISOString(),
    status: 'pending',
    expiresAt,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  })
}

async function seedMirror(opts: { token: string; companyId: string; inviteId: string; email: string }) {
  const expiresAt = new Date(Date.now() + 24 * HOUR).toISOString()
  await adminDb.doc(`invitations/${opts.token}`).set({
    companyId: opts.companyId,
    inviteId: opts.inviteId,
    email: opts.email,
    status: 'pending',
    expiresAt,
  })
}

/** Creates the Auth user and returns the real UserRecord onUserCreate.run expects. */
async function createAuthUser(uid: string, email: string) {
  await adminAuth.createUser({ uid, email })
  return adminAuth.getUser(uid)
}

describe('onUserCreate invitation processing (issue #396)', () => {
  it('accepts a private invite + its mirror for an active company: member, membership, both invites accepted, claims set', async () => {
    const uid = 'new-user-1'
    const email = 'invitee-1@example.com'
    const companyId = 'active-co'
    const inviteId = 'invite-1'
    const token = 'token-'.repeat(4) + 'aaaa'

    await seedActiveCompany(companyId, 'Active Co')
    await seedPrivateInvite({ companyId, inviteId, email, token, role: 'admin' })
    await seedMirror({ token, companyId, inviteId, email })

    const user = await createAuthUser(uid, email)
    await (onUserCreate as unknown as { run: (data: unknown, context: unknown) => Promise<unknown> }).run(
      user,
      {},
    )

    const memberSnap = await adminDb.doc(`companies/${companyId}/members/${uid}`).get()
    expect(memberSnap.exists).toBe(true)
    expect(memberSnap.data()?.role).toBe('admin')

    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/${companyId}`).get()
    expect(membershipSnap.exists).toBe(true)
    expect(membershipSnap.data()?.companyId).toBe(companyId)

    const privateInviteSnap = await adminDb.doc(`companies/${companyId}/invitations/${inviteId}`).get()
    expect(privateInviteSnap.data()?.status).toBe('accepted')

    const mirrorSnap = await adminDb.doc(`invitations/${token}`).get()
    expect(mirrorSnap.data()?.status).toBe('accepted')

    const updatedUser = await adminAuth.getUser(uid)
    expect(updatedUser.customClaims?.activeCompanyId).toBe(companyId)
    expect(updatedUser.customClaims?.role).toBe('admin')

    const userDocSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userDocSnap.data()?.activeCompanyId).toBe(companyId)
  })

  it('does not create a member, accept the invite, or set claims when the company is blocked (pending deletion)', async () => {
    const uid = 'new-user-2'
    const email = 'invitee-2@example.com'
    const companyId = 'blocked-co'
    const inviteId = 'invite-2'
    const token = 'token-'.repeat(4) + 'bbbb'

    await adminDb.doc(`companies/${companyId}`).set({
      name: 'Blocked Co',
      createdAt: Timestamp.now(),
      createdBy: 'someone-else',
      stripeCustomerId: '',
      subscription: {
        status: 'active',
        plan: 'starter',
        currentPeriodEnd: null,
        limits: { equipment: 25, users: 10 },
      },
      deletion: {
        state: 'requested',
        requestId: 'req-1',
        requestedAt: Timestamp.now(),
        requestedByName: 'Anna Admin',
        scheduledFor: Timestamp.fromMillis(Date.now() + 7 * 24 * HOUR),
        mode: 'window',
      },
    })
    await seedPrivateInvite({ companyId, inviteId, email, token })
    await seedMirror({ token, companyId, inviteId, email })

    const user = await createAuthUser(uid, email)
    await (onUserCreate as unknown as { run: (data: unknown, context: unknown) => Promise<unknown> }).run(
      user,
      {},
    )

    const memberSnap = await adminDb.doc(`companies/${companyId}/members/${uid}`).get()
    expect(memberSnap.exists).toBe(false)

    const privateInviteSnap = await adminDb.doc(`companies/${companyId}/invitations/${inviteId}`).get()
    expect(privateInviteSnap.data()?.status).toBe('pending')

    const mirrorSnap = await adminDb.doc(`invitations/${token}`).get()
    expect(mirrorSnap.data()?.status).toBe('pending')

    const updatedUser = await adminAuth.getUser(uid)
    expect(updatedUser.customClaims?.activeCompanyId).toBeUndefined()

    const userDocSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userDocSnap.data()?.activeCompanyId).toBeUndefined()
  })

  it('a malformed invitation (missing token) does not stop another valid invitation in the same batch from being accepted', async () => {
    const uid = 'new-user-3'
    const email = 'invitee-3@example.com'
    const goodCompanyId = 'good-co'
    const badCompanyId = 'bad-co'
    const goodInviteId = 'invite-good'
    const badInviteId = 'invite-bad'
    const goodToken = 'token-'.repeat(4) + 'cccc'

    await seedActiveCompany(goodCompanyId, 'Good Co')
    await seedActiveCompany(badCompanyId, 'Bad Co')

    // Malformed: no token at all (e.g. a hand-edited or corrupt doc) — the
    // mirror update must be skipped rather than throwing and aborting the
    // whole invitation, and processing must continue to the next invite.
    await seedPrivateInvite({ companyId: badCompanyId, inviteId: badInviteId, email, token: undefined })
    await seedPrivateInvite({ companyId: goodCompanyId, inviteId: goodInviteId, email, token: goodToken })
    await seedMirror({ token: goodToken, companyId: goodCompanyId, inviteId: goodInviteId, email })

    const user = await createAuthUser(uid, email)
    await (onUserCreate as unknown as { run: (data: unknown, context: unknown) => Promise<unknown> }).run(
      user,
      {},
    )

    // The malformed invite's own company gets no member, but its status
    // still flips to accepted — the transaction for it completes fully
    // (there was simply no mirror to also update), it just never throws.
    const badMemberSnap = await adminDb.doc(`companies/${badCompanyId}/members/${uid}`).get()
    expect(badMemberSnap.exists).toBe(true)
    const badInviteSnap = await adminDb.doc(`companies/${badCompanyId}/invitations/${badInviteId}`).get()
    expect(badInviteSnap.data()?.status).toBe('accepted')

    // The good invitation, processed after the malformed one in the same
    // loop, is unaffected.
    const goodMemberSnap = await adminDb.doc(`companies/${goodCompanyId}/members/${uid}`).get()
    expect(goodMemberSnap.exists).toBe(true)
    const goodInviteSnap = await adminDb.doc(`companies/${goodCompanyId}/invitations/${goodInviteId}`).get()
    expect(goodInviteSnap.data()?.status).toBe('accepted')
    const goodMirrorSnap = await adminDb.doc(`invitations/${goodToken}`).get()
    expect(goodMirrorSnap.data()?.status).toBe('accepted')
  })
})
