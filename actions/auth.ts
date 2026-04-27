'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { PLAN_LIMITS } from '@/lib/subscription'

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
      plan:              'starter',
      limits:            PLAN_LIMITS.starter,
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

  // Initialize the equipment counter so createEquipment never hard-errors on a
  // missing counter document for new companies.
  const counterRef = adminDb.doc(`companies/${companyId}/_meta/equipmentCount`)
  batch.set(counterRef, { count: 0, updatedAt: FieldValue.serverTimestamp() })

  try {
    await batch.commit()
  } catch {
    throw new Error('Failed to create company')
  }

  try {
    // ALLOWED from Server Actions: activeCompanyId, role (from verified membership)
    // FORBIDDEN from Server Actions: subscription.*, stripeCustomerId, hadTrial
    // Subscription fields are written ONLY by Cloud Functions/webhooks.
    await adminAuth.setCustomUserClaims(uid, { activeCompanyId: companyId, role: 'admin' })
  } catch {
    throw new Error('Claims failed')
  }

  console.log('[actions/auth]', { action: 'company_created' })
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
 * updating claims.
 *
 * After setting new custom claims, all existing refresh tokens are revoked so
 * that any outstanding session cookie carrying the old activeCompanyId cannot
 * be used to verify sessions server-side. Without revocation the stale cookie
 * remains valid for up to 14 days.
 *
 * IMPORTANT: After calling this action the caller MUST:
 *   1. Call `auth.currentUser.getIdToken(true)` to force a token refresh
 *   2. Call `createSession(freshIdToken)` to re-issue the session cookie
 * Skipping these steps leaves the client with no valid session cookie and the
 * user will be redirected to /login on the next server request.
 */
export async function switchCompany(companyId: string): Promise<void> {
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

    // Revoke all existing refresh tokens so the old session cookie (which
    // carries the previous activeCompanyId) is immediately invalidated.
    // Client must call getIdToken(true) then createSession() after this to
    // get a valid session cookie.
    await adminAuth.revokeRefreshTokens(uid)

    console.log('[actions/auth]', { uid: uid.slice(0, 8) + '...', companyId, role, action: 'company_switched' })

    // Invalidate all cached server data so the new company's data is loaded.
    revalidatePath('/', 'layout')
  } catch (err) {
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'switch_company_failed' })
    throw new Error('Failed to switch company')
  }
}
