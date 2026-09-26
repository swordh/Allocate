'use server'

import { cookies } from 'next/headers'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession, getCompanyDoc } from '@/lib/dal'
import { toRole } from '@/lib/roles'
import { PLAN_LIMITS } from '@/lib/subscription'
import { INITIAL_COMPANY_STATS } from '@/lib/companyStats'
import { DEFAULT_COMPANY_PREFERENCES } from '@/constants/company'

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

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true }
  catch { return false }
}

/**
 * Repairs the split `setupNewCompany` can leave behind when `batch.commit()`
 * succeeds but `setCustomUserClaims` then throws: company and memberships on
 * disk, no claims on the Auth user, no way back in.
 *
 * WHAT COUNTS AS "HERS" — this is the whole security question, because the
 * function writes custom claims, and claims are what every Firestore rule and
 * every server action ultimately trusts. The criterion is deliberately
 * narrower than "she has a membership doc":
 *
 *   1. `companies/{cid}.createdBy === uid` — she FOUNDED this company. This
 *      field is written exactly once, by the batch a few lines below, and
 *      never again by anything. Restricting the repair to it keeps this
 *      branch a fix for the specific split THIS function creates, rather
 *      than a general "hand me claims for any company I can name".
 *   2. `companies/{cid}/members/{uid}` still exists — she is a member RIGHT
 *      NOW, not merely historically. A founder who was later removed from
 *      her own company must not be let back in by this path.
 *   3. The role written into the claims is read live from that member
 *      document — never assumed to be 'admin' just because she founded it.
 *
 * All three come from documents only the server can have written:
 * firestore.rules has `allow write: if false` on `companies/{companyId}`, on
 * the `companies/{companyId}/{document=**}` wildcard, and on
 * `users/{userId}/memberships/{companyId}`. There is no client-supplied
 * input anywhere in the decision — not the id token's claims, not a
 * parameter, not the membership doc's own contents beyond a company id that
 * is then verified against the company document itself. A caller who forges
 * or replays anything reachable to her cannot move this branch.
 *
 * Claims that already point at one of her live companies are left alone: in
 * that case nothing is broken, she is simply calling this twice, and the
 * `already-exists` refusal is the correct answer.
 *
 * @returns true when claims were repaired (the caller must then return
 *   without creating anything); false when there is nothing to repair, which
 *   means the ordinary `already-exists` refusal applies.
 */
