'use server'

import { randomBytes } from 'crypto'
import { revalidatePath } from 'next/cache'
import { WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { INVITE_TTL_DAYS } from '@/constants/invitation'
import { EMAIL_RE, MAX_RECIPIENTS, normalizeEmail, classifyRecipients, computeSeatsUsed } from '@/lib/invite-recipients'
import type { Role } from '@/types'
import type { Invitation, PublicInvitation } from '@/types/invitation'

const BATCH_LIMIT = 490

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
}

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
 * Used by `resendInvitation` — the team page's per-row RESEND button. There
 * used to be a second caller (`inviteUser`'s "already-pending" fallback),
 * but that branch is gone: `inviteUsers` now skips already-invited
 * addresses instead of silently resending, so this is the only remaining
 * caller.
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

/** Why a submitted recipient was NOT sent an invite. */
export type InviteSkipReason = 'member' | 'invited'

export interface InviteUsersResult {
  error?: string
  /** Newly created invitations — the real Firestore documents (minus `token`), one per address actually sent. */
  invitations?: PublicInvitation[]
  /** Addresses that were NOT invited, and why — already a member, or already has a pending invite. */
  skipped?: { email: string; reason: InviteSkipReason }[]
}

/**
 * Invite up to `MAX_RECIPIENTS` addresses at once, all under one role.
 *
 * Replaces the old single-address `inviteUser`. There is no resend
 * fallback here — an address with an existing pending invite (regardless of
 * expiry — see the pending-query note below) is skipped, never resent.
 * Resending happens exclusively through the dedicated `resendInvitation`
 * action (the per-row RESEND button).
 *
 * The expensive reads (inviter/company docs, the full members collection,
 * the full pending-invitations collection) happen exactly once regardless
 * of how many addresses were submitted; only the seat guard and the writes
 * scale with N.
 */
export async function inviteUsers(emails: string[], role: Role): Promise<InviteUsersResult> {
  // ── 1. Auth-guard ────────────────────────────────────────────────────────────
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const cid = session.activeCompanyId
  if (!cid) return { error: 'No active company' }

  // ── 2. Harden input — never trust the client's parser ────────────────────────
  if (!Array.isArray(emails)) return { error: 'Invalid recipient list.' }

  const submittedRole: Role = ALLOWED_ROLES.includes(role) ? role : 'crew'

  const seen = new Set<string>()
  const normalizedEmails: string[] = []
  for (const raw of emails) {
    if (typeof raw !== 'string') continue
    const email = normalizeEmail(raw)
    if (email.length === 0 || email.length > 254) continue
    if (!EMAIL_RE.test(email)) continue
    if (seen.has(email)) continue
    seen.add(email)
    normalizedEmails.push(email)
  }

  if (normalizedEmails.length === 0) return { error: 'Enter at least one valid email address.' }
  if (normalizedEmails.length > MAX_RECIPIENTS) {
    return { error: `Too many recipients — max ${MAX_RECIPIENTS} per batch.` }
  }

  // App URL is required to build the accept link.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    console.error('[actions/team]', { companyId: cid, action: 'invite_users', error: 'NEXT_PUBLIC_APP_URL not set' })
    return { error: 'Server is misconfigured — please contact support.' }
  }

  // ── 3. Four reads total, regardless of N ──────────────────────────────────────
  // Replaces both the old per-address "already a member?" query and the
  // three count() aggregates the seat guard used to run: the two collection
  // reads below give exact counts AND the email sets needed for
  // classification in one pass.
  const [inviterSnap, companySnap, membersSnap, pendingSnap] = await Promise.all([
    adminDb.doc(`companies/${cid}/members/${session.uid}`).get(),
    adminDb.doc(`companies/${cid}`).get(),
    adminDb.collection(`companies/${cid}/members`).get(),
    adminDb.collection(`companies/${cid}/invitations`).where('status', '==', 'pending').get(),
  ])

  const inviterName = (inviterSnap.data()?.name as string) || session.email || 'A teammate'
  const companyName = (companySnap.data()?.name as string) || 'your team'

  // `docToMember` (lib/queries/members.ts) doesn't lowercase email — do it here.
  const memberEmails = new Set(
    membersSnap.docs
      .map((doc) => (doc.data().email as string | undefined)?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
  )

  const pendingDocs = pendingSnap.docs.map((doc) => doc.data() as Invitation)
  // Skip rule: any address with a `status == 'pending'` invite is skipped,
  // regardless of expiry. Treating an expired pending invite as "free to
  // re-invite" would create a second pending doc for the same address,
  // double-counting it in every future seat calculation and showing two
  // rows in the pending list — the address is still visible with its own
  // RESEND button, which is exactly where re-sending an expired link belongs.
  const invitedEmails = new Set(pendingDocs.map((doc) => doc.email.toLowerCase()))

  // ── 4. Classify ────────────────────────────────────────────────────────────
  const classified = classifyRecipients(normalizedEmails, { members: memberEmails, invited: invitedEmails })

  const toCreate: string[] = []
  const skipped: { email: string; reason: InviteSkipReason }[] = []
  for (const c of classified) {
    if (c.state === 'new') toCreate.push(c.email)
    else skipped.push({ email: c.email, reason: c.state })
  }

  if (toCreate.length === 0) {
    return { invitations: [], skipped }
  }

  // ── 5. Seat guard — evaluated ONCE, against a snapshot PLUS the batch size,
  // before any write. Running the old per-address count() guard in a loop
  // would let N invitations through against a single free seat, since
  // uncommitted writes are invisible to count(). ─────────────────────────────
  const seatLimit = (companySnap.data()?.subscription?.limits?.users) as number | undefined

  if (typeof seatLimit === 'number') {
    const seatsUsed = computeSeatsUsed(membersSnap.size, pendingDocs)
    if (seatsUsed + toCreate.length > seatLimit) {
      return {
        error: `Seat limit reached (${seatLimit}). Upgrade your plan or revoke unused invitations to add more.`,
      }
    }
  } else {
    console.error('[actions/team]', {
      companyId: cid,
      action: 'invite_users_seat_guard',
      error: 'subscription.limits.users missing or not a number — skipping seat guard',
    })
  }

  // ── 6. Build the batch, commit once — invite doc, mirror doc, AND mail doc
  // for every address, all in the same WriteBatch. A batch is atomic, so it's
  // impossible to mail an accept link to an invite document that doesn't
  // exist (the unrecoverable failure mode: /invite/{token} 404s with no way
  // forward for the invitee). `onMailQueued` is an onDocumentCreated trigger
  // and fires the same way on batched creates.
  // 25 addresses × 3 writes = 75, well under BATCH_LIMIT (490) — no chunking. ─
  const nowIso = new Date().toISOString()
  const expiresAt = newExpiresAt()
  const batch = adminDb.batch()
  const invitations: PublicInvitation[] = []

  for (const email of toCreate) {
    const token = randomBytes(16).toString('hex') // 32-char alphanumeric token (matches [a-zA-Z0-9] across the accept flow)
    const inviteRef = adminDb.collection(`companies/${cid}/invitations`).doc()
    const mirrorRef = adminDb.collection('invitations').doc(token)
    const mailRef = adminDb.collection('mail').doc()

    // Full record — read by acceptInvitationByToken (role) and revocation later.
    batch.set(inviteRef, {
      id: inviteRef.id,
      email,
      role: submittedRole,
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
    // Enqueued mail — sent by the onMailQueued Cloud Function.
    const acceptUrl = `${appUrl.replace(/\/$/, '')}/invite/${token}`
    batch.set(mailRef, {
      to: email,
      template: 'invitation',
      data: { companyName, inviterName, acceptUrl, role: submittedRole },
      status: 'queued',
      createdAt: nowIso,
    })

    invitations.push({
      id: inviteRef.id,
      email,
      role: submittedRole,
      invitedBy: session.uid,
      invitedByName: inviterName,
      invitedAt: nowIso,
      status: 'pending',
      expiresAt,
    })
  }

  await batch.commit()

  revalidatePath('/settings/team')
  console.log('[actions/team]', {
    uid: session.uid.slice(0, 8) + '...',
    companyId: cid,
    action: 'invite_users',
    count: invitations.length,
    skipped: skipped.length,
  })

  return { invitations, skipped }
}

/**
 * Dedicated resend for the team page's per-row RESEND button — lets the UI
 * resend without re-posting the whole invite form. This is now the ONLY
 * caller of `extendPendingInvite` — `inviteUsers` has no resend branch of
 * its own, it skips already-invited addresses instead.
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
