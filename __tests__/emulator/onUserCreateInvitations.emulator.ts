/**
 * Issue #396 — `onUserCreate` (functions/src/auth/onUserCreate.ts) used to
 * auto-join a brand-new signup into any company with a pending invitation
 * matching their email. That's an invitation-hijack: for the app's actual
 * signup flow (components/auth/SignupForm.tsx,
 * `createUserWithEmailAndPassword`), `user.email` on this trigger is
 * UNVERIFIED, and nothing checked `email_verified`, so anyone who knew an
 * invitee's address could sign up as them and get a member doc, custom
 * claims, and the Firestore read access that comes with both. Fixed by
 * making `onUserCreate` a no-op — see its doc comment for the full
 * reasoning and what reinstating auto-join would require. This test proves
 * the no-op: seed exactly the setup that used to trigger auto-join (a
 * private invite + its mirror, active company) and confirm nothing happens.
 *
 * `onUserCreate` is a firebase-functions v1 `.auth.user().onCreate(handler)`
 * trigger. Its exported CloudFunction carries a `.run(data, context)` that
 * invokes the handler directly (see firebase-functions/lib/v1/cloud-functions.js)
 * — no firebase-functions-test wrapping needed. `data` is a real UserRecord
 * (fetched via `adminAuth.getUser` after `createUser`, not hand-built)
 * since the handler reads `.uid` off it; `context` is unused, so an empty
 * object stands in for it.
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
  token: string
  role?: string
}) {
  const expiresAt = new Date(Date.now() + 24 * HOUR).toISOString()
  await adminDb.doc(`companies/${opts.companyId}/invitations/${opts.inviteId}`).set({
    id: opts.inviteId,
    email: opts.email,
    role: opts.role ?? 'crew',
    invitedBy: 'someone-else',
    invitedByName: 'Someone Else',
    invitedAt: new Date().toISOString(),
    status: 'pending',
    token: opts.token,
    expiresAt,
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

async function runOnUserCreate(user: unknown) {
  await (onUserCreate as unknown as { run: (data: unknown, context: unknown) => Promise<unknown> }).run(user, {})
}

describe('onUserCreate is a no-op (issue #396)', () => {
  it('signup matching a pending private invite + its mirror in an active company creates nothing and throws nothing', async () => {
    const uid = 'new-user-1'
    const email = 'invitee-1@example.com'
    const companyId = 'active-co'
    const inviteId = 'invite-1'
    const token = 'token-'.repeat(4) + 'aaaa'

    await seedActiveCompany(companyId, 'Active Co')
    await seedPrivateInvite({ companyId, inviteId, email, token, role: 'admin' })
    await seedMirror({ token, companyId, inviteId, email })

    const user = await createAuthUser(uid, email)
    await expect(runOnUserCreate(user)).resolves.not.toThrow()

    const memberSnap = await adminDb.doc(`companies/${companyId}/members/${uid}`).get()
    expect(memberSnap.exists).toBe(false)

    const membershipSnap = await adminDb.doc(`users/${uid}/memberships/${companyId}`).get()
    expect(membershipSnap.exists).toBe(false)

    const privateInviteSnap = await adminDb.doc(`companies/${companyId}/invitations/${inviteId}`).get()
    expect(privateInviteSnap.data()?.status).toBe('pending')

    const mirrorSnap = await adminDb.doc(`invitations/${token}`).get()
    expect(mirrorSnap.data()?.status).toBe('pending')

    const updatedUser = await adminAuth.getUser(uid)
    expect(updatedUser.customClaims?.activeCompanyId).toBeUndefined()
    expect(updatedUser.customClaims?.role).toBeUndefined()

    const userDocSnap = await adminDb.doc(`users/${uid}`).get()
    expect(userDocSnap.data()?.activeCompanyId).toBeUndefined()
  })
})
