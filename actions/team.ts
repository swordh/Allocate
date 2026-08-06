'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { INVITE_TTL_DAYS } from '@/constants/invitation'
import type { Role } from '@/types'
import type { PublicInvitation } from '@/types/invitation'

const BATCH_LIMIT = 490

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ALLOWED_ROLES: Role[] = ['admin', 'crew', 'viewer']

function newExpiresAt(): string {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Shared resend step: pushes `expiresAt` out on both the private doc and the
 * public mirror, and stamps `lastSentAt` on the private doc so the UI can
 * show "Invite re-sent just now" (`lib/invite-status.ts:inviteMeta`). The
 * mirror intentionally does NOT get `lastSentAt` — it's a minimal public
 * lookup doc and nothing reads that field from it.
 *
 * Used by both `inviteUser`'s "already-pending" fallback and the dedicated
 * `resendInvitation` action, so the two paths cannot drift.
 */
async function extendPendingInvite(
  cid: string,
  inviteId: string,
  token: string,
): Promise<{ expiresAt: string; lastSentAt: string }> {
  const expiresAt = newExpiresAt()
  const lastSentAt = new Date().toISOString()

  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)
  const mirrorRef = adminDb.collection('invitations').doc(token)

  const batch = adminDb.batch()
  batch.update(inviteRef, { expiresAt, lastSentAt })
  batch.update(mirrorRef, { expiresAt })
  await batch.commit()

  return { expiresAt, lastSentAt }
}

/**
 * Result of `inviteUser`. On success, `invitation` is the real Firestore
 * document (minus `token` — never shipped to the client, see the header
 * comment on `PublicInvitation`), so the caller can render/append a real
 * row instead of fabricating one from the submitted form values.
 *
 * `created` distinguishes the two branches `inviteUser` can take:
 * - `true`  — a brand-new invitation was created; it consumes a new seat.
 * - `false` — an existing pending invite for that email was resent;
 *   the seat was already held, so the caller must NOT increment its count.
 */
type InviteUserResult =
  | { error: string; invitation?: undefined; created?: undefined }
  | { error?: undefined; invitation: PublicInvitation; created: boolean }

