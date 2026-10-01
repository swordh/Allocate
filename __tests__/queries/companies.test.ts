/**
 * lib/queries/companies.ts — direct unit tests, same pattern as
 * __tests__/queries/deletionOutcomes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { wireDb, type DocMap, type QueryResolver, type QueryDocInput, type DocRefStub } from '../helpers/firestore'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
  },
}))

import { listUserCompanies } from '@/lib/queries/companies'
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-1'

interface CompanyFixture {
  /** Default true. `false` simulates a stale users/{uid}/memberships/{cid}
   * pointer whose company document was deleted. */
  exists?: boolean
  name?: string
  /** Throws when this company's document is read. */
  companyReadError?: Error
}

interface Scenario {
  memberships: Array<{ companyId: string }>
  companies?: Record<string, CompanyFixture>
}

function wireScenario(scenario: Scenario) {
  const docs: DocMap = {}

  for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
    const exists = fixture.exists ?? true
    docs[`companies/${companyId}`] = exists ? { name: fixture.name ?? companyId } : null
  }

  const membershipDocs: QueryDocInput[] = scenario.memberships.map((m, i) => ({
    id: `membership-${i}`,
    path: `users/${UID}/memberships/membership-${i}`,
    data: m,
  }))

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `users/${UID}/memberships`) return membershipDocs
    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

  const resolveDocNormally = wired.doc.getMockImplementation() as unknown as (path: string) => DocRefStub
  vi.mocked(adminDb.doc).mockImplementation(((path: string) => {
    for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
      if (fixture.companyReadError && path === `companies/${companyId}`) {
        return { path, id: companyId, get: async () => { throw fixture.companyReadError } }
      }
    }
    return resolveDocNormally(path)
  }) as unknown as typeof adminDb.doc)

  return { docs, wired }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listUserCompanies', () => {
  it('returns id + name for every live membership', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A' }, { companyId: 'company-B' }],
      companies: {
        'company-A': { name: 'Acme' },
        'company-B': { name: 'Nordfilm AB' },
      },
    })

    const companies = await listUserCompanies(UID)

    expect(companies).toEqual([
      { id: 'company-A', name: 'Acme' },
      { id: 'company-B', name: 'Nordfilm AB' },
    ])
  })

  it('returns an empty list for a user with no memberships', async () => {
    wireScenario({ memberships: [] })

    const companies = await listUserCompanies(UID)

    expect(companies).toEqual([])
  })

  it('skips a stale membership pointer whose company document no longer exists', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A' }, { companyId: 'company-gone' }],
      companies: {
        'company-A': { name: 'Acme' },
        'company-gone': { exists: false },
      },
    })

    const companies = await listUserCompanies(UID)

    expect(companies).toEqual([{ id: 'company-A', name: 'Acme' }])
  })

  it('skips a company whose document read throws, without failing the whole list', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A' }, { companyId: 'company-broken' }],
      companies: {
        'company-A': { name: 'Acme' },
        'company-broken': { companyReadError: new Error('boom') },
      },
    })

    const companies = await listUserCompanies(UID)

    expect(companies).toEqual([{ id: 'company-A', name: 'Acme' }])
  })
})
