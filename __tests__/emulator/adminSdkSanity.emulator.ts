/**
 * Proves the plumbing, not the product: that '@/lib/firebase-admin' — the
 * exact module every server action and Cloud Function uses — is actually
 * talking to the local emulator and not to allocate-alpha.
 *
 * This looks trivial but is the single most important test in this PR. Every
 * emulator test that comes after this one (and eventually the company-purge
 * tests from issue #252 steg 5) trusts that FIRESTORE_EMULATOR_HOST routes
 * writes away from real data. If that trust is ever wrong, this is the test
 * that should catch it — so it asserts the environment precondition
 * explicitly instead of only asserting the write/read/delete behavior.
 */
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { FIRESTORE_EMULATOR_HOST } from './constants'

describe('admin SDK sanity check', () => {
  it('FIRESTORE_EMULATOR_HOST is set — the non-negotiable precondition', () => {
    // If this ever fails, every other test in this suite is potentially
    // reading and writing real data. Fail loud, fail first.
    expect(process.env.FIRESTORE_EMULATOR_HOST).toBe(FIRESTORE_EMULATOR_HOST)
  })

  it('writes, reads back, and deletes a document against the emulator', async () => {
    const ref = adminDb.collection('_emulatorSanityCheck').doc('probe')

    await ref.set({ hello: 'emulator', writtenAt: Date.now() })

    const snap = await ref.get()
    expect(snap.exists).toBe(true)
    expect(snap.data()?.hello).toBe('emulator')

    await ref.delete()

    const afterDelete = await ref.get()
    expect(afterDelete.exists).toBe(false)
  })
})
