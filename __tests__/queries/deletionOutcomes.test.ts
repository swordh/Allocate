/**
 * lib/queries/deletionOutcomes.ts — direct unit tests.
 *
 * Before this file, every edge case this module documents (missing counter
 * doc → aggregate fallback, missing company doc → skipped, a `members === 0`
 * company, the `close` live-confirmation hardening) was only exercised
 * indirectly through __tests__/account/deleteAccount.test.ts, which asserts
 * `deleteAccount`'s user-facing STRING, not this function's return shape.
 * That meant a bug in `getDeletionOutcomes` itself could pass every
 * `deleteAccount` test as long as the final message happened to come out
 * right — these tests call the function directly and pin down its actual
 * return values, per the coordinator's review.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  wireDb,
  filterValue,
  type DocMap,
  type QueryResolver,
  type QueryDocInput,
  type DocRefStub,
} from '../helpers/firestore'

vi.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    doc: vi.fn(),
    collection: vi.fn(),
    collectionGroup: vi.fn(),
  },
}))

import { getDeletionOutcomes } from '@/lib/queries/deletionOutcomes'
import { adminDb } from '@/lib/firebase-admin'

const UID = 'user-1'

interface CompanyFixture {
  /** Default true. `false` simulates a stale users/{uid}/memberships/{cid}
   * pointer whose company document was deleted. */
  exists?: boolean
  name?: string
  /** companies/{cid}/_meta/memberCounts. Omit to force the aggregate fallback. */
  metaCounts?: { members: number; admins: number }
  /** Members subcollection docs — used for the aggregate fallback AND for the
   * `close` live-confirmation read, regardless of whether `metaCounts` is set. */
  members?: QueryDocInput[]
  /** Throws when this company's document is read. */
  companyReadError?: Error
  /** Throws when this company's `_meta/memberCounts` document is read. */
  metaReadError?: Error
}

interface Scenario {
  memberships: Array<{ companyId: string; role: string }>
  companies?: Record<string, CompanyFixture>
}