export async function inviteUser(formData: FormData): Promise<InviteUserResult> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Validate email ──────────────────────────────────────────────────────────
  const rawEmail = formData.get('email')
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' }

  // ── 3. Guard: already a member ──────────────────────────────────────────────────
  const memberSnap = await adminDb
    .collection(`companies/${cid}/members`)
    .where('email', '==', email)
    .limit(1)
    .get()
  if (!memberSnap.empty) {
    return { error: 'That person is already a member of this company.' }
  }

  // App URL is required to build the accept link.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('[actions/team]', { companyId: cid, action: 'invite_user', error: 'NEXT_PUBLIC_APP_URL not set' })
    return { error: 'Server is misconfigured — please contact support.' }
  }

  // Resolve inviter name + company name for the email body.
  const [inviterSnap, companySnap] = await Promise.all([
    adminDb.doc(`companies/${cid}/members/${session.uid}`).get(),
    adminDb.doc(`companies/${cid}`).get(),
  ])
  const inviterName = (inviterSnap.data()?.name as string) || session.email || 'A teammate'
  const companyName = (companySnap.data()?.name as string) || 'your team'

  // Role for a NEW invite — never trust the client value without this
  // allowlist. Falls back to 'crew' for a missing/invalid value.
  const rawRole = formData.get('role')
  const submittedRole: Role = ALLOWED_ROLES.includes(rawRole as Role) ? (rawRole as Role) : 'crew'

  // ── 4. Reuse an existing pending invite, else create a new one ──────────────────
  const pendingSnap = await adminDb
    .collection(`companies/${cid}/invitations`)
    .where('email', '==', email)
    .where('status', '==', 'pending')
    .limit(1)
    .get()

  let token: string
  let role: Role
  let resent = false
  let invitation: PublicInvitation

  if (!pendingSnap.empty) {
    // A pending invite already exists — resend its link rather than duplicate.
    // Role stays whatever the existing invite already had; resending doesn't
    // re-submit a role choice. Extending expiresAt matters because without it,
    // resending an invitation older than INVITE_TTL_DAYS would re-send a link
    // that is already dead — shares the batch logic with resendInvitation()
    // below so the two paths cannot drift.
    const pendingDoc = pendingSnap.docs[0]
    const pendingData = pendingDoc.data()
    token = pendingData.token as string
    role = (pendingData.role as Role) ?? 'crew'
    resent = true

    const { expiresAt, lastSentAt } = await extendPendingInvite(cid, pendingDoc.id, token)

    // Round-trip the real doc (minus token) rather than fabricating a row
    // client-side — id, invitedAt etc. must reflect what's actually stored.
    invitation = {
      id: pendingDoc.id,
      email,
      role,
      invitedBy: pendingData.invitedBy as string,
      invitedByName: pendingData.invitedByName as string,
      invitedAt: pendingData.invitedAt as string,
      status: 'pending',
      expiresAt,
      lastSentAt,
    }
  } else {
    // ── Seat guard — members + active (non-expired) pending invitations
    // count against subscription.limits.users. An expired-but-still-`pending`
    // invitation (status not yet flipped by anything, since nothing sweeps
    // it) must NOT permanently consume a seat, so it's excluded via a count
    // aggregate rather than fetched and filtered in memory.
    const seatLimit = (companySnap.data()?.subscription?.limits?.users) as number | undefined

    if (typeof seatLimit === 'number') {
      const nowIso = new Date().toISOString()
      const [memberCountSnap, totalPendingSnap, expiredPendingSnap] = await Promise.all([
        adminDb.collection(`companies/${cid}/members`).count().get(),
        adminDb
          .collection(`companies/${cid}/invitations`)
          .where('status', '==', 'pending')
          .count()
          .get(),
        adminDb
          .collection(`companies/${cid}/invitations`)
          .where('status', '==', 'pending')
          .where('expiresAt', '<', nowIso)
          .count()
          .get(),
      ])

      const memberCount = memberCountSnap.data().count
      const activePendingCount = totalPendingSnap.data().count - expiredPendingSnap.data().count
      const seatsUsed = memberCount + activePendingCount

      if (seatsUsed >= seatLimit) {
        return {
          error: `Seat limit reached (${seatLimit}). Upgrade your plan or revoke unused invitations to add more.`,
        }
      }
    } else {
      console.error('[actions/team]', {
        companyId: cid,
        action: 'invite_user_seat_guard',
        error: 'subscription.limits.users missing or not a number — skipping seat guard',
      })
    }

    role = submittedRole
    token = randomBytes(16).toString('hex') // 32-char alphanumeric token (matches [a-zA-Z0-9] across the accept flow)
    const nowIso = new Date().toISOString()
    const expiresAt = newExpiresAt()

    const inviteRef = adminDb.collection(`companies/${cid}/invitations`).doc()
    const mirrorRef = adminDb.collection('invitations').doc(token)

    const batch = adminDb.batch()
    // Full record — read by acceptInvitationByToken (role) and revocation later.
    batch.set(inviteRef, {
      id: inviteRef.id,
      email,
      role,
      invitedBy: session.uid,
      invitedByName: inviterName,
      invitedAt: nowIso,
      status: 'pending',
      token,
      expiresAt,
    })
    // Public mirror — resolved by the /invite/{token} page and accept callable.
    batch.set(mirrorRef, {
      companyId: cid,
      inviteId: inviteRef.id,
      email,
      status: 'pending',
      expiresAt,
    })
    await batch.commit()

    invitation = {
      id: inviteRef.id,
      email,
      role,
      invitedBy: session.uid,
      invitedByName: inviterName,
      invitedAt: nowIso,
      status: 'pending',
      expiresAt,
    }
  }

  // ── 5. Enqueue the email — sent by the onMailQueued Cloud Function ───────────────
  const acceptUrl = `${appUrl.replace(/\/$/, '')}/invite/${token}`
  await adminDb.collection('mail').add({
    to: email,
    template: 'invitation',
    data: { companyName, inviterName, acceptUrl, role },
    status: 'queued',
    createdAt: new Date().toISOString(),
  })

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    action: resent ? 'invite_user_resend' : 'invite_user',
  })
  return { invitation, created: !resent }
}

/**
 * Dedicated resend for the team page's per-row RESEND button — lets the UI
 * resend without re-posting the whole invite form. Reuses the same
 * `extendPendingInvite` batch as `inviteUser`'s resend fallback above, so the
 * two paths cannot drift.
 */
