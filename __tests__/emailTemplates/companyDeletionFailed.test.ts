/**
 * String-level tests for the `companyDeletionFailed` mail template — issue
 * #331/#335. Unlike the other three deletion-lifecycle mails, this one must
 * NOT promise a date ("this will finish by ___") and must NOT offer a
 * cancel link: by the time a purge reaches this state it may have already
 * cancelled Stripe and deleted part of the company's data, so both of those
 * would either lie or point at nothing.
 */
import { describe, expect, it } from 'vitest'
import { companyDeletionFailedEmail } from '../../functions/src/email/templates/companyDeletionFailed'

const BASE = {
  companyName: 'Nordfilm AB',
  requestedAtFormatted: '12 September 2026',
  failedAtFormatted: '20 September 2026',
  openUrl: 'https://app.allocate.at/',
  recipientRole: 'admin' as const,
  billingStopped: true,
}

describe('companyDeletionFailedEmail', () => {
  const result = companyDeletionFailedEmail(BASE)

  it('renders a non-empty subject, html and text', () => {
    expect(result.subject.length).toBeGreaterThan(0)
    expect(result.html.length).toBeGreaterThan(0)
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('names the company and both dates', () => {
    expect(result.text).toContain('Nordfilm AB')
    expect(result.text).toContain('12 September 2026')
    expect(result.text).toContain('20 September 2026')
  })

  it('says no action is needed / support will complete it', () => {
    expect(result.text).toMatch(/support/i)
    expect(result.text).toMatch(/no.*action|nothing.*need/i)
  })

  it('NEGATIVE: never promises a completion date', () => {
    expect(result.text).not.toMatch(/will be (deleted|finished|completed) (on|by)/i)
    expect(result.text).not.toMatch(/by \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)/i)
  })

  it('NEGATIVE: never offers a cancel/stop link', () => {
    expect(result.text.toLowerCase()).not.toContain('cancel')
    expect(result.text.toLowerCase()).not.toContain('stop the deletion')
    expect(result.html.toLowerCase()).not.toContain('cancel')
  })

  it('NEGATIVE: does not contain a bare cancel-token style URL (only the plain openUrl)', () => {
    // The other deletion mails carry a one-time token in their CTA URL
    // (buildCancelUrl); this one only ever gets a plain app URL.
    expect(result.html).toContain(BASE.openUrl)
    expect((result.html.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(2) // button + fallback, but fallback is disabled
  })

  it('escapes HTML in the company name', () => {
    const withMarkup = companyDeletionFailedEmail({ ...BASE, companyName: '<b>Evil</b> Co' })
    expect(withMarkup.html).not.toContain('<b>Evil</b>')
    expect(withMarkup.html).toContain('&lt;b&gt;Evil&lt;/b&gt; Co')
  })

  it('uses an amber, not red, accent — a stalled process, not a completed irreversible one', () => {
    // f4b24a is _shared.ts's amber hex; e5484d is red.
    expect(result.html).toContain('#f4b24a')
    expect(result.html).not.toContain('#e5484d')
  })

  describe('recipientRole footer (review fix)', () => {
    it("admin: footer says 'administrator', not 'requested'", () => {
      const admin = companyDeletionFailedEmail({ ...BASE, recipientRole: 'admin' })
      expect(admin.text).toContain('You are getting this because you are an administrator of Nordfilm AB.')
      expect(admin.text).not.toMatch(/because you requested/i)
      expect(admin.html).toContain('an administrator of')
    })

    it("requester (the requestedByEmail fallback recipient): footer says 'requested', never claims she is an admin", () => {
      const requester = companyDeletionFailedEmail({ ...BASE, recipientRole: 'requester' })
      expect(requester.text).toContain('You are getting this because you requested the deletion of Nordfilm AB.')
      expect(requester.text).not.toMatch(/an administrator/i)
      expect(requester.html).not.toMatch(/an administrator/i)
    })
  })

  describe('billingStopped condition (review fix)', () => {
    it('billingStopped true: states billing has already been stopped', () => {
      const stopped = companyDeletionFailedEmail({ ...BASE, billingStopped: true })
      expect(stopped.text).toContain('Billing has already been stopped.')
      expect(stopped.text).not.toMatch(/further charges/i)
    })

    it('billingStopped false: does NOT claim billing has stopped — neutral line instead', () => {
      const notStopped = companyDeletionFailedEmail({ ...BASE, billingStopped: false })
      expect(notStopped.text).not.toContain('Billing has already been stopped.')
      expect(notStopped.text).toMatch(/further charges/i)
      expect(notStopped.html).not.toContain('Billing has already been stopped.')
    })
  })
})
