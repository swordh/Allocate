/**
 * `purgeOldAuditLogsSweep`'s time budget — `functions/src/admin/purgeAuditLogs.ts`
 * (issue #435). The sweep chunks `refs` into `BATCH_LIMIT`-sized (490)
 * `WriteBatch`es; `opts.deadlineExceeded` is checked before every
 * `batch.commit()`, never mid-chunk (a single `batch.commit()` is atomic and
 * cannot be interrupted). A fake `Firestore` — same hand-rolled style as
 * `purgeOldFeedbackSweepFailures.test.ts` — drives 500 matching docs so the
 * sweep is forced into two chunks (490 + 10) without needing the real
 * 500-write Firestore limit anywhere near it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { purgeOldAuditLogsSweep } from '../../functions/src/admin/purgeAuditLogs'

const TOTAL_DOCS = 500 // BATCH_LIMIT (490) + 10, forcing exactly two chunks.

function makeDocs(count: number, prefix = 'deletionAuditLog/row') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, ref: { path: `${prefix}-${i}` } }))
}

function makeFakeDb(matchingDocs: ReturnType<typeof makeDocs>) {
  const commits: number[] = []
  const batch = () => {
    let size = 0
    return {
      delete: vi.fn(() => {
        size += 1
      }),
      commit: vi.fn(async () => {
        commits.push(size)
      }),
    }
  }
  const db = {
    collection: vi.fn(() => ({
      where: vi.fn((field: string) => ({
        get: vi.fn().mockResolvedValue({ docs: field === 'deletedAt' ? matchingDocs : [] }),
      })),
    })),
    batch: vi.fn(batch),
  }
  return { db, commits }
}

describe('purgeOldAuditLogsSweep — time budget (issue #435)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('no deadlineExceeded passed: behaves exactly as before, both chunks commit', async () => {
    const { db, commits } = makeFakeDb(makeDocs(TOTAL_DOCS))

    const result = await purgeOldAuditLogsSweep(db as unknown as Parameters<typeof purgeOldAuditLogsSweep>[0])

    expect(result).toEqual({ purged: TOTAL_DOCS, unfinished: 0 })
    expect(commits).toEqual([490, 10])
  })

  it('deadline exceeded before the SECOND chunk: first chunk commits, the rest is unfinished, not purged', async () => {
    const { db, commits } = makeFakeDb(makeDocs(TOTAL_DOCS))
    let calls = 0
    // false on the first pre-commit check (chunk 1 goes through), true from
    // the second check onward (chunk 2 is dropped uncommitted).
    const deadlineExceeded = () => {
      calls += 1
      return calls > 1
    }

    const result = await purgeOldAuditLogsSweep(db as unknown as Parameters<typeof purgeOldAuditLogsSweep>[0], {
      deadlineExceeded,
    })

    expect(result).toEqual({ purged: 490, unfinished: 10 })
    // Only the first chunk's batch.commit() actually ran — the second chunk
    // was never built or committed once the deadline tripped.
    expect(commits).toEqual([490])
  })

  it('deadline already exceeded before the FIRST chunk: nothing commits, everything is unfinished', async () => {
    const { db, commits } = makeFakeDb(makeDocs(TOTAL_DOCS))

    const result = await purgeOldAuditLogsSweep(db as unknown as Parameters<typeof purgeOldAuditLogsSweep>[0], {
      deadlineExceeded: () => true,
    })

    expect(result).toEqual({ purged: 0, unfinished: TOTAL_DOCS })
    expect(commits).toEqual([])
  })

  it('no matching docs: returns purged 0, unfinished 0 regardless of the deadline predicate', async () => {
    const { db, commits } = makeFakeDb([])

    const result = await purgeOldAuditLogsSweep(db as unknown as Parameters<typeof purgeOldAuditLogsSweep>[0], {
      deadlineExceeded: () => true,
    })

    expect(result).toEqual({ purged: 0, unfinished: 0 })
    expect(commits).toEqual([])
  })
})
