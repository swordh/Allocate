import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

/**
 * Test-only. NOT exported from functions/src/index.ts, so it is never a
 * deployed Cloud Function — it only exists to be imported, by relative
 * path, from the root project's __tests__/emulator/emulatorSetup.ts.
 *
 * Why this needs to exist at all: functions/ has its OWN `npm install`
 * (functions/node_modules), separate from the root project's, and Node's
 * module resolution for a bare specifier like 'firebase-admin/app' always
 * resolves against the node_modules closest to the IMPORTING file — so
 * code under functions/src always gets functions/node_modules'
 * firebase-admin, never the root's, regardless of who calls it. That's the
 * same boundary documented in functions/src/companyStats.ts and
 * acceptInvitation.ts, just visible from the test-tooling side this time.
 *
 * The consequence for testing: __tests__/emulator/emulatorSetup.ts calls
 * `initializeApp()` using the ROOT project's firebase-admin (v13.7.0 at
 * this writing) — a completely different loaded module instance, with its
 * own separate `getApps()` registry, from the one every function in
 * functions/src/company/* resolves `getFirestore()`/`getAuth()` against
 * (functions/node_modules' v12.7.0). Without a second `initializeApp()`
 * call made from code that itself lives under functions/, those calls
 * throw "the default Firebase app does not exist" the moment an emulator
 * test tries to exercise runCompanyPurge, the sweep, or the trigger
 * handlers directly.
 *
 * This function is that second call. It only needs to run once per test
 * process (guarded by `getApps().length === 0`, same idiom as
 * emulatorSetup.ts itself) and relies on FIRESTORE_EMULATOR_HOST /
 * FIREBASE_AUTH_EMULATOR_HOST already being set as process env vars before
 * it runs — same precondition emulatorSetup.ts already documents for the
 * root-side app. Both `App` instances end up independently pointed at the
 * SAME local emulator process; they don't need to be the same JS object for
 * that, only to agree on which emulator to talk to.
 */
export function ensureFunctionsAdminAppInitialized(projectId: string): void {
  if (getApps().length === 0) {
    initializeApp({ projectId });
  }
}

/**
 * Returns a `Firestore` instance from functions/'s OWN firebase-admin
 * install. Emulator tests should pass THIS into `runCompanyPurge` /
 * `runCompanyDeletionSweep` / `cleanupOneMember` etc. (functions/src's
 * exported plain functions all take `db: Firestore` as a parameter — see
 * their own docblocks for why), rather than root's `adminDb`
 * (`@/lib/firebase-admin`) — passing a different module's `Firestore`
 * object across the boundary would still work at the wire level (both
 * ultimately talk to the same local emulator), but risks structural-typing
 * friction between the two independently-versioned `firebase-admin`
 * packages for no benefit. Tests still use root's `adminDb` freely for
 * SEEDING fixtures and asserting on results — that's just reading and
 * writing the same underlying emulator data, version-agnostic by
 * construction.
 */
export function getTestFunctionsDb(): Firestore {
  return getFirestore();
}
