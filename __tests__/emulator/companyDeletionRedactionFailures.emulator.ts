/**
 * The failure path of the PR G retention job — issue #252 step 5.
 *
 * Everything else in this suite exercises the happy path, and the happy path
 * is not where retention jobs go wrong. They go wrong by failing quietly: one
 * un-writable row fails the `WriteBatch` it shares with up to 489 others,
 * those rows keep their identities, the sweep logs a line nobody reads, and
 * the schedule reports success — every Monday, indefinitely. That is the
 * `purgeAuditLogs.ts` shape of bug one collection over.
 *
 * Two mechanisms exist against it and BOTH are only real if tested: the
 * per-document fallback a failed chunk retries through, and the `onSchedule`
 * wrapper that turns rows-left-behind into a failed scheduled execution. A
 * deliberate `catch` plus an untested wrapper is exactly the pair that makes a
 * whole failure path invisible.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeCompanyDeletionLogsSweep, purgeCompanyDeletionLogs } from '../../functions/src/company/purgeLogs'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

const DAY = 24 * 60 * 60 * 1000
const past = (days: number) => Timestamp.fromMillis(Date.now() - days * DAY)

function dueRow(requestId: string) {
  return {
    requestId,
    companyId: `co-${requestId}`,
    companyName: 'Acme Film AB',
    mode: 'window',
    state: 'completed',
    requestedAt: past(800),
    requestedByUid: 'requester-uid',
    requestedByName: 'Requester Name',
    requestedByEmail: 'requester@example.com',
    scheduledFor: past(793),
    completedAt: past(793),
    attempts: 0,
    purgeAfter: past(1),
  }
}

async function seedDueRows(ids: string[]): Promise<void> {
  for (const id of ids) await adminDb.doc(`companyDeletions/${id}`).set(dueRow(id))
}

/**
 * Replaces `db.batch()` so the first batch created commits according to
 * `onFirstCommit` instead of for real. Returns a `restore` that MUST run in a
 * `finally`: the `Firestore` instance is shared by every test in this file.
 */
function breakFirstBatchCommit(
  db: { batch: () => unknown },
  onFirstCommit: () => Promise<never>,
): { restore: () => void } {
  const realBatch = db.batch.bind(db) as () => Record<string, unknown>
  let broken = false

  db.batch = (() => {
    const batch = realBatch()
    if (!broken) {
      broken = true
      batch['commit'] = onFirstCommit
    }
    return batch
  }) as typeof db.batch

  return {
    restore: () => {
      db.batch = realBatch as typeof db.batch
    },
  }
}

