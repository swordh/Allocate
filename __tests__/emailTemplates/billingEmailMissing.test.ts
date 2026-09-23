/**
 * String-level tests for the `billingEmailMissing` mail template
 * (fix/stripe-anonymise-billing-contact) — sent to every admin of a company
 * whose Stripe customer lost its billing email, first by
 * `runAccountDeletion`'s Stripe billing-contact anonymisation
 * (actions/account.ts) and then weekly by
 * `functions/src/company/billingEmailReminder.ts` for as long as it stays
 * unset.
 *
 * The one thing this mail must NEVER do is name or otherwise identify
 * whoever caused the address to go missing — the trigger is always one
 * specific member deleting her own account, but the recipient (another
 * admin) has no reason to be told that, and every existing deletion-lifecycle
 * mail in this codebase already draws that same line.
 */
import { describe, expect, it } from 'vitest'
import { billingEmailMissingEmail } from '../../functions/src/email/templates/billingEmailMissing'

const BASE = {
  companyName: 'Nordfilm AB',
  settingsUrl: 'https://app.allocate.at/settings/subscription',
}

describe('billingEmailMissingEmail', () => {
  it('escapes the company name in the HTML body', () => {
    const result = billingEmailMissingEmail({
      ...BASE,
      companyName: 'A & B <Film> AB',
      isReminder: false,
    })

    expect(result.html).not.toContain('A & B <Film> AB')
    expect(result.html).toContain('A &amp; B &lt;Film&gt; AB')
    // Plain text is never escaped.
    expect(result.text).toContain('A & B <Film> AB')
  })

  it('includes the settings link in both the button and the plain-text body', () => {
    const result = billingEmailMissingEmail({ ...BASE, isReminder: false })

    expect(result.html).toContain(BASE.settingsUrl)
    expect(result.text).toContain(BASE.settingsUrl)
  })

  describe('isReminder: false (the first mail)', () => {
    const result = billingEmailMissingEmail({ ...BASE, isReminder: false })

    it('does not use reminder wording', () => {
      expect(result.subject).not.toMatch(/reminder/i)
      // "still has..." is the reminder-specific phrasing (the state has
      // persisted since a prior mail) — the plain word "reminder" alone can
      // legitimately appear in the body copy (the weekly-repeat note below
      // says "you'll get a reminder..." on the first mail too).
      expect(result.text).not.toMatch(/still has no billing email/i)
    })

    it('states the company has no billing email', () => {
      expect(result.subject).toMatch(/no billing email/i)
      expect(result.text).toMatch(/no billing email/i)
    })
  })

  describe('isReminder: true (a repeat)', () => {
    const result = billingEmailMissingEmail({ ...BASE, isReminder: true })

    it('uses reminder wording distinct from the first mail', () => {
      expect(result.subject).toMatch(/reminder/i)
      expect(result.text).toMatch(/still has no billing email/i)
    })
  })

  it('explains WHAT is missing and WHERE to fix it, without naming anyone', () => {
    const result = billingEmailMissingEmail({ ...BASE, isReminder: false })

    expect(result.text).toMatch(/invoices? (or|and) receipts?/i)
    expect(result.text).toMatch(/settings.*subscription.*manage billing/i)
  })

  it('mentions switching companies first for an admin of more than one', () => {
    const result = billingEmailMissingEmail({ ...BASE, isReminder: false })

    expect(result.text).toMatch(/more than one company/i)
    expect(result.text).toMatch(/switch to/i)
  })

  it('tells the recipient this repeats weekly until a billing email is added, in both html and text', () => {
    for (const isReminder of [false, true]) {
      const result = billingEmailMissingEmail({ ...BASE, isReminder })
      expect(result.text).toMatch(/weekly.*until a billing email is added/i)
      expect(result.html).toMatch(/weekly.*until a billing email is added/i)
    }
  })

  it('NEGATIVE: never names or otherwise identifies a deleted person', () => {
    for (const isReminder of [false, true]) {
      const result = billingEmailMissingEmail({ ...BASE, isReminder })
      expect(result.text).not.toMatch(/delete|deleted|deleting/i)
      expect(result.html).not.toMatch(/delete|deleted|deleting/i)
    }
  })

  it('every variant renders a non-empty subject, html and text', () => {
    for (const isReminder of [false, true]) {
      const result = billingEmailMissingEmail({ ...BASE, isReminder })
      expect(result.subject.length).toBeGreaterThan(0)
      expect(result.html.length).toBeGreaterThan(0)
      expect(result.text.length).toBeGreaterThan(0)
    }
  })
})
