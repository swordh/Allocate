/**
 * The app-shell deletion banner is member-visible (issue #252 step 6, PR 3) —
 * unlike SubscriptionView's admin-only notice, this one has to say something
 * true to crew too, who are never mailed about a deletion. These
 * tests lock the per-state, per-role copy and — most importantly — that a
 * non-admin is never handed a `cancelHref`, since there is no cancel control
 * on this banner and offering one to someone who cannot use it would be the
 * exact "code claims something untrue" failure mode this PR was warned about.
 */

import { describe, it, expect } from 'vitest'
import { getCompanyDeletionBannerDisplay, type CompanyDeletionBannerData } from '@/lib/companyDeletionBanner'

const TIMEZONE = 'Europe/Stockholm'

function deletion(overrides: Partial<CompanyDeletionBannerData> = {}): CompanyDeletionBannerData {
  return {
    state: 'requested',
    scheduledFor: '2026-09-22T10:00:00.000Z',
    ...overrides,
  }
}

describe('getCompanyDeletionBannerDisplay', () => {
  it('returns null when there is no deletion', () => {
    expect(getCompanyDeletionBannerDisplay(null, 'admin', TIMEZONE)).toBeNull()
    expect(getCompanyDeletionBannerDisplay(null, 'crew', TIMEZONE)).toBeNull()
  })

  describe('state: requested', () => {
    it('gives an admin a cancel link and names the date', () => {
      const d = getCompanyDeletionBannerDisplay(deletion(), 'admin', TIMEZONE)
      expect(d).not.toBeNull()
      expect(d!.cancelHref).toBe('/settings/company')
      expect(d!.message).toContain('22 September 2026')
      expect(d!.tone).toBe('danger')
    })

    it('gives crew the date but no cancel link, and says only an admin can stop it', () => {
      const d = getCompanyDeletionBannerDisplay(deletion(), 'crew', TIMEZONE)
      expect(d!.cancelHref).toBeUndefined()
      expect(d!.message).toContain('22 September 2026')
      expect(d!.message).toContain('Only an administrator can cancel it')
    })

    // The whole reason this banner exists: a booking made in the viewer's
    // own browser zone must not silently show a different calendar date
    // than the company's own bookings are dated in.
    it('renders the scheduled date in the company timezone, not UTC', () => {
      // 2026-09-22T23:30:00Z is already 2026-09-23 in Stockholm (UTC+2 in September).
      const d = getCompanyDeletionBannerDisplay(
        deletion({ scheduledFor: '2026-09-22T23:30:00.000Z' }),
        'admin',
        TIMEZONE,
      )
      expect(d!.message).toContain('23 September 2026')
      expect(d!.message).not.toContain('22 September 2026')
    })

    // app/(app)/layout.tsx can in principle hand down `scheduledFor: ''` if
    // `deletion.state` is present on the company document without
    // `deletion.scheduledFor` (nothing upstream guarantees the pair — see
    // the layout's own comment). formatDateFullInZone renders that as the
    // sentinel '—', which would make "scheduled for deletion on —" a
    // strange, useless sentence — not false, just uninformative. The chosen
    // fix: drop the date clause entirely rather than print the sentinel.
    it('drops the date clause instead of printing "—" when scheduledFor is empty', () => {
      const admin = getCompanyDeletionBannerDisplay(deletion({ scheduledFor: '' }), 'admin', TIMEZONE)
      // The admin copy legitimately contains an em dash as punctuation
      // ("— cancel it below…") — what must NOT appear is the sentinel
      // standing in for a date, i.e. "on —".
      expect(admin!.message).not.toContain('on —')
      expect(admin!.message).toBe(
        "This company is scheduled for deletion. Every member will lose access when it happens — cancel it below if that's not intended.",
      )
      // Still cancelable for an admin — the missing date says nothing about
      // whether `state` is still 'requested'.
      expect(admin!.cancelHref).toBe('/settings/company')

      const crew = getCompanyDeletionBannerDisplay(deletion({ scheduledFor: '' }), 'crew', TIMEZONE)
      expect(crew!.message).not.toContain('on —')
      expect(crew!.message).toBe(
        'This company is scheduled for deletion. Every member, including you, will lose access when it happens. Only an administrator can cancel it.',
      )
    })

    // Same sentinel, reached via an unparseable date instead of an empty one.
    it('drops the date clause for an unparseable scheduledFor too', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ scheduledFor: 'not-a-date' }), 'admin', TIMEZONE)
      expect(d!.message).not.toContain('on —')
      expect(d!.message).toContain('This company is scheduled for deletion.')
    })
  })

  describe('state: executing', () => {
    it('offers no cancel link to an admin — the sweep has already claimed the purge', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'executing' }), 'admin', TIMEZONE)
      expect(d!.cancelHref).toBeUndefined()
      expect(d!.message.toLowerCase()).toContain('no longer be stopped')
    })

    it('offers no cancel link to crew either', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'executing' }), 'crew', TIMEZONE)
      expect(d!.cancelHref).toBeUndefined()
    })

    it('does not quote the (now stale) scheduled date', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'executing' }), 'admin', TIMEZONE)
      expect(d!.message).not.toContain('September')
    })

    // 'executing' still covers a purge that is progressing normally — a row
    // that has actually stalled now mirrors 'failed' instead (issue #331),
    // which is its own describe block below. This message must still avoid
    // promising a timeframe for the ordinary in-progress case, since it says
    // nothing about exactly when the purge will finish.
    it('makes no promise about WHEN access ends', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'executing' }), 'admin', TIMEZONE)
      expect(d!.message.toLowerCase()).not.toContain('shortly')
      expect(d!.message.toLowerCase()).not.toMatch(/\bwill end\b/)
    })
  })

  // Issue #331 fixed `applyFailedTransition` to mirror 'failed' onto
  // `companies/{cid}.deletion.state`, not just the `companyDeletions`
  // ledger — this branch is now reachable from app/(app)/layout.tsx in
  // production, not merely a locked-for-later case.
  describe('state: failed', () => {
    it('does not claim a deletion date — the brief forbids it explicitly', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'failed' }), 'admin', TIMEZONE)
      expect(d!.message).not.toContain('September')
      expect(d!.cancelHref).toBeUndefined()
    })

    it("tells an admin support can see it and will follow up — no action asked of her", () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'failed' }), 'admin', TIMEZONE)
      expect(d!.message.toLowerCase()).toContain('support')
      expect(d!.message.toLowerCase()).toContain('follow up')
    })

    it('tells a non-admin support is already aware, without asking her to do anything', () => {
      const d = getCompanyDeletionBannerDisplay(deletion({ state: 'failed' }), 'crew', TIMEZONE)
      expect(d!.message.toLowerCase()).toContain('support')
      expect(d!.message.toLowerCase()).not.toContain('contact')
    })
  })

  it('falls back to UTC for an unknown timezone and still renders a real date', () => {
    // scheduledFor is 10:00 UTC, so the UTC fallback reads the same calendar
    // day as the Stockholm-zoned tests above — this isn't just "didn't
    // throw", it locks that the fallback still produces a real date rather
    // than silently going blank.
    const d = getCompanyDeletionBannerDisplay(deletion(), 'admin', 'Not/AZone')
    expect(d!.message).toContain('22 September 2026')
  })
})
