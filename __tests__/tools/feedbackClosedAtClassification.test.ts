/**
 * `tools/lib/feedbackClosedAtClassification.js` — the pure classification
 * logic behind `tools/backfill_feedback_closed_at.js` (issue #338 PR 2). A
 * plain CommonJS module (same convention as `tools/lib/mailExpireAtCompute.js`
 * and `tools/lib/mask_pii.js`), imported here via `require()` — Vitest's CJS
 * interop resolves the named exports off its `module.exports` object fine.
 *
 * This suite exists because of a code-review-caught bug in the first
 * version of the backfill script: it matched a closing event by TEXT
 * SUFFIX alone ("→ DONE" / "→ NO ACTION"), which also matches a
 * closed → closed RECLASSIFICATION event ("NO ACTION → DONE") that
 * `updateFeedbackStatus` deliberately does NOT treat as a new closing (see
 * that function's "closed → closed: keep existing closedAt" branch). Taking
 * the most recent SUFFIX match then picks the reclassification time instead
 * of the actual closing time — every scenario below is built to make that
 * exact mistake produce a visibly wrong answer.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CJS tool script, no .d.ts to import against
const { parseStatusChangeEvent, isClosingTransition, latestClosingEventCreatedAt } = require('../../tools/lib/feedbackClosedAtClassification.js')

/** A fake Firestore Timestamp — just enough shape for `.toMillis()` comparisons. */
function ts(millis: number) {
  return { toMillis: () => millis }
}

function event(text: string, millis: number) {
  return { kind: 'event', text, createdAt: ts(millis) }
}

function note(text: string, millis: number) {
  return { kind: 'note', text, createdAt: ts(millis) }
}

describe('parseStatusChangeEvent', () => {
  it('parses the exact wire contract', () => {
    expect(parseStatusChangeEvent('Status changed OPEN → DONE')).toEqual({ from: 'OPEN', to: 'DONE' })
  })

  it('returns null for anything that does not match', () => {
    expect(parseStatusChangeEvent('Priority changed LOW → HIGH')).toBeNull()
    expect(parseStatusChangeEvent('Looked into it')).toBeNull()
    expect(parseStatusChangeEvent('')).toBeNull()
  })
})

describe('isClosingTransition', () => {
  it('open-ish -> closed is a closing transition', () => {
    expect(isClosingTransition('OPEN', 'DONE')).toBe(true)
    expect(isClosingTransition('IN PROGRESS', 'NO ACTION')).toBe(true)
  })

  it('closed -> closed (reclassification) is NOT a closing transition', () => {
    expect(isClosingTransition('DONE', 'NO ACTION')).toBe(false)
    expect(isClosingTransition('NO ACTION', 'DONE')).toBe(false)
  })

  it('closed -> open-ish (reopen) is NOT a closing transition', () => {
    expect(isClosingTransition('DONE', 'OPEN')).toBe(false)
    expect(isClosingTransition('NO ACTION', 'IN PROGRESS')).toBe(false)
  })

  it('open-ish -> open-ish is NOT a closing transition', () => {
    expect(isClosingTransition('OPEN', 'IN PROGRESS')).toBe(false)
  })
})

describe('latestClosingEventCreatedAt', () => {
  it('open → done: a single closing event is picked up', () => {
    const entries = [event('Status changed OPEN → DONE', 1000)]
    expect(latestClosingEventCreatedAt(entries)?.toMillis()).toBe(1000)
  })

  it('open → done → wont_fix: keeps the FIRST close, not the reclassification', () => {
    // This is the exact case the suffix-only bug got wrong: the
    // reclassification event also ends in "→ NO ACTION", so a naive
    // "most recent suffix match" would return 2000 instead of 1000.
    const entries = [
      event('Status changed OPEN → DONE', 1000),
      event('Status changed DONE → NO ACTION', 2000),
    ]
    expect(latestClosingEventCreatedAt(entries)?.toMillis()).toBe(1000)
  })

  it('done → open → done: takes the SECOND close, not the first', () => {
    const entries = [
      event('Status changed OPEN → DONE', 1000),
      event('Status changed DONE → OPEN', 2000), // reopen, not a closing transition
      event('Status changed OPEN → DONE', 3000), // closed again — this is the real closedAt
    ]
    expect(latestClosingEventCreatedAt(entries)?.toMillis()).toBe(3000)
  })

  it('no events at all -> null (caller falls back to submittedAt)', () => {
    expect(latestClosingEventCreatedAt([])).toBeNull()
    expect(latestClosingEventCreatedAt([note('Looked into it', 1000)])).toBeNull()
  })

  it('malformed or unrelated text is ignored, not mistaken for a closing event', () => {
    const entries = [
      event('Priority changed LOW → HIGH', 1000),
      event('garbage', 2000),
      event('', 3000),
      note('Status changed OPEN → DONE', 4000), // right text, wrong kind — must not count
    ]
    expect(latestClosingEventCreatedAt(entries)).toBeNull()
  })

  it('an entry with a missing/malformed createdAt is ignored even if the text matches', () => {
    const entries = [
      { kind: 'event', text: 'Status changed OPEN → DONE', createdAt: null },
      { kind: 'event', text: 'Status changed OPEN → DONE' /* no createdAt */ },
      { kind: 'event', text: 'Status changed OPEN → DONE', createdAt: 'not-a-timestamp' },
    ]
    expect(latestClosingEventCreatedAt(entries)).toBeNull()
  })

  it('picks the closing transition among a mix of unrelated and malformed entries', () => {
    const entries = [
      note('Looked into it', 500),
      event('Priority changed LOW → HIGH', 700),
      event('Status changed OPEN → DONE', 1000),
      { kind: 'event', text: 'Status changed OPEN → DONE', createdAt: null },
    ]
    expect(latestClosingEventCreatedAt(entries)?.toMillis()).toBe(1000)
  })
})

// ── Regression harness for the suffix-only bug ──────────────────────────────
//
// Reimplements the FIRST version's logic (suffix match only, no FROM check)
// to prove it actually gets the two scenarios above wrong — this is the
// "mutation test against the old logic" the code review asked for, kept
// in-tree rather than only run by hand once, so a future refactor that
// accidentally reintroduces suffix-only matching gets caught by CI-adjacent
// review the same way this one was.
function oldSuffixOnlyLatest(entries: Array<{ kind: string; text: string; createdAt: { toMillis: () => number } | null }>) {
  const suffixes = ['→ DONE', '→ NO ACTION']
  let latest: { toMillis: () => number } | null = null
  for (const entry of entries) {
    if (entry.kind !== 'event') continue
    if (typeof entry.text !== 'string') continue
    if (!suffixes.some((s) => entry.text.endsWith(s))) continue
    if (!entry.createdAt || typeof entry.createdAt.toMillis !== 'function') continue
    if (!latest || entry.createdAt.toMillis() > latest.toMillis()) latest = entry.createdAt
  }
  return latest
}

describe('old suffix-only logic (regression harness — proves the bug, not the fix)', () => {
  it('WOULD have picked the reclassification time instead of the first close', () => {
    const entries = [
      event('Status changed OPEN → DONE', 1000),
      event('Status changed DONE → NO ACTION', 2000),
    ]
    // The bug: old logic returns 2000 (wrong — that's a reclassification,
    // not a closing). The fix returns 1000.
    expect(oldSuffixOnlyLatest(entries)?.toMillis()).toBe(2000)
    expect(latestClosingEventCreatedAt(entries)?.toMillis()).toBe(1000)
  })
})
