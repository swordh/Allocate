/**
 * Pure helpers for company deletion (issue #252 step 6, PR 1), shared by the
 * server action and the UI — there is one copy of the confirmation rule, not
 * two, so it is tested from both angles instead of twice over. This file
 * covers `confirmationMatchesCompanyName` at the string level directly;
 * __tests__/company/requestCompanyDeletion.test.ts covers the same cases
 * indirectly, through `requestCompanyDeletion` calling it.
 */

import { describe, it, expect } from 'vitest'
import { confirmationMatchesCompanyName, canCancelCompanyDeletionInProduct, formatDeletionRequester } from '@/lib/companyDeletionUi'
import type { CompanyDeletion } from '@/types'

describe('confirmationMatchesCompanyName', () => {
  const NAME = 'Rigg & Rep AB'

  it('matches the exact name', () => {
    expect(confirmationMatchesCompanyName(NAME, NAME)).toBe(true)
  })

  it('forgives case and surrounding whitespace', () => {
    expect(confirmationMatchesCompanyName('  rigg & rep ab ', NAME)).toBe(true)
  })

  it('forgives collapsed interior whitespace', () => {
    expect(confirmationMatchesCompanyName('Rigg &  Rep   AB', NAME)).toBe(true)
  })

  it('rejects a different name', () => {
    expect(confirmationMatchesCompanyName('Rigg AB', NAME)).toBe(false)
  })

  it('rejects the literal word DELETE', () => {
    expect(confirmationMatchesCompanyName('DELETE', NAME)).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(confirmationMatchesCompanyName('', NAME)).toBe(false)
  })

  it('rejects whitespace-only input', () => {
    expect(confirmationMatchesCompanyName('   ', NAME)).toBe(false)
  })

  // Mutation guard: a company with no name on file (should not happen, but
  // nothing upstream structurally prevents it) must never be "confirmable"
  // by typing nothing.
  it('never matches when the company name itself is empty', () => {
    expect(confirmationMatchesCompanyName('', '')).toBe(false)
    expect(confirmationMatchesCompanyName('anything', '')).toBe(false)
  })
})

describe('canCancelCompanyDeletionInProduct', () => {
  const BASE: CompanyDeletion = {
    state: 'requested',
    requestId: 'req-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
    requestedByName: 'Anna Admin',
    scheduledFor: '2026-01-08T00:00:00.000Z',
    mode: 'window',
  }

  it('is cancelable while state is "requested"', () => {
    expect(canCancelCompanyDeletionInProduct(BASE)).toBe(true)
  })

  it('is NOT cancelable once state is "executing" — a cancel here would throw in-progress', () => {
    expect(canCancelCompanyDeletionInProduct({ ...BASE, state: 'executing' })).toBe(false)
  })

  it('is NOT cancelable once state is "failed"', () => {
    expect(canCancelCompanyDeletionInProduct({ ...BASE, state: 'failed' })).toBe(false)
  })

  it('is NOT cancelable when there is no deletion at all', () => {
    expect(canCancelCompanyDeletionInProduct(null)).toBe(false)
    expect(canCancelCompanyDeletionInProduct(undefined)).toBe(false)
  })
})

// ── formatDeletionRequester — issue #334 ────────────────────────────────────
//
// Never let an operator-initiated request show the operator's own email to
// a customer. Mirrored, on purpose, by `formatRequesterDisplay` in
// functions/src/company/format.ts — same cases, tested independently there.
describe('formatDeletionRequester', () => {
  it('renders the fixed support string for an operator-sourced request, regardless of requestedByName', () => {
    expect(formatDeletionRequester('operator', 'jocke@allocate.at')).toBe('Allocate support (support@allocate.at)')
  })

  it('never leaks the operator email — the support string does not contain it', () => {
    const result = formatDeletionRequester('operator', 'ops-internal@allocate.at')
    expect(result).not.toContain('ops-internal@allocate.at')
  })

  it('renders requestedByName for an admin-sourced request', () => {
    expect(formatDeletionRequester('admin', 'Anna Admin')).toBe('Anna Admin')
  })

  it('renders requestedByName for a legacy row with no requestSource at all', () => {
    expect(formatDeletionRequester(undefined, 'Anna Admin')).toBe('Anna Admin')
    expect(formatDeletionRequester(null, 'Anna Admin')).toBe('Anna Admin')
  })

  it('falls back to "An administrator" for a null/redacted requestedByName on a non-operator row', () => {
    expect(formatDeletionRequester('admin', null)).toBe('An administrator')
    expect(formatDeletionRequester(undefined, null)).toBe('An administrator')
    expect(formatDeletionRequester(undefined, '')).toBe('An administrator')
  })
})
