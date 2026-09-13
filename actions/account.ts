'use server'

import { createHash } from 'crypto'
import { revalidatePath } from 'next/cache'
import { FieldValue, WriteBatch } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { normalizeEmail } from '@/lib/invite-recipients'
import { memberCountsDelta, readMemberCounts } from '@/lib/companyStats'
import { stripe } from '@/lib/stripe'
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

// Byte-identical to the string this guard has always returned —
// __tests__/account/deleteAccount.test.ts asserts it verbatim, and
// rewording it is issue #252 point 1's job, not this one's.
const SOLE_ADMIN_ERROR =
  'Cannot delete account: you are the only admin of one of your companies. Transfer ownership first.'

// Distinct from SOLE_ADMIN_ERROR: this is what the user sees when the guard
// itself couldn't be evaluated (a read failed, a transaction couldn't be
// completed) — "nothing was deleted" is the fact this message needs to
// convey, as opposed to "you were blocked on purpose."
const COULD_NOT_VERIFY_ERROR =
  'Could not verify your company administrators right now. Nothing was deleted — please try again in a moment.'

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
  let membershipsSnap: FirebaseFirestore.QuerySnapshot
  try {
    membershipsSnap = await adminDb.collection(`users/${uid}/memberships`).get()
    const adminMemberships = membershipsSnap.docs.filter(m => m.data().role === 'admin')

    if (adminMemberships.length > 0) {
      const adminCounts = await Promise.all(
        adminMemberships.map(async (m) => {
          const companyId = m.data().companyId as string

          // Stale membership pointer: this company no longer exists. Must be
          // checked FIRST and short-circuit to a count that can never block —
          // step 2's `!companySnap.exists` branch is precisely the fix for
          // this case (issue #252 point 2), and if this preflight didn't also
          // know about it, it would independently reintroduce the exact same
          // permanent-block bug one layer up: a company with no members
          // collection at all would read back an admin count of 0 from the
          // aggregate fallback below, which is `<= 1` and would block forever
          // — precisely what step 2 exists to stop doing.
          const companySnap = await adminDb.doc(`companies/${companyId}`).get()
          if (!companySnap.exists) {
            // Infinity, not 0 or 1: this is a sentinel for "never blocks"
            // (`count <= 1` below must be false for it), not a real count —
            // there is no company left to count admins of.
            return { companyId, count: Infinity }
          }

          // Company-side `_meta/memberCounts` (lib/companyStats.ts), not the
          // old collectionGroup('memberships') query: that query filtered on
          // the SAME denormalized user-side `role` this function already
          // filtered on above (`adminMemberships`), so it could only ever
          // agree with it — while requiring a collection-group index whose
          // absence was itself issue #252 point 3. When the counter hasn't
          // been seeded for this company yet, fall back to a live
          // company-side aggregate — the same source `readMemberCounts`
          // self-heals from, just not persisted here, since this read isn't
          // inside a transaction. Step 2's transaction heals it for real.
          const metaSnap = await adminDb.doc(`companies/${companyId}/_meta/memberCounts`).get()
          if (metaSnap.exists) {
            return { companyId, count: (metaSnap.data()!.admins as number | undefined) ?? 0 }
          }
          const countSnap = await adminDb
            .collection(`companies/${companyId}/members`)
            .where('role', '==', 'admin')
            .count()
            .get()
          return { companyId, count: countSnap.data().count }
        })
      )
      const blocking = adminCounts.find(c => c.count <= 1)
      if (blocking) {
        console.error('[actions/account]', { uid: uid.slice(0, 8) + '...', action: 'delete_account_blocked_sole_admin' })
        return { error: SOLE_ADMIN_ERROR }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/account]', { error: message, action: 'delete_account_preflight_failed' })
    return { error: COULD_NOT_VERIFY_ERROR }
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

        if (role === 'admin' && counts.admins <= 1) {
          throw guardError('sole-admin', SOLE_ADMIN_ERROR)
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

      return { error: code === 'sole-admin' ? SOLE_ADMIN_ERROR : COULD_NOT_VERIFY_ERROR }
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
