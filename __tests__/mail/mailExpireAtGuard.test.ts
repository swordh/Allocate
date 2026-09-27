/**
 * Guards issue #325's mail-retention fix from silently regressing: every
 * source file that touches `mail/{id}` documents through `collection('mail')`
 * (or the double-quoted spelling) must also call `mailExpireAt(` — the only
 * way a written `mail` doc gets its Firestore TTL `expireAt` field stamped.
 * There is no CI gate on this repo (see the "Ingen CI eller emulator" project
 * note), so nothing else stops a future writer from being added without the
 * TTL stamp; this test is that stop.
 *
 * ── Why count PER FILE rather than "at least one" ───────────────────────────
 * A file can contain more than one `collection('mail')` write site — e.g.
 * `actions/team.ts` has three (the invite batch, the resend path, the
 * leave-company receipt). A guard that only checked "does this file mention
 * `mailExpireAt` at all" would stay green even if one of three sites lost its
 * call — exactly the class of regression this test exists to catch. So this
 * test counts, per file, how many `collection('mail')` REFERENCES appear
 * outside comments, and how many `mailExpireAt(` CALLS appear, and requires
 * the counts to match exactly.
 *
 * ── Why "outside comments" ───────────────────────────────────────────────────
 * `functions/src/company/failDeletion.ts` has a docblock line that literally
 * reads `db.collection('mail').doc()` as prose, describing what the function
 * below it does — not a second write site. A naive text count would see two
 * `collection('mail')` occurrences in that file for one real write and one
 * `mailExpireAt(` call, permanently red. Lines whose trimmed text starts with
 * `//`, `*` or `/*` are excluded from BOTH the `collection('mail')` reference
 * count and the `mailExpireAt(` call count, for the same reason on each side —
 * a docblock could just as easily narrate `mailExpireAt(now)` in prose while
 * describing what a function does, which would over-count calls the same way
 * an un-filtered `collection('mail')` over-counts references. This is a
 * heuristic (it would miss either pattern at the tail of a genuine code line
 * following a trailing `//` comment, which does not occur anywhere in this
 * codebase today), not a full comment-aware parser — see the mutation-test
 * note below for why that tradeoff is acceptable here.
 *
 * ── Known limitation: a write site that reuses a `collection('mail')` handle ─
 * This test counts, per LINE, how many times the literal `collection('mail')`
 * text appears — it has no notion of a variable that captures the collection
 * reference once and writes through it several times, e.g.
 * `const col = db.collection('mail'); col.add(...); col.add(...);`. Today
 * every one of the twelve writers this fix touches calls `collection('mail')`
 * fresh at each write site (`.doc()`/`.add()` chained directly, or a fresh
 * `const mailRef = …collection('mail').doc()` per iteration), so this never
 * under-counts in practice — but a FUTURE writer that hoists the collection
 * reference into a shared variable and writes multiple docs through it would
 * register as ONE reference in this test while still needing `mailExpireAt(`
 * on each of its several writes; only the aggregate counts would need to
 * match, not a true one-to-one write-site mapping, so such a file could still
 * pass with fewer `mailExpireAt(` calls than actual mail docs written. A
 * reviewer touching a `mail` writer should watch for that pattern by hand;
 * this test does not (and, as a per-line text scan rather than an AST-aware
 * one, structurally cannot) catch it.
 *
 * ── Exclusions ───────────────────────────────────────────────────────────────
 *   - `functions/src/email/mailDelivery.ts` — reads `mail` docs (the retry
 *     sweep's query) and only ROLLS `expireAt` forward on the existing `sent`
 *     update; it never mints a new `mail` doc, so it's exempt from the
 *     per-file count check entirely (handled by its own dedicated test, see
 *     `functions/__tests__/email/mailDelivery.test.ts`).
 *   - `functions/src/email/onMailQueued.ts` — the delivery trigger; reads the
 *     event's own snapshot, never calls `collection('mail')` at all.
 *   - `lib/mail-retention.ts` / `functions/src/email/mailRetention.ts` — the
 *     helper modules themselves.
 *
 * ── Mutation-tested ──────────────────────────────────────────────────────────
 * Verified by hand: deleting any one of `actions/team.ts`'s three
 * `expireAt: mailExpireAt(now)` call sites turns this test red (3 references
 * vs 2 calls); restoring it turns it green again.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../..')
const SCAN_DIRS = ['actions', 'lib', 'app', 'functions/src']

/** Files that legitimately reference `collection('mail')` without minting a
 *  new doc (a reader, or the retention helpers themselves) — see docblock. */
const EXCLUDED_FILES = new Set([
  'functions/src/email/mailDelivery.ts',
  'functions/src/email/onMailQueued.ts',
  'lib/mail-retention.ts',
  'functions/src/email/mailRetention.ts',
])

const MAIL_COLLECTION_RE = /collection\(\s*['"]mail['"]\s*\)/
const MAIL_EXPIRE_AT_CALL_RE = /mailExpireAt\(/

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/** Recursively collects every `.ts`/`.tsx` file under `dir` (repo-relative),
 *  skipping `node_modules`, `.next`, and any `__tests__`/`.test.` file. */
function collectSourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir)
  let entries: string[]
  try {
    entries = readdirSync(abs)
  } catch {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue
    const relPath = join(dir, entry)
    const absPath = join(REPO_ROOT, relPath)
    const stat = statSync(absPath)
    if (stat.isDirectory()) {
      out.push(...collectSourceFiles(relPath))
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.includes('.test.')) {
      out.push(relPath)
    }
  }
  return out
}

interface FileCounts {
  file: string
  mailCollectionRefs: number
  mailExpireAtCalls: number
}

function countMailUsage(relPath: string): FileCounts {
  const content = readFileSync(join(REPO_ROOT, relPath), 'utf8')
  const lines = content.split('\n')

  let mailCollectionRefs = 0
  let mailExpireAtCalls = 0
  for (const line of lines) {
    if (isCommentLine(line)) continue
    if (MAIL_COLLECTION_RE.test(line)) mailCollectionRefs++
    if (MAIL_EXPIRE_AT_CALL_RE.test(line)) mailExpireAtCalls++
  }

  return { file: relPath, mailCollectionRefs, mailExpireAtCalls }
}

describe('mail expireAt guard (issue #325)', () => {
  const allFiles = SCAN_DIRS.flatMap(collectSourceFiles)
  const candidates = allFiles.filter((f) => !EXCLUDED_FILES.has(f))

  const filesTouchingMail = candidates
    .map(countMailUsage)
    .filter((c) => c.mailCollectionRefs > 0)

  it('found at least the known mail-writing files (sanity check that the scan itself works)', () => {
    // If this drops to 0, the scan is broken (wrong paths, wrong regex) —
    // every assertion below would vacuously pass, which is worse than no
    // test at all. Pinning a minimum guards against that silently happening.
    expect(filesTouchingMail.length).toBeGreaterThanOrEqual(9)
  })

  it.each(filesTouchingMail.map((c) => [c.file, c] as const))(
    '%s: every collection(\'mail\') write site has a matching mailExpireAt( call',
    (_file, counts) => {
      expect(counts.mailExpireAtCalls).toBe(counts.mailCollectionRefs)
    },
  )
})
