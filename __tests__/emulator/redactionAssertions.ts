/**
 * Shared assertions for the PR G retention tests (issue #252 step 5).
 *
 * Both redaction test files used to prove "everything else survived" by
 * listing the fields they expected back. That list is only ever as good as the
 * last person to extend it, and it cannot catch the two failures that matter
 * most: a field that DISAPPEARS, and a field that APPEARS. A vanished
 * `purgeAfter` is the worst of them — Firestore does not return documents
 * missing the field a range query compares, so such a row drops out of the
 * identity rule's query permanently and keeps the requester's name, address
 * and uid forever, with no error anywhere.
 */
import { expect } from 'vitest'

/**
 * Asserts that `after` differs from `before` in exactly the ways allowed:
 * only `mayChange` keys may hold a different value, only `mayAppear` keys may
 * be new, and no key may be missing unless it is listed in `mayChange` (a
 * rule that removes a field declares that field as changed).
 */
export function expectOnlyTheseFieldsChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: { mayChange: string[]; mayAppear: string[] },
): void {
  const mayChange = new Set(allowed.mayChange)

  for (const [key, value] of Object.entries(before)) {
    if (mayChange.has(key)) continue
    expect(key in after, `field "${key}" disappeared from the row`).toBe(true)
    expect(after[key], `field "${key}" changed but was not allowed to`).toEqual(value)
  }

  const appeared = Object.keys(after)
    .filter((key) => !(key in before))
    .sort()
  expect(appeared, 'unexpected new fields on the row').toEqual([...allowed.mayAppear].sort())
}

/**
 * Wraps `db.batch()` so every write operation a batch receives is counted,
 * returning one entry per batch created. Counts `update`, `set`, `delete` and
 * `create` — the point is what the real Firestore would see against its
 * 500-operation cap, which the emulator itself never enforces, so a spy
 * watching only `update` would go blind the day a rule adds a second write per
 * row.
 *
 * Typed structurally rather than against `FirebaseFirestore.Firestore`:
 * functions/ has its own firebase-admin install, so the `Firestore` these
 * tests pass in is a different (identically named, unrelated to the compiler)
 * type from the root project's. See functions/src/testSupport/emulatorInit.ts.
 *
 * ALWAYS call `restore()` from a `finally` — the emulator tests share one
 * `Firestore` instance per file.
 */
type BatchFactory = { batch: () => unknown }

export function spyOnBatchWrites<T extends BatchFactory>(
  db: T,
): { writesPerBatch: number[]; restore: () => void } {
  const writesPerBatch: number[] = []
  const realBatch = db.batch.bind(db) as () => Record<string, unknown>

  db.batch = (() => {
    const batch = realBatch()
    const slot = writesPerBatch.push(0) - 1
    for (const op of ['update', 'set', 'delete', 'create']) {
      const real = (batch[op] as (...a: unknown[]) => unknown).bind(batch)
      batch[op] = (...args: unknown[]) => {
        writesPerBatch[slot] += 1
        return real(...args)
      }
    }
    return batch
  }) as T['batch']

  return {
    writesPerBatch,
    restore: () => {
      db.batch = realBatch as T['batch']
    },
  }
}
