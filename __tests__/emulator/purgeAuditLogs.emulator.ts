/**
 * Blocker 5 (PR E review): `deletionAuditLog` carries two entry shapes —
 * self-service deletion (`deletedAt`) and, since issue #252 step 5, a
 * stranded member's account-deletion SCHEDULE (`scheduledAt`). The original
 * retention job queried only `deletedAt`, so every scheduling row was
 * invisible to it forever. This proves both shapes now age out under the
 * same 12-month rule, and that recent rows of either shape are left alone.
 */
import { Timestamp } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'
import { adminDb } from '@/lib/firebase-admin'
import { purgeOldAuditLogsSweep } from '../../functions/src/admin/purgeAuditLogs'
import { getTestFunctionsDb } from '../../functions/src/testSupport/emulatorInit'

const THIRTEEN_MONTHS_AGO = Timestamp.fromMillis(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000)
const RECENT = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000)

describe('purgeOldAuditLogsSweep', () => {
  it('purges old rows of BOTH shapes (deletedAt and scheduledAt) and leaves recent ones alone', async () => {
    await adminDb.collection('deletionAuditLog').doc('old-self-deletion').set({
      userIdHash: 'hash1',
      deletedAt: THIRTEEN_MONTHS_AGO,
      triggeredBy: 'user_self',
    })
    await adminDb.collection('deletionAuditLog').doc('old-stranded-schedule').set({
      userIdHash: 'hash2',
      scheduledAt: THIRTEEN_MONTHS_AGO,
      scheduledFor: THIRTEEN_MONTHS_AGO,
      triggeredBy: 'company_deletion_stranded_member',
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
      triggeredBy: 'company_deletion_stranded_member',
    })

    const db = getTestFunctionsDb()
    const result = await purgeOldAuditLogsSweep(db)
    expect(result.purged).toBe(2)

    expect((await adminDb.collection('deletionAuditLog').doc('old-self-deletion').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('old-stranded-schedule').get()).exists).toBe(false)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-self-deletion').get()).exists).toBe(true)
    expect((await adminDb.collection('deletionAuditLog').doc('recent-stranded-schedule').get()).exists).toBe(true)
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
