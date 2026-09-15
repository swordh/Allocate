/**
 * Pure helpers for company deletion (issue #252 step 6, PR 1), shared by the
 * server action and the UI — there is one copy of the confirmation rule, not
 * two, so it is tested from both angles instead of twice over. This file
 * covers `confirmationMatchesCompanyName` at the string level directly;
 * __tests__/company/requestCompanyDeletion.test.ts covers the same cases
 * indirectly, through `requestCompanyDeletion` calling it.
 */

import { describe, it, expect } from 'vitest'
import { confirmationMatchesCompanyName, canCancelCompanyDeletionInProduct } from '@/lib/companyDeletionUi'
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