describe('purgeCompanyDeletionLogsSweep — failure handling', () => {
  it('rescues a failed chunk one document at a time, and leaves nothing un-redacted', async () => {
    await seedDueRows(['rescue-1', 'rescue-2', 'rescue-3'])

    const db = getTestFunctionsDb()
    const { restore } = breakFirstBatchCommit(db, async () => {
      throw new Error('simulated batch commit failure')
    })

    let result
    try {
      result = await purgeCompanyDeletionLogsSweep(db)
    } finally {
      restore()
    }

    // The chunk failed; the rows did not. That distinction is the whole point
    // of the fallback, and it is why the wrapper alarms on `failedRows` rather
    // than on `failedBatches`.
    expect(result.byRule['identity'].failedBatches).toBe(1)
    expect(result.failedRows).toBe(0)
    expect(result.redacted).toBe(3)

    for (const id of ['rescue-1', 'rescue-2', 'rescue-3']) {
      const row = (await adminDb.doc(`companyDeletions/${id}`).get()).data()!
      expect(row.requestedByUid).toBeNull()
      expect(row.requestedByEmail).toBeNull()
      // A per-document `update()` is one atomic write, so the marker still
      // arrives with the blanking — never one without the other.
      expect(row.identityRedactedAt).toBeInstanceOf(Timestamp)
    }
  })

  it('counts a row that cannot be written at all, finishes the others, and leaves their data alone', async () => {
    await seedDueRows(['victim', 'survivor-1', 'survivor-2'])

    const db = getTestFunctionsDb()
    // A row that disappears between the sweep's read and its write — an
    // ordinary concurrent-delete race, and the one failure the fallback cannot
    // paper over (`update()` on a missing document throws, and must not
    // recreate it).
    const { restore } = breakFirstBatchCommit(db, async () => {
      await adminDb.doc('companyDeletions/victim').delete()
      throw new Error('simulated batch commit failure')
    })

    let result
    try {
      result = await purgeCompanyDeletionLogsSweep(db)
    } finally {
      restore()
    }

    expect(result.failedRows).toBe(1)
    expect(result.redacted).toBe(2)
    expect(result.byRule['identity'].failedBatches).toBe(1)

    // The failed row is not resurrected by the write that failed on it...
    expect((await adminDb.doc('companyDeletions/victim').get()).exists).toBe(false)
    // ...and the two it shared a chunk with are done, which is the claim that
    // matters: one bad row costs one row, not a chunk of 490.
    for (const id of ['survivor-1', 'survivor-2']) {
      const row = (await adminDb.doc(`companyDeletions/${id}`).get()).data()!
      expect(row.requestedByName).toBeNull()
      expect(row.identityRedactedAt).toBeInstanceOf(Timestamp)
    }
  })

  it('leaves an un-redacted row with NO marker, so the next sweep picks it up again', async () => {
    await seedDueRows(['retry-me'])

    const db = getTestFunctionsDb()
    const { restore } = breakFirstBatchCommit(db, async () => {
      await adminDb.doc('companyDeletions/retry-me').delete()
      throw new Error('simulated batch commit failure')
    })
    try {
      await purgeCompanyDeletionLogsSweep(db)
    } finally {
      restore()
    }

    // Re-create the row exactly as it was, as a restore-from-PITR or a
    // re-appearing document would: it must be eligible again. A marker written
    // outside the redaction write would have made it invisible forever.
    await seedDueRows(['retry-me'])
    const second = await purgeCompanyDeletionLogsSweep(db)
    expect(second.redacted).toBe(1)
    expect(second.failedRows).toBe(0)

    const row = (await adminDb.doc('companyDeletions/retry-me').get()).data()!
    expect(row.requestedByUid).toBeNull()
  })

  it('survives a malformed operatorActions entry instead of failing the whole chunk', async () => {
    // `operatorActions` is written by step 6 code that does not exist yet. An
    // entry missing a field, or not an object at all, would make a
    // pass-through redaction emit `undefined` — which the Admin SDK rejects
    // outright, failing the shared WriteBatch and taking up to 489 innocent
    // rows with it, every Monday, forever. Blanked rather than skipped: the
    // safe direction for something that might be carrying a note.
    await adminDb.doc('companyDeletions/malformed').set({
      ...dueRow('malformed'),
      operatorActions: [
        { action: 'note_added', byUid: 'op-1', byName: 'Olga', at: new Date().toISOString(), note: 'secret' },
        { byUid: 'op-2', byName: 'Bo', note: 'no action, no at' },
        'not an object at all',
      ],
    })
    await seedDueRows(['bystander'])

    const result = await purgeCompanyDeletionLogsSweep(getTestFunctionsDb())
    expect(result.failedRows).toBe(0)
    expect(result.failedBatches).toBe(0)
    expect(result.redacted).toBe(2)

    const row = (await adminDb.doc('companyDeletions/malformed').get()).data()!
    expect(row.operatorActions).toHaveLength(3)
    for (const entry of row.operatorActions as Record<string, unknown>[]) {
      expect(entry.byUid).toBeNull()
      expect(entry.byName).toBeNull()
      expect('note' in entry).toBe(false)
      expect(typeof entry.action).toBe('string')
      expect(typeof entry.at).toBe('string')
    }
    expect(JSON.stringify(row)).not.toContain('secret')
    expect(JSON.stringify(row)).not.toContain('Olga')

    // And the row that merely shared the batch is untouched by any of it.
    const bystander = (await adminDb.doc('companyDeletions/bystander').get()).data()!
    expect(bystander.identityRedactedAt).toBeInstanceOf(Timestamp)
  })

  it('THE SCHEDULED FUNCTION THROWS when rows were left un-redacted', async () => {
    // The only mechanism that makes a systematic failure visible as anything
    // other than a log line. Nothing else in this suite calls the wrapper at
    // all, so without this test it could be deleted outright and the job would
    // go on reporting success while redacting nothing.
    await seedDueRows(['doomed'])

    const db = getTestFunctionsDb()
    const { restore } = breakFirstBatchCommit(db, async () => {
      await adminDb.doc('companyDeletions/doomed').delete()
      throw new Error('simulated batch commit failure')
    })

    try {
      await expect(
        purgeCompanyDeletionLogs.run({ scheduleTime: new Date().toISOString() } as never),
      ).rejects.toThrow(/could not be redacted/)
    } finally {
      restore()
    }
  })

  it('does NOT throw when every row was redacted, however many chunks had to be rescued', async () => {
    await seedDueRows(['fine-1', 'fine-2'])

    const db = getTestFunctionsDb()
    const { restore } = breakFirstBatchCommit(db, async () => {
      throw new Error('simulated batch commit failure')
    })

    try {
      // A rescued chunk is not an incident. Alarming on it would train whoever
      // reads these to ignore the alarm that means data was left behind.
      await purgeCompanyDeletionLogs.run({ scheduleTime: new Date().toISOString() } as never)
    } finally {
      restore()
    }

    const row = (await adminDb.doc('companyDeletions/fine-1').get()).data()!
    expect(row.identityRedactedAt).toBeInstanceOf(Timestamp)
  })
})
