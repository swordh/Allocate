import { adminAuth } from '@/lib/firebase-admin'
import { FIREBASE_AUTH_EMULATOR_HOST } from './constants'

/**
 * Exchanges a freshly-minted custom token for a real ID token via the Auth
 * emulator's REST API. The Admin SDK can mint custom tokens but never ID
 * tokens itself, and `setupNewCompany` (actions/auth.ts) calls
 * `adminAuth.verifyIdToken` on whatever it's handed — so a test that drives
 * `setupNewCompany` the way a real client would needs a genuine ID token,
 * not a uid string. The emulator accepts any non-empty string as the `key`
 * query param — it never contacts a real Google endpoint.
 */
export async function getIdTokenForUid(uid: string): Promise<string> {
  const customToken = await adminAuth.createCustomToken(uid)
  const res = await fetch(
    `http://${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  )
  if (!res.ok) {
    throw new Error(`[authHelpers] signInWithCustomToken failed (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as { idToken: string }
  return json.idToken
}
