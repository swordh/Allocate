/**
 * `TeamSettingsPage` (app/(app)/settings/team/page.tsx) — role normalisation
 * on the pending-invitations read (issue #397/#398 follow-up).
 *
 * `listMembers` (lib/queries/members.ts) already runs a member doc's role
 * through `toRole` before it reaches the client. This page builds its
 * `pendingInvites` prop straight off `companies/{cid}/invitations` docs
 * without going through any such guard — a legacy `role: 'viewer'`
 * invitation (or any other invalid value) would reach
 * `TeamSettingsView`'s `ROLE_LABELS[role]` lookup, which has no entry for
 * anything but 'admin'/'crew', and render a blank chip. This test proves
 * the page normalises `role` on every pending invitation the same way.
 *
 * `TeamSettingsView` itself is mocked out — the page just needs to pass it
 * the right props via `React.createElement`, which never invokes the
 * component, so nothing here renders any actual UI or needs jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement } from 'react'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    collection: vi.fn(),
    doc: vi.fn(),
  },
  adminAuth: {},
}))

vi.mock('@/lib/dal', () => ({
  getVerifiedSession: vi.fn(),
}))

vi.mock('@/lib/queries/members', () => ({
  listMembers: vi.fn(),
}))

vi.mock('@/components/settings/TeamSettingsView', () => ({
  default: vi.fn(() => null),
}))

import TeamSettingsPage from '@/app/(app)/settings/team/page'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { listMembers } from '@/lib/queries/members'
import TeamSettingsView from '@/components/settings/TeamSettingsView'

const COMPANY_ID = 'company-abc'

function wireInvitations(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  const invitationsRef = {
    where: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({
        docs: docs.map(({ id, data }) => ({
          id,
          ref: { path: `companies/${COMPANY_ID}/invitations/${id}` },
          data: () => data,
        })),
      }),
    }),
  }
  const companyDocRef = { get: vi.fn().mockResolvedValue({ data: () => ({}) }) }

  vi.mocked(adminDb.collection).mockReturnValue(invitationsRef as never)
  vi.mocked(adminDb.doc).mockReturnValue(companyDocRef as never)
}

describe('TeamSettingsPage — pending invitation role normalisation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getVerifiedSession).mockResolvedValue({
      uid: 'admin-1',
      email: 'admin@example.com',
      activeCompanyId: COMPANY_ID,
      role: 'admin',
    } as never)
    vi.mocked(listMembers).mockResolvedValue([])
  })

  it('normalises a legacy viewer role on a pending invitation to crew', async () => {
    wireInvitations([
      {
        id: 'inv-1',
        data: {
          email: 'legacy@example.com',
          role: 'viewer',
          status: 'pending',
          invitedBy: 'admin-1',
          invitedByName: 'Admin',
          invitedAt: '2026-01-01T00:00:00.000Z',
          token: 'super-secret-token',
        },
      },
    ])

    const element = (await TeamSettingsPage()) as ReactElement<{ pendingInvites: Array<{ role: string }> }>

    expect(element.props.pendingInvites).toHaveLength(1)
    expect(element.props.pendingInvites[0].role).toBe('crew')
    expect(vi.mocked(TeamSettingsView)).not.toHaveBeenCalled() // React.createElement never invokes it
  })

  it('normalises an invalid role on a pending invitation to crew', async () => {
    wireInvitations([
      {
        id: 'inv-2',
        data: {
          email: 'garbage@example.com',
          role: 'owner',
          status: 'pending',
          invitedBy: 'admin-1',
          invitedByName: 'Admin',
          invitedAt: '2026-01-01T00:00:00.000Z',
          token: 'super-secret-token-2',
        },
      },
    ])

    const element = (await TeamSettingsPage()) as ReactElement<{ pendingInvites: Array<{ role: string }> }>

    expect(element.props.pendingInvites[0].role).toBe('crew')
  })

  it('passes a valid admin role through unchanged', async () => {
    wireInvitations([
      {
        id: 'inv-3',
        data: {
          email: 'fine@example.com',
          role: 'admin',
          status: 'pending',
          invitedBy: 'admin-1',
          invitedByName: 'Admin',
          invitedAt: '2026-01-01T00:00:00.000Z',
          token: 'super-secret-token-3',
        },
      },
    ])

    const element = (await TeamSettingsPage()) as ReactElement<{ pendingInvites: Array<{ role: string }> }>

    expect(element.props.pendingInvites[0].role).toBe('admin')
  })

  it('never leaks the invitation token into the pendingInvites prop', async () => {
    wireInvitations([
      {
        id: 'inv-4',
        data: {
          email: 'secret@example.com',
          role: 'crew',
          status: 'pending',
          invitedBy: 'admin-1',
          invitedByName: 'Admin',
          invitedAt: '2026-01-01T00:00:00.000Z',
          token: 'must-not-leak',
        },
      },
    ])

    const element = (await TeamSettingsPage()) as ReactElement<{ pendingInvites: Array<Record<string, unknown>> }>

    expect(element.props.pendingInvites[0]).not.toHaveProperty('token')
  })
})