function wireScenario(scenario: Scenario) {
  const docs: DocMap = {}

  for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
    const exists = fixture.exists ?? true
    docs[`companies/${companyId}`] = exists ? { name: fixture.name ?? companyId } : null
    if (fixture.metaCounts) {
      docs[`companies/${companyId}/_meta/memberCounts`] = fixture.metaCounts
    }
  }

  const membershipDocs: QueryDocInput[] = scenario.memberships.map((m, i) => ({
    id: `membership-${i}`,
    path: `users/${UID}/memberships/membership-${i}`,
    data: m,
  }))

  const query: QueryResolver = (ctx) => {
    if (ctx.path === `users/${UID}/memberships`) return membershipDocs

    const membersMatch = ctx.path.match(/^companies\/([^/]+)\/members$/)
    if (membersMatch) {
      const fixture = scenario.companies?.[membersMatch[1] as string]
      const allMembers = fixture?.members ?? []
      const roleFilter = filterValue(ctx, 'role')
      return roleFilter
        ? allMembers.filter((d) => (d.data as { role?: string }).role === roleFilter)
        : allMembers
    }

    return []
  }

  const wired = wireDb(adminDb as unknown as Record<string, unknown>, { docs, query })

  // Per-company read failures (company doc / memberCounts doc) are wired
  // AFTER wireDb, wrapping its `doc` mock: everything else still resolves
  // through the normal DocMap-backed path.
  const resolveDocNormally = wired.doc.getMockImplementation() as unknown as (path: string) => DocRefStub
  vi.mocked(adminDb.doc).mockImplementation(((path: string) => {
    for (const [companyId, fixture] of Object.entries(scenario.companies ?? {})) {
      if (fixture.companyReadError && path === `companies/${companyId}`) {
        return { path, id: companyId, get: async () => { throw fixture.companyReadError } }
      }
      if (fixture.metaReadError && path === `companies/${companyId}/_meta/memberCounts`) {
        return { path, id: 'memberCounts', get: async () => { throw fixture.metaReadError } }
      }
    }
    return resolveDocNormally(path)
  }) as unknown as typeof adminDb.doc)

  return { docs, wired }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getDeletionOutcomes', () => {
  it('classifies "leave" for a crew member in a company with other people', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: { 'company-A': { name: 'Acme', metaCounts: { members: 5, admins: 2 } } },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome).toEqual({
      companyId: 'company-A',
      companyName: 'Acme',
      role: 'crew',
      memberCount: 5,
      otherAdminCount: 2,
      outcome: 'leave',
    })
  })

  it('classifies "leave" for an admin among other admins', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { name: 'Acme', metaCounts: { members: 5, admins: 2 } } },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome?.outcome).toBe('leave')
    // otherAdminCount excludes the caller: 2 admins total, 1 other.
    expect(outcome?.otherAdminCount).toBe(1)
  })

  it('classifies "blocked" for the sole admin among other members', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { name: 'Acme', metaCounts: { members: 3, admins: 1 } } },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome).toEqual({
      companyId: 'company-A',
      companyName: 'Acme',
      role: 'admin',
      memberCount: 3,
      otherAdminCount: 0,
      outcome: 'blocked',
    })
  })

  it('classifies "close" for the sole member of their own company', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': {
          name: 'Solo Co',
          metaCounts: { members: 1, admins: 1 },
          members: [{ id: UID, data: { role: 'admin' } }],
        },
      },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome?.outcome).toBe('close')
    expect(outcome?.memberCount).toBe(1)
  })

  it('classifies "close" when the counter reports 0 members (an empty/corrupt company)', async () => {
    // members === 0 is a degenerate reading (a company always has at least
    // its own creator), but the classification must still be `close`
    // (`members <= 1`), not throw or silently fall through to `leave`.
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': { name: 'Empty Co', metaCounts: { members: 0, admins: 0 }, members: [] },
      },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome?.outcome).toBe('close')
    expect(outcome?.memberCount).toBe(0)
  })

  it('falls back to a live aggregate when _meta/memberCounts does not exist', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'crew' }],
      companies: {
        'company-A': {
          name: 'Acme',
          // No metaCounts — forces the aggregate branch.
          members: [
            { id: 'a', data: { role: 'admin' } },
            { id: 'b', data: { role: 'crew' } },
            { id: 'c', data: { role: 'crew' } },
          ],
        },
      },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome).toMatchObject({ memberCount: 3, otherAdminCount: 1, outcome: 'leave' })
  })

  it('skips a company whose document no longer exists (stale membership pointer) — reports nothing for it', async () => {
    wireScenario({
      memberships: [
        { companyId: 'company-orphaned', role: 'admin' },
        { companyId: 'company-A', role: 'crew' },
      ],
      companies: {
        'company-orphaned': { exists: false },
        'company-A': { name: 'Acme', metaCounts: { members: 2, admins: 1 } },
      },
    })

    const outcomes = await getDeletionOutcomes(UID)

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.companyId).toBe('company-A')
  })

  it('reports "unknown" when the company document read itself fails', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: { 'company-A': { companyReadError: new Error('Firestore unavailable') } },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome).toMatchObject({ companyId: 'company-A', outcome: 'unknown' })
    // 'unknown' must never claim a company name or headcount it couldn't read.
    expect(outcome?.companyName).toBe('')
    expect(outcome?.memberCount).toBe(0)
  })

  it('reports "unknown" (distinct from "blocked") when the memberCounts read fails but the company itself read fine', async () => {
    wireScenario({
      memberships: [{ companyId: 'company-A', role: 'admin' }],
      companies: {
        'company-A': { name: 'Acme', metaReadError: new Error('Firestore unavailable') },
      },
    })

    const [outcome] = await getDeletionOutcomes(UID)

    expect(outcome?.outcome).toBe('unknown')
    // The company name WAS readable — 'unknown' only means the counts
    // couldn't be, so there's no reason to blank out what we do know.
    expect(outcome?.companyName).toBe('Acme')
  })

  // ── close-outcome hardening (issue #252 point 1 follow-up) ──────────────────
  //
  // `close` is the one classification issue #252 Part 2 will wire to an
  // irreversible action (deleting the company along with the account), so —
  // unlike every other outcome — a `members <= 1` reading from the counter
  // gets confirmed against a live aggregate before being trusted.

  describe('close-outcome live confirmation', () => {
    it('does not log a mismatch when the counter and the live aggregate agree', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      wireScenario({
        memberships: [{ companyId: 'company-A', role: 'admin' }],
        companies: {
          'company-A': {
            name: 'Solo Co',
            metaCounts: { members: 1, admins: 1 },
            members: [{ id: UID, data: { role: 'admin' } }],
          },
        },
      })

      await getDeletionOutcomes(UID)

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'close_outcome_counter_mismatch' }),
      )
      errorSpy.mockRestore()
    })

    it('lets the LIVE count win, and logs the mismatch, when the counter says <= 1 but the company actually has more members', async () => {
      // The counter is stale-LOW: it claims this user is alone, but three
      // member docs actually exist. Trusting the counter here would (in a
      // world where `close` means "delete the company") destroy two other
      // people's company along with this user's account over a bad counter
      // read — this confirmation read is exactly what prevents that.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      wireScenario({
        memberships: [{ companyId: 'company-A', role: 'admin' }],
        companies: {
          'company-A': {
            name: 'Acme',
            metaCounts: { members: 1, admins: 1 },
            members: [
              { id: 'a', data: { role: 'admin' } },
              { id: 'b', data: { role: 'crew' } },
              { id: 'c', data: { role: 'crew' } },
            ],
          },
        },
      })

      const [outcome] = await getDeletionOutcomes(UID)

      // The live aggregate (3 members) wins over the stale counter (1) —
      // this is NOT 'close' any more, and admins (still read from the
      // counter, at 1) makes it 'blocked' instead.
      expect(outcome?.memberCount).toBe(3)
      expect(outcome?.outcome).toBe('blocked')
      expect(errorSpy).toHaveBeenCalledWith(
        '[lib/queries/deletionOutcomes]',
        expect.objectContaining({
          companyId: 'company-A',
          counterMembers: 1,
          liveMembers: 3,
          action: 'close_outcome_counter_mismatch',
        }),
      )
      errorSpy.mockRestore()
    })

    it('does NOT re-confirm when the aggregate fallback already produced the "1" reading (it is already live)', async () => {
      // No metaCounts doc at all — readCompanyCounts's own aggregate
      // fallback IS a live read. A second confirmation read here would just
      // repeat the same query for nothing, so it must not happen (and
      // nothing here would give a different answer if it did — this checks
      // the "don't bother" branch, not correctness of the result).
      const membersCollectionSpy = vi.fn()
      wireScenario({
        memberships: [{ companyId: 'company-A', role: 'admin' }],
        companies: {
          'company-A': {
            name: 'Solo Co',
            // No metaCounts — aggregate fallback path.
            members: [{ id: UID, data: { role: 'admin' } }],
          },
        },
      })
      const originalCollection = vi.mocked(adminDb.collection).getMockImplementation()!
      vi.mocked(adminDb.collection).mockImplementation((path: string) => {
        if (path === 'companies/company-A/members') membersCollectionSpy()
        return originalCollection(path)
      })

      const [outcome] = await getDeletionOutcomes(UID)

      expect(outcome?.outcome).toBe('close')
      // ONE `adminDb.collection(...)` call — readCompanyCounts derives both
      // the unfiltered and the admin-filtered `.count()` from that SAME
      // reference via `.where()` (immutable branching, not a second
      // `.collection()` call). A confirmation read would show up as a
      // SECOND `adminDb.collection('companies/company-A/members')` call,
      // which this asserts never happens.
      expect(membersCollectionSpy).toHaveBeenCalledTimes(1)
    })
  })
})
