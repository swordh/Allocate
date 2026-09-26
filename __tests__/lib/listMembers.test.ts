/**
 * `listMembers` (lib/queries/members.ts) — role normalisation on read
 * (issue #397/#398). A member doc with a stale `viewer` role, or any other
 * invalid role, must come back through `toRole` as `crew`, not leak the raw
 * value or fall silent as `undefined`.
 *
 * Firebase Admin is mocked; no network calls are made.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {},
  adminAuth: {},
}))

import { listMembers } from '@/lib/queries/members'
import { adminDb } from '@/lib/firebase-admin'

type MockAdminDb = { collection: ReturnType<typeof vi.fn> }

function mockMembersCollection(docs: Array<{ id: string; data: FirebaseFirestore.DocumentData }>) {
  const snap = {
    docs: docs.map(({ id, data }) => ({
      id,
      ref: { path: `companies/co-1/members/${id}` },
      data: () => data,
    })),
  }
  const collectionRef = { get: vi.fn().mockResolvedValue(snap) }
  ;(adminDb as unknown as MockAdminDb).collection = vi.fn().mockReturnValue(collectionRef)
}

describe('listMembers — role normalisation', () => {
  it('normalises a stale viewer role to crew', async () => {
    mockMembersCollection([
      { id: 'uid-1', data: { uid: 'uid-1', name: 'Anna', email: 'anna@example.com', role: 'viewer', joinedAt: '2026-01-01T00:00:00.000Z' } },
    ])

    const members = await listMembers('co-1')

    expect(members[0]?.role).toBe('crew')
  })

  it('normalises an invalid role value to crew', async () => {
    mockMembersCollection([
      { id: 'uid-2', data: { uid: 'uid-2', name: 'Erik', email: 'erik@example.com', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' } },
    ])

    const members = await listMembers('co-1')

    expect(members[0]?.role).toBe('crew')
  })

  it('falls back to crew when role is missing entirely', async () => {
    mockMembersCollection([
      { id: 'uid-3', data: { uid: 'uid-3', name: 'Jonas', email: 'jonas@example.com', joinedAt: '2026-01-01T00:00:00.000Z' } },
    ])

    const members = await listMembers('co-1')

    expect(members[0]?.role).toBe('crew')
  })

  it('passes a valid admin role through unchanged', async () => {
    mockMembersCollection([
      { id: 'uid-4', data: { uid: 'uid-4', name: 'Sara', email: 'sara@example.com', role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' } },
    ])

    const members = await listMembers('co-1')

    expect(members[0]?.role).toBe('admin')
  })
})
