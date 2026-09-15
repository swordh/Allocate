import { getCompanyDeletionBannerDisplay, type CompanyDeletionBannerData } from '@/lib/companyDeletionBanner'
import ErrorBanner from '@/components/ui/ErrorBanner'
import Button from '@/components/ui/Button'
import type { Role } from '@/types'

interface CompanyDeletionBannerProps {
  deletion: CompanyDeletionBannerData | null
  role: Role
  timezone: string
  /** Forwarded to the underlying `ErrorBanner` — lets the layout give it page spacing without wrapping it in an extra element that would render even when there is nothing to show. */
  className?: string
}

/**
 * The app-shell-wide deletion notice — issue #252 step 6, PR 3. Rendered by
 * `app/(app)/layout.tsx` above `children` on every page under `(app)`, for
 * every member regardless of role, because the design brief requires it:
 * crew and viewers are never mailed when a deletion is requested or
 * cancelled, so this banner is their only warning that the company (and
 * their access to it) has an end date — see "Alla i företaget måste veta" in
 * plan/designbrief-radering-av-konto.md.
 *
 * No dismiss control, by design and on purpose: a member who could dismiss
 * it once would never see it again, and she is exactly the person who got no
 * email about any of this. If that ever needs revisiting, it is a product
 * decision, not something to quietly add here.
 *
 * A Server Component (no `'use client'`) — it renders no interactive state
 * of its own, only a `Button` that is a plain link (see `Button`'s
 * `href`-as-`Link` branch) to the existing settings pages that already carry
 * the real cancel button (`CompanySettingsForm`, `SubscriptionView`). This
 * component does not duplicate that control.
 */
export default function CompanyDeletionBanner({ deletion, role, timezone, className }: CompanyDeletionBannerProps) {
  const display = getCompanyDeletionBannerDisplay(deletion, role, timezone)
  if (!display) return null

  return (
    <ErrorBanner
      tone={display.tone}
      className={className}
      action={
        display.cancelHref ? (
          <Button variant="secondary" size="sm" href={display.cancelHref}>
            REVIEW
          </Button>
        ) : undefined
      }
    >
      {display.message}
    </ErrorBanner>
  )
}
