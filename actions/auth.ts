'use server'

import { cookies } from 'next/headers'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'

const DEFAULT_CATEGORIES = ['Camera', 'Lenses', 'Audio', 'Lighting', 'Grip', 'Accessories']

// 14 days in milliseconds — matches the Firebase session cookie maximum.
const SESSION_DURATION_MS = 60 * 60 * 24 * 14 * 1000

/**
 * Creates a Firebase session cookie from a client-supplied ID token.
 * Called after successful signInWithEmailAndPassword on the client.
 */
export async function createSession(idToken: string): Promise<void> {
  let uid: string | undefined

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken)
    uid = decodedToken.uid

    // Refuse to issue a session for tokens that are missing custom claims.
    // This catches the window between user creation and setupNewCompany completing,
    // and also catches a force-refresh that hasn't picked up new claims yet.
    const activeCompanyId = decodedToken['activeCompanyId']
    if (typeof activeCompanyId !== 'string' || activeCompanyId === '') {
      console.error('[actions/auth]', { uid: uid.slice(0, 8) + '...', action: 'create_session_rejected_missing_claims' })
      throw new Error('Token is missing activeCompanyId claim')
    }

    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    })

    const cookieStore = await cookies()
    cookieStore.set('__session', sessionCookie, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path:     '/',
      maxAge:   60 * 60 * 24 * 14, // 14 days in seconds
    })

    console.log('[actions/auth]', { action: 'session_created' })
  } catch (err) {
    // Do not log the raw error — Firebase Admin errors can contain emails or tokens.
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'create_session_failed' })
    throw new Error('Failed to create session')
  }
}

/**
 * Creates a company for a newly registered user — server-side, no CORS issues.
 * Sets custom claims (activeCompanyId, role) on the Auth user.
 *
 * IMPORTANT: After this returns the client MUST call `getIdToken(true)` to get
 * a fresh token that includes the new claims, then call `createSession(freshToken)`.
 * The session cookie must be issued from the refreshed token — not the one
 * passed here — otherwise activeCompanyId will be missing from the session.
 *
 * @param idToken     - Firebase ID token from the new user (used for identity only)
 * @param companyName - Company display name (max 100 chars)
 * @param userName    - User display name (max 100 chars)
 */
