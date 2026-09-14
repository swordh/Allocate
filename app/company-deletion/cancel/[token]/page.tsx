import type { Metadata } from 'next'
import { lookupCancelToken } from '@/lib/queries/companyDeletionCancel'
import CancelDeletionView from '@/components/company/CancelDeletionView'

export const metadata: Metadata = {
  title: 'Stop a company deletion — Allocate',
  /*
   * A cancel token is a bearer secret. `noindex, nofollow` keeps the URL out
   * of search results if it is ever pasted somewhere public, and keeps
   * crawlers that respect it from following the page at all. It is a
   * courtesy, not the protection — the token being one-time, expiring with
   * the window, and unable to execute anything is the protection.
   */
  robots: { index: false, follow: false },
}

/**
 * The page behind the cancellation link mailed to administrators (issue #252
 * step 5, PR F2 — design brief "Mailens roll är att varna och att erbjuda
 * avbrytning, aldrig att verkställa").
 *
 * THIS PAGE DOES NOT CANCEL ANYTHING. It reads the token's state and renders
 * a button; only submitting that button — a POST through the
 * `cancelCompanyDeletionByToken` server action — changes anything. Mail
 * scanners, corporate "safe links" rewriters and mail-client prefetchers
 * fetch URLs out of emails without a human involved; a deletion stopped by
 * one of those robots is exactly as wrong as a deletion executed by one. If
 * you ever find yourself moving the cancel call up into this component
 * "to save a click", that is the thing this whole file exists to prevent.
 *
 * No session is required. `/company-deletion` is in proxy.ts's
 * `PUBLIC_PATHS` for the same reason `/invite` and `/auth/action` are: these
 * links are opened from email, usually in a browser that was never signed
 * in. The token is the authorisation, and it carries no privileged data
 * beyond the company's own name.
 */
export default async function CancelCompanyDeletionPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const lookup = await lookupCancelToken(token)

  return (
    <CancelDeletionView
      token={token}
      initialState={lookup.state}
      companyName={lookup.companyName ?? ''}
      scheduledFor={lookup.scheduledFor ?? ''}
      requestedByName={lookup.requestedByName ?? ''}
    />
  )
}
