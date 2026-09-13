/**
 * Single source of truth for the emulator ports/project id, shared by the
 * setup file and every test. Keep these in sync with the "emulators" block
 * in firebase.json by hand — vitest has no way to read that file's ports at
 * config time without shelling out, and duplicating three literals here is
 * cheaper than that.
 */

// A "demo-" project id is a firebase-tools convention: the CLI and the Admin
// SDK both recognize the prefix as a fake, unbilled project that can only
// ever resolve to an emulator, never to a real Firebase project. Using a
// real project id here (even allocate-alpha) would mean a misconfigured or
// missing FIRESTORE_EMULATOR_HOST silently falls through to production data
// instead of failing loudly.
export const EMULATOR_PROJECT_ID = 'demo-allocate-test'

export const FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180'
export const FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9299'
