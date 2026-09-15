/**
 * Global setup for the emulator suite (registered via vitest.emulator.config.ts
 * `setupFiles`). Runs once per test file, before that file's tests, since
 * `pool: 'forks'` gives every file its own process.
 *
 * Order matters: the env vars MUST be set before firebase-admin is imported
 * anywhere, including transitively through '@/lib/firebase-admin' or
 * functions/src modules. The Admin SDK reads FIRESTORE_EMULATOR_HOST /
 * FIREBASE_AUTH_EMULATOR_HOST at call time when talking to Firestore/Auth,
 * but it decides how to authenticate at initializeApp() time — so an app
 * initialized before these are set can end up trying to use real credentials.
 */
import { beforeEach } from 'vitest'
import { initializeApp, getApps } from 'firebase-admin/app'
import {
  EMULATOR_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST,
  FIREBASE_AUTH_EMULATOR_HOST,
} from './constants'
import { ensureFunctionsAdminAppInitialized } from '../../functions/src/testSupport/emulatorInit'

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST
process.env.FIREBASE_AUTH_EMULATOR_HOST = FIREBASE_AUTH_EMULATOR_HOST
process.env.GCLOUD_PROJECT = EMULATOR_PROJECT_ID

/**
 * The default Admin app for '@/lib/firebase-admin' (adminDb/adminAuth — see
 * its getAdminApp(), which reuses getApps()[0] when one already exists
 * instead of reading FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON). No credential is
 * passed — the emulator doesn't check one, and never falling back to a real
 * service account is the whole point of this file existing.
 *
 * CORRECTION to what this comment used to say: this does NOT also cover
 * functions/src modules. functions/ has its own `npm install`
 * (functions/node_modules) with its own separate firebase-admin copy, and
 * Node resolves a bare 'firebase-admin/app' specifier against the
 * node_modules closest to the IMPORTING file — so functions/src always
 * loads ITS OWN firebase-admin, a different module instance with a
 * different `getApps()` registry than the one initialized right here. See
 * functions/src/testSupport/emulatorInit.ts for the second initializeApp()
 * call that PR E (issue #252 step 5) added once a test first needed to
 * import functions/src/company/* directly — this comment was wrong until
 * then because nothing had exercised that path yet.
 */
if (getApps().length === 0) {
  initializeApp({ projectId: EMULATOR_PROJECT_ID })
}
ensureFunctionsAdminAppInitialized(EMULATOR_PROJECT_ID)

/**
 * Wipes every document in the emulator's Firestore before each test. Cheap
 * (it's a local REST call, not a real network round trip) and necessary:
 * `fileParallelism: false` in vitest.emulator.config.ts serializes test
 * files against the one shared emulator, but nothing else gives tests within
 * or across files a clean slate — the emulator process itself persists data
 * for as long as `firebase emulators:exec` keeps it running.
 */
async function clearFirestore(): Promise<void> {
  const url = `http://${FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(
      `[emulatorSetup] failed to clear Firestore emulator (${res.status}): ${await res.text()}`,
    )
  }
}

beforeEach(clearFirestore)