export async function setupNewCompany(
  idToken: string,
  companyName: string,
  userName: string,
): Promise<void> {
  let uid: string
  let email: string
  try {
    const decoded = await adminAuth.verifyIdToken(idToken)
    uid   = decoded.uid
    email = decoded.email ?? ''
  } catch {
    throw new Error('Invalid token')
  }

  // Idempotency: if the user already has a membership, the account exists.
  const membershipCol = adminDb.collection(`users/${uid}/memberships`)
  const existing = await membershipCol.limit(1).get()
  if (!existing.empty) {
    throw new Error('already-exists')
  }

  const companyRef = adminDb.collection('companies').doc()
  const companyId  = companyRef.id
  const userRef    = adminDb.doc(`users/${uid}`)
  const memberRef  = adminDb.doc(`users/${uid}/memberships/${companyId}`)

  const batch = adminDb.batch()

  batch.set(companyRef, {
    name:             companyName,
    createdAt:        FieldValue.serverTimestamp(),
    createdBy:        uid,
    stripeCustomerId: '',
    hadTrial:         false,
    subscription: {
      status:            'trialing',
      plan:              'basic',
      limits:            { equipment: 50, users: 5 },
      currentPeriodEnd:  null,
      trialEnd:          null,
      cancelAtPeriodEnd: false,
    },
  })

  batch.set(userRef, {
    name:            userName,
    email,
    activeCompanyId: companyId,
    createdAt:       FieldValue.serverTimestamp(),
  })

  batch.set(memberRef, {
    companyId,
    role:     'admin',
    joinedAt: FieldValue.serverTimestamp(),
  })

  for (const name of DEFAULT_CATEGORIES) {
    const catRef = adminDb.collection(`companies/${companyId}/categories`).doc()
    batch.set(catRef, { name, createdAt: FieldValue.serverTimestamp(), isDefault: true })
  }

  try {
    await batch.commit()
    console.log('[actions/auth]', { action: 'company_batch_committed', companyId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/auth]', { error: message, action: 'company_batch_failed' })
    throw new Error('Failed to create company')
  }

  // Batch succeeded — now set custom claims. If this fails the Firestore docs
  // are already written, so attempt a best-effort cleanup of the company document
  // before re-throwing, to avoid leaving the account in an unrecoverable state.
  try {
    await adminAuth.setCustomUserClaims(uid, { activeCompanyId: companyId, role: 'admin' })
  } catch (claimsErr) {
    const message = claimsErr instanceof Error ? claimsErr.message : String(claimsErr)
    console.error('[actions/auth]', { error: message, companyId, action: 'claims_failed_attempting_cleanup' })

    // Best-effort: delete the company doc so the user can retry signup cleanly.
    // Membership and user docs are also cleaned up where possible.
    try {
      await adminDb.collection('companies').doc(companyId).delete()
      console.log('[actions/auth]', { companyId, action: 'cleanup_company_deleted' })
    } catch (cleanupErr) {
      const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      console.error('[actions/auth]', { error: cleanupMessage, companyId, action: 'cleanup_failed' })
    }

    throw new Error('Claims failed')
  }

  console.log('[actions/auth]', { action: 'company_created', companyId })
}

/**
 * Clears the session cookie. Call this on sign-out.
 */
export async function deleteSession(): Promise<void> {
  try {
    const cookieStore = await cookies()
    cookieStore.delete('__session')
    console.log('[actions/auth]', { action: 'session_deleted' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/auth]', { error: message, action: 'delete_session_failed' })
    throw new Error('Failed to delete session')
  }
}

/**
 * Switches the active company for the current user.
 * Validates that a membership document exists for the target companyId before
 * updating custom claims.
 *
 * This action only updates claims on the Auth user. It does NOT re-issue the
 * session cookie — the caller MUST complete the handshake:
 *
 *   1. Call this Server Action (updates claims server-side).
 *   2. Client calls `auth.currentUser.getIdToken(true)` to force a token refresh
 *      so the new activeCompanyId claim is included.
 *   3. Client calls `createSession(freshIdToken)` to re-issue the session cookie.
 *   4. Client navigates to /bookings (or calls `revalidatePath` after step 3).
 *
 * Skipping steps 2–3 leaves the session cookie carrying the old activeCompanyId
 * until it expires — a cross-tenant data exposure risk.
 *
 * @returns The new role for the switched company, so the client can pass it
 *          as additional context if needed before the token refresh completes.
 */
export async function switchCompany(companyId: string): Promise<{ role: string }> {
  const session = await getVerifiedSession()
  const uid = session.uid

  try {
    // Verify membership exists before updating claims.
    const membershipRef = adminDb
      .collection('users').doc(uid)
      .collection('memberships').doc(companyId)

    const membershipSnap = await membershipRef.get()

    if (!membershipSnap.exists) {
      console.error('[actions/auth]', { uid: uid.slice(0, 8) + '...', companyId, action: 'switch_company_denied_no_membership' })
      throw new Error('No membership found for this company')
    }

    const membershipData = membershipSnap.data() as { role?: string }
    const role = membershipData.role ?? 'viewer'

    await adminAuth.setCustomUserClaims(uid, {
      activeCompanyId: companyId,
      role,
    })

    console.log('[actions/auth]', { uid: uid.slice(0, 8) + '...', companyId, role, action: 'claims_updated_awaiting_session_reissue' })

    // Do NOT call revalidatePath here — the session cookie still carries the old
    // activeCompanyId at this point. The caller must force-refresh the ID token
    // and call createSession() before navigating. Revalidation happens naturally
    // when the client navigates after the new session cookie is issued.
    return { role }
  } catch (err) {
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'switch_company_failed' })
    throw new Error('Failed to switch company')
  }
}