export async function resendInvitation(inviteId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Read the private doc FIRST — it's what gives us the token for the
  // mirror path. Never accept a token from the client. ─────────────────────────
  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)
  const inviteSnap = await inviteRef.get()
  if (!inviteSnap.exists) return { error: 'Invitation not found' }

  const inviteData = inviteSnap.data()!
  if (inviteData.status !== 'pending') {
    return { error: 'Only pending invitations can be resent' }
  }

  const token = inviteData.token as string
  const email = inviteData.email as string
  const role = (inviteData.role as Role) ?? 'crew'
  const inviterName = (inviteData.invitedByName as string) || 'A teammate'

  // App URL is required to rebuild the accept link.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('[actions/team]', { companyId: cid, action: 'resend_invitation', error: 'NEXT_PUBLIC_APP_URL not set' })
    return { error: 'Server is misconfigured — please contact support.' }
  }

  // ── 3. Extend expiry + stamp lastSentAt ───────────────────────────────────────
  await extendPendingInvite(cid, inviteId, token)

  // ── 4. Re-queue the email ──────────────────────────────────────────────────────
  const companySnap = await adminDb.doc(`companies/${cid}`).get()
  const companyName = (companySnap.data()?.name as string) || 'your team'
  const acceptUrl = `${appUrl.replace(/\/$/, '')}/invite/${token}`

  await adminDb.collection('mail').add({
    to: email,
    template: 'invitation',
    data: { companyName, inviterName, acceptUrl, role },
    status: 'queued',
    createdAt: new Date().toISOString(),
  })

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    inviteId,
    action: 'resend_invitation',
  })

  return {}
}

export async function updateMemberRole(
  memberId: string,
  newRole: Role,
): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const validRoles: Role[] = ['admin', 'crew', 'viewer']
  if (!validRoles.includes(newRole)) return { error: 'Invalid role' }

  if (memberId === session.uid) return { error: "You can't change your own role" }

  const companyId = session.activeCompanyId

  const memberRef         = adminDb.doc(`companies/${companyId}/members/${memberId}`)
  const userMembershipRef = adminDb.doc(`users/${memberId}/memberships/${companyId}`)

  const batch = adminDb.batch()
  batch.update(memberRef, { role: newRole })
  batch.update(userMembershipRef, { role: newRole })
  await batch.commit()

  const authUser = await adminAuth.getUser(memberId)
  const claims = (authUser.customClaims ?? {}) as Record<string, unknown>
  if (claims['activeCompanyId'] === companyId) {
    await adminAuth.setCustomUserClaims(memberId, {
      activeCompanyId: companyId,
      role: newRole,
    })
  }

  revalidatePath('/settings/team')
  return {}
}

