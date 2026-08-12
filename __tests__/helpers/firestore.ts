/**
 * Firestore Admin SDK test doubles.
 *
 * Generalises the two mocking patterns that already worked well in this suite:
 *
 *   - path-keyed snapshot lookup, from `wireTransaction` in createBooking.test.ts
 *   - routing a query by its captured `where()` arguments, from the
 *     `collectionGroup` mock in deleteAccount.test.ts
 *
 * The path-blind alternative — `adminDb.doc.mockReturnValue(oneSnapshot)` —
 * cannot express code that reads two different documents in sequence, which is
 * exactly what the unit-tracked booking path does (equipment doc, then unit
 * doc). It also lets a test pass for the wrong reason: the second read silently
 * returns the first document.
 *
 * Callers still own the `vi.mock('@/lib/firebase-admin', ...)` factory; these
 * helpers only wire the returned spies.
 */

import { vi } from 'vitest'

// ── Snapshots ─────────────────────────────────────────────────────────────────

export interface DocRefStub {
  path: string
  id: string
  get: () => Promise<DocSnapStub>
}

export interface DocSnapStub {
  exists: boolean
  id: string
  data: () => Record<string, unknown> | undefined
  ref: DocRefStub
}

/** Document data keyed by full Firestore path. `null` means the doc does not exist. */
export type DocMap = Record<string, Record<string, unknown> | null>

/** A `where()` clause captured from the chain, so queries can be routed by filter. */
export interface Filter {
  field: string
  op: string
  value: unknown
}

export interface QueryContext {
  /** Collection path, or the collection id for a collection group query. */
  path: string
  filters: Filter[]
}

export interface QueryDocInput {
  id: string
  path?: string
  data: Record<string, unknown>
}

/** Decides which documents a query returns, given its path and captured filters. */
export type QueryResolver = (ctx: QueryContext) => QueryDocInput[]

function makeDocRef(path: string, docs: DocMap): DocRefStub {
  const id = path.split('/').pop() ?? path
  const ref: DocRefStub = {
    path,
    id,
    get: async () => makeDocSnap(path, docs),
  }
  return ref
}

export function makeDocSnap(path: string, docs: DocMap): DocSnapStub {
  const data = docs[path] ?? null
  const id = path.split('/').pop() ?? path
  return {
    exists: data !== null,
    id,
    data: () => data ?? undefined,
    ref: makeDocRef(path, docs),
  }
}

export function makeQuerySnap(inputs: QueryDocInput[], docs: DocMap = {}) {
  return {
    empty: inputs.length === 0,
    size: inputs.length,
    docs: inputs.map((d) => ({
      id: d.id,
      data: () => d.data,
      // deleteAccount does batch.delete(doc.ref) and batch.update(doc.ref, ...),
      // so query results must carry a usable reference.
      ref: makeDocRef(d.path ?? d.id, docs),
    })),
  }
}

// ── Batch ─────────────────────────────────────────────────────────────────────

export function makeBatch() {
  return {
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  }
}

// ── Query chain ───────────────────────────────────────────────────────────────

/**
 * A chainable query stub. Every `.where()` returns the same chain with the
 * clause recorded, so the resolver sees all filters regardless of chain depth —
 * unlike a hand-rolled `{ where: () => ({ where: () => ({ get }) }) }`, which
 * silently throws the moment production code adds a third filter.
 */
function makeQueryChain(path: string, resolver: QueryResolver, docs: DocMap) {
  const filters: Filter[] = []

  const run = () => makeQuerySnap(resolver({ path, filters }), docs)

  const chain: Record<string, unknown> = {
    path,
    where(field: string, op: string, value: unknown) {
      filters.push({ field, op, value })
      return chain
    },
    orderBy: () => chain,
    limit: () => chain,
    get: async () => run(),
    count: () => ({
      get: async () => ({ data: () => ({ count: run().docs.length }) }),
    }),
  }

  return chain
}

// ── Wiring ────────────────────────────────────────────────────────────────────

export interface WireDbOptions {
  /** Document data by full path, for `adminDb.doc(path).get()`. */
  docs?: DocMap
  /** Resolves `adminDb.collection(path)` queries. Defaults to returning nothing. */
  query?: QueryResolver
  /** Resolves `adminDb.collectionGroup(id)` queries. Defaults to returning nothing. */
  collectionGroup?: QueryResolver
}

export interface WiredDb {
  doc: ReturnType<typeof vi.fn>
  collection: ReturnType<typeof vi.fn>
  collectionGroup: ReturnType<typeof vi.fn>
  batch: ReturnType<typeof makeBatch>
}

/**
 * Wire an already-mocked `adminDb` so reads resolve by path and queries resolve
 * by their captured filters.
 *
 * Pass the mocked adminDb object itself — the caller's `vi.mock` factory decides
 * which members exist.
 */
export function wireDb(
  adminDb: Record<string, unknown>,
  { docs = {}, query, collectionGroup }: WireDbOptions = {},
): WiredDb {
  const noDocs: QueryResolver = () => []
  const resolveQuery = query ?? noDocs
  const resolveGroup = collectionGroup ?? noDocs

  const docFn = vi.fn((path: string) => makeDocRef(path, docs))

  // A collection reference is both a query root and a doc factory. Path-form
  // reads — adminDb.collection('users/{uid}/memberships').get() — go through
  // the same resolver as filtered ones, with an empty filter list.
  const collectionFn = vi.fn((path: string) => {
    const chain = makeQueryChain(path, resolveQuery, docs) as Record<string, unknown>
    chain['doc'] = (id?: string) => makeDocRef(id ? `${path}/${id}` : `${path}/auto-id`, docs)
    return chain
  })

  const collectionGroupFn = vi.fn((id: string) => makeQueryChain(id, resolveGroup, docs))

  const batch = makeBatch()
  const batchFn = vi.fn(() => batch)

  // Assign fresh spies rather than calling mockImplementation on the existing
  // ones: a `vi.clearAllMocks()` in beforeEach strips implementations but not
  // assignments, so wiring stays valid however the caller orders its setup.
  adminDb['doc'] = docFn
  adminDb['collection'] = collectionFn
  adminDb['collectionGroup'] = collectionGroupFn
  adminDb['batch'] = batchFn

  return { doc: docFn, collection: collectionFn, collectionGroup: collectionGroupFn, batch }
}

/** Convenience: build a resolver that answers one collection path with fixed docs. */
export function queryFor(
  matcher: (ctx: QueryContext) => boolean,
  results: QueryDocInput[],
  fallback: QueryResolver = () => [],
): QueryResolver {
  return (ctx) => (matcher(ctx) ? results : fallback(ctx))
}

/** Read a captured filter's value, e.g. the unitId in `where('unitIds','array-contains',id)`. */
export function filterValue(ctx: QueryContext, field: string): unknown {
  return ctx.filters.find((f) => f.field === field)?.value
}
