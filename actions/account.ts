'use server'

import { createHash } from 'crypto'
import { revalidatePath } from 'next/cache'
import { FieldValue, WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { normalizeEmail } from '@/lib/invite-recipients'
import { stripe } from '@/lib/stripe'
import { deleteSession } from './auth'

const BATCH_LIMIT = 490

async function commitAndReset(batch: WriteBatch): Promise<WriteBatch> {
  await batch.commit()
  return adminDb.batch()
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

export async function deleteAccount(): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  const uid = session.uid

  // ── 1. Sole-admin guard ────────────────────────────────────────────────────
  // Block if this user is the only admin of ANY company they belong to.
  let membershipsSnap: FirebaseFirestore.QuerySnapshot
  try {
    membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()
    const adminMemberships = membershipsSnap.docs.filter(m => m.data().role === 'admin')

    if (adminMemberships.length > 0) {
      const adminCounts = await Promise.all(
        adminMemberships.map(async (m) => {
          const companyId = m.data().companyId as string
          const countSnap = await adminDb
            .collectionGroup('memberships')
            .where('companyId', '==', companyId)
            .where('role', '==', 'admin')
            .count()
            .get()
          return { companyId, count: countSnap.data().count }
        })
      )
      const blocking = adminCounts.find(c => c.count <= 1)
      if (blocking) {
        console.error('[actions/account] deleteAccount blocked: sole admin', { uid: uid.slice(0, 8) + '...' })
        return { error: 'Cannot delete account: you are the only admin of one of your companies. Transfer ownership first.' }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_guard_failed' })
    return { error: 'Failed to delete account' }
  }

  // ── 2. Anonymize all user data ─────────────────────────────────────────────
  try {
    const companyIds = membershipsSnap.docs.map(d => d.data().companyId as string).filter(Boolean)
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

      // Company member doc: carries this user's name/email (written by
      // acceptInvitation, onUserCreate and actions/auth.ts) and is readable by
      // every remaining company member via the firestore.rules wildcard
      // `companies/{companyId}/{document=**}`. Leaving it behind after account
      // deletion keeps that PII exposed — GDPR Art. 17. Deleting a doc that
      // doesn't exist is a no-op in Firestore, so no existence check is needed
      // here; don't add one.
      await addDelete(adminDb.doc(`companies/${companyId}/members/${uid}`))

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

    // Delete membership docs
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