async function repairMissingClaims(
  uid: string,
  liveMemberships: Array<{ companyId: string; createdBy: string | undefined }>,
): Promise<boolean> {
  let currentActiveCompanyId: unknown
  try {
    const authUser = await adminAuth.getUser(uid)
    currentActiveCompanyId = authUser.customClaims?.activeCompanyId
  } catch {
    // Can't establish that the claims are broken — don't write any.
    return false
  }

  // Claims already resolve to a company she is a live member of: nothing is
  // wrong, this is an ordinary duplicate call.
  if (liveMemberships.some((m) => m.companyId === currentActiveCompanyId)) return false

  const founded = liveMemberships.find((m) => m.createdBy === uid)
  if (!founded) return false

  const memberPath = `companies/${founded.companyId}/members/${uid}`
  const memberSnap = await adminDb.doc(memberPath).get()
  if (!memberSnap.exists) return false

  // Deliberately stricter than toRole's normal "anything unrecognised
  // becomes crew" behaviour: this branch WRITES Custom Claims for the
  // caller, so a role value that isn't one this app actually recognises —
  // 'admin'/'crew', or the still-transitional legacy 'viewer' — must refuse
  // the repair outright rather than silently hand her a working session
  // anyway. `toRole` still owns the one substitution that IS safe here:
  // mapping a legacy 'viewer' member doc to 'crew'.
  const rawRole = memberSnap.data()?.role
  if (rawRole !== 'admin' && rawRole !== 'crew' && rawRole !== 'viewer') return false
  const role = toRole(rawRole, { fn: 'repairMissingClaims', path: memberPath })

  await adminAuth.setCustomUserClaims(uid, { activeCompanyId: founded.companyId, role })
  console.log('[actions/auth]', { action: 'claims_repaired' })
  return true
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
  timezone = 'UTC',
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

  const safeTimezone = isValidTimezone(timezone) ? timezone : 'UTC'

  // Idempotency: if the user already has a membership pointing at a company
  // that still exists, the account is already fully set up — refuse to
  // create a second one. A membership doc whose company has since been
  // deleted does NOT count: it's an orphaned pointer, not a real account, and
  // treating it as one used to lock the user out permanently (issue #252
  // step 5, PR F). `limit(1).get()` found ANY membership doc and threw
  // `already-exists` regardless of whether the company behind it still
  // existed — exactly the return path the #252 step 5 purge (PR E) can now
  // create for a stranded former member trying to start over. Same
  // `!companySnap.exists` skip `actions/account.ts`'s `deleteAccount` and
  // `getVerifiedSession` (lib/dal.ts) already use, via the same
  // request-deduped `getCompanyDoc`.
  //
  // Two known pre-existing problems are deliberately NOT solved here, each
  // needing a decision of its own (issue #252 follow-ups):
  //   1. TOCTOU — this probe is not transactional, so two concurrent calls
  //      can both pass it and create two companies for the same user.
  //   2. Orphaned `users/{uid}/memberships/{cid}` docs pointing at deleted
  //      companies are skipped here but never cleaned up, so they accumulate
  //      and every future call re-reads them.
  const [userSnap, membershipsSnap] = await Promise.all([
    adminDb.doc(`users/${uid}`).get(),
    adminDb.collection(`users/${uid}/memberships`).get(),
  ])
  const liveMemberships = (
    await Promise.all(
      membershipsSnap.docs.map(async (doc) => {
        const membershipCompanyId = doc.data().companyId as string | undefined
        if (!membershipCompanyId) return null
        const companySnap = await getCompanyDoc(membershipCompanyId)
        if (!companySnap.exists) return null
        return {
          companyId: membershipCompanyId,
          createdBy: companySnap.data()?.createdBy as string | undefined,
        }
      }),
    )
  ).filter((m): m is { companyId: string; createdBy: string | undefined } => m !== null)

  if (liveMemberships.length > 0) {
    // She has a live company, so she must not get a second one. But the
    // company existing is not the same as her being able to REACH it: this
    // function commits its batch and only then calls `setCustomUserClaims`,
    // and those two steps are not atomic. If the claims write fails, the
    // company and both membership docs exist while her token carries no
    // `activeCompanyId` — `getVerifiedSession` (lib/dal.ts) bounces her to
    // /no-company, and every retry from there used to land on the branch
    // above and throw `already-exists` forever.
    //
    // That shape is pre-existing, but its meaning is not: after PR E this
    // code path sits in the middle of the only way out a stranded user has,
    // and she has a clock running (types/user.ts `PendingAccountDeletion`).
    // A dead end with a deadline is worse than the one #252 exists to close,
    // so repair the claims instead of throwing.
    const repaired = await repairMissingClaims(uid, liveMemberships)
    if (repaired) return
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
    preferences:      { ...DEFAULT_COMPANY_PREFERENCES, timezone: safeTimezone },
    subscription: {
      status:            'trialing',
      plan:              'starter',
      limits:            PLAN_LIMITS.starter,
      currentPeriodEnd:  null,
      trialEnd:          null,
      cancelAtPeriodEnd: false,
    },
    stats: {
      ...INITIAL_COMPANY_STATS,
      // The founder's own companies/{companyId}/members/{uid} doc
      // (companyMemberRef, below) is written in this same batch, so the
      // company is never observed with zero members. Set explicitly here
      // rather than folded into INITIAL_COMPANY_STATS — that constant must
      // stay an honest zero state; it's also used nowhere else.
      memberCount: 1,
      updatedAt: FieldValue.serverTimestamp(),
    },
  })

  if (userSnap.exists) {
    // A returning user (e.g. a stranded former member — see
    // MemberAccountStatus in functions/src/company/memberCleanup.ts —
    // creating a replacement company from /no-company). `merge: true`
    // preserves everything not listed here (in particular `createdAt`,
    // which must not be reset), and clears `pendingDeletion`
    // (types/user.ts) in this SAME batch as the new membership write below
    // — not as a follow-up that could be skipped. See "Avbrottsvillkoret"
    // in plan/det-k-nns-som-att-stateless-conway.md: creating a company is
    // itself the cancellation, no separate action required.
    batch.set(userRef, {
      name:            userName,
      email,
      activeCompanyId: companyId,
      pendingDeletion: FieldValue.delete(),
    }, { merge: true })
  } else {
    batch.set(userRef, {
      name:            userName,
      email,
      activeCompanyId: companyId,
      createdAt:       FieldValue.serverTimestamp(),
    })
  }

  batch.set(memberRef, {
    companyId,
    role:     'admin',
    joinedAt: FieldValue.serverTimestamp(),
  })

  const companyMemberRef = adminDb.doc(`companies/${companyId}/members/${uid}`)
  batch.set(companyMemberRef, {
    uid,
    name:      userName,
    email,
    role:      'admin',
    joinedAt:  FieldValue.serverTimestamp(),
    companyId,
  })

  for (const name of DEFAULT_CATEGORIES) {
    const catRef = adminDb.collection(`companies/${companyId}/categories`).doc()
    batch.set(catRef, { name, createdAt: FieldValue.serverTimestamp(), isDefault: true })
  }

  // Initialize the equipment counter so createEquipment never hard-errors on a
  // missing counter document for new companies.
  const counterRef = adminDb.doc(`companies/${companyId}/_meta/equipmentCount`)
  batch.set(counterRef, { count: 0, updatedAt: FieldValue.serverTimestamp() })

  // Initialize the member-counts counter (lib/companyStats.ts) so the
  // sole-admin guards in removeMember/updateMemberRole/deleteAccount never
  // have to fall back to readMemberCounts's self-healing aggregate read for a
  // brand-new company — the founder is member 1 and admin 1 from the first
  // instant the company exists, in the same batch as companyMemberRef below.
  const memberCountsRef = adminDb.doc(`companies/${companyId}/_meta/memberCounts`)
  batch.set(memberCountsRef, { members: 1, admins: 1, updatedAt: FieldValue.serverTimestamp() })

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
 * Returns a Firebase custom token, NOT void — caught live against alpha
 * building the first real UI caller of this action (issue #352). The
 * obvious-looking pattern (`getIdToken(true)` then `createSession`) does not
 * work here: `revokeRefreshTokens` invalidates the CALLING browser's own
 * refresh token too — Firebase has no "revoke everyone except this session"
 * primitive — so the very next `getIdToken(true)` fails at Google's STS
 * endpoint (`securetoken.googleapis.com/v1/token` → 400) regardless of any
 * delay between the two calls. A custom token sidesteps this: minting one
 * and having the client `signInWithCustomToken` performs a real, fresh
 * sign-in that establishes a BRAND NEW refresh token, unrelated to the one
 * just revoked. The persisted custom claims set below are picked up
 * automatically on that new sign-in — the custom token itself carries no
 * claims of its own.
 *
 * IMPORTANT: After calling this action the caller MUST:
 *   1. Call `signInWithCustomToken(auth, customToken)` (firebase/auth) — NOT
 *      `getIdToken(true)` on the existing user, for the reason above
 *   2. Call `createSession(freshIdToken)` with the resulting credential's ID
 *      token, to re-issue the session cookie
 * Skipping these steps leaves the client with no valid session cookie and the
 * user will be redirected to /login on the next server request.
 */
export async function switchCompany(companyId: string): Promise<{ customToken: string }> {
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

    const membershipData = membershipSnap.data() as { role?: unknown }
    const role = toRole(membershipData.role, { fn: 'switchCompany', path: membershipRef.path })

    await adminAuth.setCustomUserClaims(uid, {
      activeCompanyId: companyId,
      role,
    })

    // Revoke all existing refresh tokens so the old session cookie (which
    // carries the previous activeCompanyId) is immediately invalidated, then
    // mint a custom token so the client can re-establish a session without
    // depending on the refresh token just revoked (see docblock above).
    await adminAuth.revokeRefreshTokens(uid)
    const customToken = await adminAuth.createCustomToken(uid)

    console.log('[actions/auth]', { uid: uid.slice(0, 8) + '...', companyId, role, action: 'company_switched' })

    // Deliberately NOT calling revalidatePath here (issue #352, caught live
    // against alpha building the first real caller of this action). Server
    // Actions invoked from a Client Component eagerly re-render the
    // invoking route's revalidated segments as part of THIS SAME
    // request/response — using the request's own (still the OLD, now
    // revoked) session cookie. That re-render hits getVerifiedSession(),
    // checkRevoked rejects the now-stale cookie, and its redirect('/login')
    // takes over the client's navigation before the caller's own
    // getIdToken(true)+createSession() handshake (required by this
    // function's docblock) ever runs. Every caller already does a hard
    // `window.location.href` reload after the handshake, which busts the
    // Next.js cache on its own — revalidatePath buys nothing here and only
    // creates this race.

    return { customToken }
  } catch (err) {
    const code = err instanceof Error ? (err.message.split('/').pop() ?? 'unknown') : 'unknown'
    console.error('[actions/auth]', { code, action: 'switch_company_failed' })
    throw new Error('Failed to switch company')
  }
}
