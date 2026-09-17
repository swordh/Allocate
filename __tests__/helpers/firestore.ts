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
  /**
   * Direct (non-batched, non-transactional) writes on a document reference.
   *
   * Spies rather than no-ops so a test can assert what production code wrote
   * outside a batch or transaction — `recordStripeOutcome`
   * (lib/companyDeletionStripe.ts) is the case that forced these to exist: it
   * annotates the ledger with `adminDb.doc(...).update(...)` and swallows its
   * own errors, so before these spies were here the call threw
   * "update is not a function", was caught, and the test saw nothing at all
   * rather than a failure. A missing method on a stub that production code
   * deliberately try/catches is invisible; that is worth knowing about
   * generally, not just here.
   *
   * They resolve rather than mutate `docs` — nothing in this suite reads its
   * own writes back through the same map, and making them write-through would
   * quietly change what every existing test's later reads return.
   */
  update: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  /**
   * `deleteAccount`'s per-uid lock (issue #349, actions/account.ts) uses
   * `DocumentReference.create()` for its atomic acquire — real Firestore
   * throws `{ code: 6 }` (ALREADY_EXISTS) if the doc exists, but this stub
   * always resolves, same as `update`/`set`/`delete` above. A test that needs
   * to exercise the "lock already held" path overrides this per-call, e.g.
   * `vi.mocked(adminDb.doc).mockReturnValueOnce({ ...ref, create: vi.fn().mockRejectedValue(...) })`.
   */
  create: ReturnType<typeof vi.fn>
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
    update: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
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

// ── Transaction ───────────────────────────────────────────────────────────────

export interface TransactionStub {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

/**
 * A `Transaction` stub for code under `adminDb.runTransaction(async (tx) => ...)`.
 *
 * `tx.get(ref)` handles two distinct kinds of `ref`, both of which
 * `lib/companyStats.ts`'s `readMemberCounts` passes it in the same call:
 *
 *   - A plain doc ref (has a `.path`) — resolved against the SAME `docs` map
 *     `wireDb` uses, so a test can wire one `DocMap` and have it answer both
 *     transactional and non-transactional reads.
 *   - An `AggregateQuery`-shaped stub (no `.path`, but has its own `.get()`) —
 *     exactly what `makeQueryChain`'s `.count()` already returns for
 *     `adminDb.collection(path).count()` / `.where(...).count()`. Real
 *     `Transaction.get(AggregateQuery)` takes the query and resolves it
 *     itself; here that resolution already lives on the stub object (bound to
 *     whatever `query` resolver `wireDb` was given), so `tx.get` just awaits
 *     it — no separate aggregate-routing logic needs to be duplicated here.
 *
 * Pair with `wireDb`'s `docs` map (pass the same object to both) and wire
 * `adminDb.runTransaction` in the test:
 *
 *   const docs: DocMap = { ... }
 *   const wired = wireDb(adminDb, { docs, query })
 *   const tx = makeTransaction(docs)
 *   vi.mocked(adminDb.runTransaction).mockImplementation(
 *     (cb) => cb(tx) as never,
 *   )
 */
export function makeTransaction(docs: DocMap = {}): TransactionStub {
  return {
    get: vi.fn(async (ref: { path?: string; get?: () => unknown }) => {
      if (ref && typeof ref.path === 'string') {
        return makeDocSnap(ref.path, docs)
      }
      if (ref && typeof ref.get === 'function') {
        return ref.get()
      }
      throw new Error('makeTransaction: tx.get() called with an unrecognized ref shape')
    }),
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

// ── Query chain ───────────────────────────────────────────────────────────────

/**
 * A chainable query stub. `.where()` returns a NEW chain carrying the parent's
 * filters plus the new clause — never mutates the parent's own filter list —
 * so the resolver sees the right filters regardless of chain depth, the same
 * way a hand-rolled `{ where: () => ({ where: () => ({ get }) }) }` would, but
 * without throwing the moment production code adds a third filter.
 *
 * This immutability is load-bearing, not cosmetic: real Firestore
 * `Query`/`CollectionReference` objects are immutable — `.where()` returns a
 * new query rather than mutating the one it was called on — and more than
 * one production code path relies on exactly that (lib/companyStats.ts's
 * `readMemberCounts`, and `lib/queries/deletionOutcomes.ts`'s
 * `readCompanyCounts`): both take ONE collection reference and derive TWO
 * independent queries from it — an unfiltered `.count()` and a
 * `.where('role','==','admin').count()` — run concurrently via `Promise.all`.
 * A mock that pushed into one shared array would make the "unfiltered" count
 * retroactively pick up the admin filter too (both `count().get()` calls read
 * the array lazily, after both synchronous `.where()`/`.count()` calls have
 * already run), silently halving the reported member count in exactly that
 * scenario. Branching instead of mutating is what makes those two counts
 * independent here the same way they are against real Firestore.
 */
function makeQueryChain(path: string, resolver: QueryResolver, docs: DocMap, filters: Filter[] = []) {
  const run = () => makeQuerySnap(resolver({ path, filters }), docs)

  const chain: Record<string, unknown> = {
    path,
    where(field: string, op: string, value: unknown) {
      return makeQueryChain(path, resolver, docs, [...filters, { field, op, value }])
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