export async function removeMember(memberId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // Self-removal is not allowed — admin must use "leave company" or delete account
  if (memberId === session.uid) return { error: 'You cannot remove yourself. Use "Leave company" instead.' }

  // ── 2. Sole-admin guard ──────────────────────────────────────────────────────
  const targetMemberSnap = await adminDb.doc(`companies/${cid}/members/${memberId}`).get()
  if (!targetMemberSnap.exists) return { error: 'Member not found' }

  const targetData = targetMemberSnap.data()!
  if (targetData.role === 'admin') {
    const adminCountSnap = await adminDb
      .collection(`companies/${cid}/members`)
      .where('role', '==', 'admin')
      .count()
      .get()
    if (adminCountSnap.data().count <= 1) {
      return { error: 'Cannot remove the only admin. Promote another member first.' }
    }
  }

  // ── 3. Delete membership documents (atomic WriteBatch) ───────────────────────
  let batch = adminDb.batch()
  let opCount = 0

  async function addOp(
    ref: FirebaseFirestore.DocumentReference,
    data: Record<string, null | string>,
  ) {
    batch.update(ref, data)
    opCount++
    if (opCount >= BATCH_LIMIT) {
      batch = await commitAndReset(batch)
      opCount = 0
    }
  }

  batch.delete(adminDb.doc(`companies/${cid}/members/${memberId}`))
  opCount++
  batch.delete(adminDb.doc(`users/${memberId}/memberships/${cid}`))
  opCount++

  // ── 4. Anonymize uid-references scoped to this company ───────────────────────
  const bookingsRef  = adminDb.collection(`companies/${cid}/bookings`)
  const equipmentRef = adminDb.collection(`companies/${cid}/equipment`)
  const companyRef   = adminDb.doc(`companies/${cid}`)

  // Bookings: userId
  const byUserId = await bookingsRef.where('userId', '==', memberId).get()
  for (const doc of byUserId.docs) await addOp(doc.ref, { userId: null, userName: null })

  // Bookings: cancelledBy
  const byCancelledBy = await bookingsRef.where('cancelledBy', '==', memberId).get()
  for (const doc of byCancelledBy.docs) await addOp(doc.ref, { cancelledBy: null })

  // Bookings: approverId
  const byApproverId = await bookingsRef.where('approverId', '==', memberId).get()
  for (const doc of byApproverId.docs) await addOp(doc.ref, { approverId: null })

  // Equipment: createdBy
  const byCreatedBy = await equipmentRef.where('createdBy', '==', memberId).get()
  for (const doc of byCreatedBy.docs) await addOp(doc.ref, { createdBy: null })

  // Equipment: approverId
  const byEquipmentApprover = await equipmentRef.where('approverId', '==', memberId).get()
  for (const doc of byEquipmentApprover.docs) await addOp(doc.ref, { approverId: null })

  // Units: iterate equipment subcollections directly — avoids collectionGroup index requirement
  const allEquipmentSnap = await equipmentRef.get()
  for (const eqDoc of allEquipmentSnap.docs) {
    const unitsSnap = await eqDoc.ref.collection('units').get()
    for (const doc of unitsSnap.docs) {
      const data = doc.data()
      const updates: Record<string, null> = {}
      if (data.createdBy === memberId)     updates.createdBy = null
      if (data.updatedBy === memberId)     updates.updatedBy = null
      if (data.deactivatedBy === memberId) updates.deactivatedBy = null
      if (Object.keys(updates).length > 0) await addOp(doc.ref, updates)
    }
  }

  // Company doc: createdBy
  const companySnap = await companyRef.get()
  if (companySnap.exists && companySnap.data()?.createdBy === memberId) {
    await addOp(companyRef, { createdBy: null })
  }

  await batch.commit()

  // ── 5. Handle target's activeCompanyId server-side ───────────────────────────
  try {
    const targetUserSnap = await adminDb.doc(`users/${memberId}`).get()
    const targetUser = targetUserSnap.data() ?? {}

    if (targetUser.activeCompanyId === cid) {
      // List remaining memberships after removal
      const remainingMembershipsSnap = await adminDb
        .collection(`users/${memberId}/memberships`)
        .get()

      if (remainingMembershipsSnap.docs.length > 0) {
        const next = remainingMembershipsSnap.docs[0].data()
        const nextCompanyId = next.companyId as string
        const nextRole      = next.role as string

        await adminDb.doc(`users/${memberId}`).update({ activeCompanyId: nextCompanyId })
        await adminAuth.setCustomUserClaims(memberId, {
          activeCompanyId: nextCompanyId,
          role: nextRole,
        })
      } else {
        await adminDb.doc(`users/${memberId}`).update({ activeCompanyId: null })
        await adminAuth.setCustomUserClaims(memberId, {
          activeCompanyId: null,
          role: null,
        })
      }
    }
  } catch (err) {
    // Non-fatal: log and continue — membership is already revoked
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/team]', {
      target: memberId.slice(0, 8) + '...',
      companyId: cid,
      error: message,
      action: 'remove_member_claims_update_failed',
    })
  }

  // ── 6. Revalidate + log ──────────────────────────────────────────────────────
  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid:       session.uid.slice(0, 8) + '...',
    target:    memberId.slice(0, 8) + '...',
    companyId: cid,
    action:    'remove_member',
  })

  return {}
}

export async function revokeInvitation(inviteId: string): Promise<{ error?: string }> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Read the private doc FIRST — it's what gives us the token for the
  // mirror path. Never accept a token from the client. ─────────────────────────
  const inviteRef = adminDb.doc(`companies/${cid}/invitations/${inviteId}`)
  const inviteSnap = await inviteRef.get()
  if (!inviteSnap.exists) return { error: 'Invitation not found' }

  const inviteData = inviteSnap.data()!
  if (inviteData.status !== 'pending') {
    return { error: 'Only pending invitations can be revoked' }
  }

  const token = inviteData.token as string
  const mirrorRef = adminDb.collection('invitations').doc(token)

  // ── 3. Batch-update both documents ────────────────────────────────────────────
  const nowIso = new Date().toISOString()
  const batch = adminDb.batch()
  batch.update(inviteRef, {
    status: 'revoked',
    revokedAt: nowIso,
    revokedBy: session.uid,
  })
  batch.update(mirrorRef, { status: 'revoked' })
  await batch.commit()

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid:       session.uid.slice(0, 8) + '...',
    companyId: cid,
    inviteId,
    action:    'revoke_invitation',
  })

  return {}
}
