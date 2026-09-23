/**
 * Blocker 5 (PR E review): `deletionAuditLog` carries four entry shapes —
 * self-service deletion (`deletedAt`), a stranded member's account-deletion
 * SCHEDULE since issue #252 step 5 (`scheduledAt`), that schedule being
 * CLEARED since issue #252 step 6's `strandedAccountSweep` because she
 * turned out to still have a membership (`clearedAt`), and a FAILED
 * self-service deletion attempt since issue #358 (`failedAt`). The original
 * retention job queried only `deletedAt`, so every scheduling row was
 * invisible to it forever — the same defect resurfaced for `clearedAt` when
 * it was introduced without a matching query, and would have resurfaced
 * again for `failedAt` had it not been added alongside it here. This proves
 * all four shapes now age out under the same 12-month rule, and that recent
 * rows of any shape are left alone.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeOldAuditLogsSweep } from '../../functions/src/admin/purgeAuditLogs'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'
import {
  TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
  TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED,
} from '../../functions/src/deletionAuditLogTriggers'

const THIRTEEN_MONTHS_AGO = Timestamp.fromMillis(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000)
const RECENT = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000)

describe('purgeOldAuditLogsSweep', () => {
  it('purges old rows of ALL FOUR shapes (deletedAt, scheduledAt, clearedAt, failedAt) and leaves recent ones alone', async () => {
    await adminDb.collection('deletionAuditLog').doc('old-self-deletion').set({
      userIdHash: 'hash1',
      deletedAt: THIRTEEN_MONTHS_AGO,
      triggeredBy: 'user_self',
    })
    await adminDb.collection('deletionAuditLog').doc('old-stranded-schedule').set({
      userIdHash: 'hash2',
      scheduledAt: THIRTEEN_MONTHS_AGO,
      scheduledFor: THIRTEEN_MONTHS_AGO,
      triggeredBy: TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED,
    })
    await adminDb.collection('deletionAuditLog').doc('old-stranded-cleared').set({
      userIdHash: 'hash6',
      clearedAt: THIRTEEN_MONTHS_AGO,
      requestId: 'some-req',
      triggeredBy: TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
    })
    // issue #358: a FAILED self-service deletion attempt row.
    await adminDb.collection('deletionAuditLog').doc('old-failed-deletion').set({
      userIdHash: 'hash8',
      failedAt: THIRTEEN_MONTHS_AGO,
      triggeredBy: 'user_self',
      outcome: 'failed',
      failedStep: 'anonymisation',
      errorCode: 'aborted',
      completedCompanies: 1,
      totalCompanies: 1,
    })
    await adminDb.collection('deletionAuditLog').doc('recent-self-deletion').set({
      userIdHash: 'hash3',
      deletedAt: RECENT,
      triggeredBy: 'user_self',
    })
    await adminDb.collection('deletionAuditLog').doc('recent-stranded-schedule').set({
      userIdHash: 'hash4',
      scheduledAt: RECENT,
      scheduledFor: RECENT,
      triggeredBy: TRIGGERED_BY_STRANDED_MEMBER_SCHEDULED,
    })
    await adminDb.collection('deletionAuditLog').doc('recent-stranded-cleared').set({
      userIdHash: 'hash7',
      clearedAt: RECENT,
      requestId: 'some-req-2',
      triggeredBy: TRIGGERED_BY_STRANDED_ACCOUNT_SPARED,
    })
    await adminDb.collection('deletionAuditLog').doc('recent-failed-deletion').set({
      userIdHash: 'hash9',
      failedAt: RECENT,
      triggeredBy: 'user_self',
      outcome: 'failed',
      failedStep: 'membership_removal',
      errorCode: 'unavailable',
      completedCompanies: 0,
      totalCompanies: 2,
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldAuditLogsSweep(db)
    expect(result.purged).toBe(4)

    expect((await adminDb.collection('deletionAuditLog').doc('old-self-deletion').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('old-stranded-schedule').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('old-stranded-cleared').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('old-failed-deletion').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-self-deletion').get()).exists).toBe(true)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-stranded-schedule').get()).exists).toBe(true)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-stranded-cleared').get()).exists).toBe(true)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-failed-deletion').get()).exists).toBe(true)
  })

  it('does nothing when nothing is old enough', async () => {
    await adminDb.collection('deletionAuditLog').doc('recent').set({
      userIdHash: 'hash5',
      deletedAt: RECENT,
      triggeredBy: 'user_self',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldAuditLogsSweep(db)
    expect(result.purged).toBe(0)
    expect((await adminDb.collection('deletionAuditLog').doc('recent').get()).exists).toBe(true)
  })
})
