/**
 * String-level tests for the `companyDeleted` mail template's three
 * `accountStatus` branches — added after a PR E review found `scheduled`
 * silently sharing `kept`'s copy ("Untouched. You can start your own
 * company or wait to be invited."), which is false for a stranded member
 * whose account is actively counting down to deletion, and whose only
 * notice this email is.
 *
 * Deliberately asserts on the RENDERED TEXT, not just that something comes
 * back — the review's own diagnosis of how this slipped through in the
 * first place: "Steg 4-regressionen slank igenom just för att testerna
 * kontrollerade att något returnerades, inte vad det sa."
 */
import { describe, expect, it } from 'vitest'
import { companyDeletedEmail } from '../../functions/src/email/templates/companyDeleted'

const BASE = {
  companyName: 'Nordfilm AB',
  requestedByName: 'Erik Lundqvist',
  requestedAtFormatted: '12 September 2026',
  deletedAtFormatted: '19 September 2026',
  mode: 'window' as const,
  ctaUrl: 'https://allocate.at/',
}

describe('companyDeletedEmail', () => {
  describe('accountStatus: kept', () => {
    const result = companyDeletedEmail({ ...BASE, accountStatus: 'kept', ctaUrl: 'https://allocate.at/company/new' })

    it('says the account is untouched, not scheduled or deleted', () => {
      expect(result.text).toMatch(/Untouched/)
      expect(result.text).not.toMatch(/scheduled for deletion/i)
      expect(result.text).not.toMatch(/your account.*deleted/i)
    })

    it('does not mention a company she does not have', () => {
      // The old shared copy invited her to "start your own company or wait
      // to be invited" — nonsensical for someone who already has one.
      expect(result.text).not.toMatch(/wait to be invited/i)
    })
  })

  describe('accountStatus: scheduled', () => {
    const result = companyDeletedEmail({
      ...BASE,
      accountStatus: 'scheduled',
      pendingDeletionScheduledForFormatted: '19 October 2026',
      ctaUrl: 'https://allocate.at/login',
    })

    it('states plainly that the account will be deleted, with the exact date', () => {
      expect(result.text).toMatch(/scheduled (for|to be) deletion? on 19 October 2026|deleted on 19 October 2026/i)
    })

    it('offers both real options: export data, or start a new company', () => {
      expect(result.text).toMatch(/export/i)
      expect(result.text).toMatch(/new company/i)
    })

    it('tells her she can still sign in before the deadline', () => {
      expect(result.text).toMatch(/sign in/i)
    })

    // The exact regression this test suite exists to catch: the scheduled
    // branch must never fall back to kept's copy.
    it('NEGATIVE: never says the account is untouched', () => {
      expect(result.text).not.toMatch(/Untouched/)
    })

    it('NEGATIVE: never tells her to wait to be invited', () => {
      expect(result.text).not.toMatch(/wait to be invited/i)
    })

    it('NEGATIVE: never claims the account has already been deleted (it has not — thirty days remain)', () => {
      expect(result.text).not.toMatch(/your account (has been|went) deleted/i)
      expect(result.text).not.toMatch(/nothing (left )?to sign back into/i)
    })

    it('the CTA points at sign-in, not signup — her account still exists', () => {
      expect(result.text).toContain('https://allocate.at/login')
      expect(result.html).toContain('https://allocate.at/login')
    })

    it('throws rather than silently omitting the date when the caller forgets to pass it', () => {
      expect(() =>
        companyDeletedEmail({ ...BASE, accountStatus: 'scheduled', ctaUrl: 'https://allocate.at/login' }),
      ).toThrow(/pendingDeletionScheduledForFormatted/)
    })
  })

  describe('accountStatus: already_gone', () => {
    const result = companyDeletedEmail({ ...BASE, accountStatus: 'already_gone', ctaUrl: 'https://allocate.at/signup' })

    it('says the account is deleted with no undo', () => {
      expect(result.text).toMatch(/account.*deleted/i)
      expect(result.text).toMatch(/nothing (left )?to sign back into/i)
    })

    it('NEGATIVE: never mentions a thirty-day schedule (this account is already gone, not counting down)', () => {
      expect(result.text).not.toMatch(/scheduled/i)
      expect(result.text).not.toMatch(/thirty days/i)
    })

    it('the CTA points at signup, not login — there is no account to sign into', () => {
      expect(result.text).toContain('https://allocate.at/signup')
    })
  })

  it('every branch renders a non-empty subject and html body', () => {
    for (const accountStatus of ['kept', 'scheduled', 'already_gone'] as const) {
      const result = companyDeletedEmail({
        ...BASE,
        accountStatus,
        ctaUrl: 'https://allocate.at/',
        ...(accountStatus === 'scheduled' ? { pendingDeletionScheduledForFormatted: '19 October 2026' } : {}),
      })
      expect(result.subject.length).toBeGreaterThan(0)
      expect(result.html.length).toBeGreaterThan(0)
      expect(result.text.length).toBeGreaterThan(0)
    }
  })
})
