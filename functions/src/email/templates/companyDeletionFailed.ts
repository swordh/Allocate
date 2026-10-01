import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

/**
 * Who this particular mail is going to — NOT who requested the deletion,
 * NOT who is an admin in general, but which one this SPECIFIC recipient is,
 * since the footer sentence has to be true for her specifically. See
 * `applyFailedTransition`'s docblock (failDeletion.ts) for when each is
 * used: `'admin'` for every admin still on the company, `'requester'` only
 * for the `ledger.requestedByEmail` fallback sent when no admin remains
 * (`mode: 'window'` only).
 */
export type CompanyDeletionFailedRecipientRole = 'admin' | 'requester';

export interface CompanyDeletionFailedData {
  companyName: string;
  requestedAtFormatted: string;
  failedAtFormatted: string;
  /**
   * Deep link into the app, e.g. `https://app.allocate.at/` — same
   * `openUrl` pattern as companyDeletionCancelled's data, built by the
   * caller with `appUrl('/')` rather than hardcoded here, because
   * templates in this file are pure functions with no access to
   * `process.env` and the domain differs per environment (alpha/beta/prod
   * — see functions/src/appUrl.ts).
   */
  openUrl: string;
  /** See `CompanyDeletionFailedRecipientRole` above — picks the footer sentence. */
  recipientRole: CompanyDeletionFailedRecipientRole;
  /**
   * Whether the ledger's `completedPhases` actually includes `'stripe'` at
   * the moment this mail is queued. Review fix: the original copy always
   * said "Billing has already been stopped", which is only true once the
   * stripe phase has run. An operator's "mark as failed" can fire on a row
   * that never got past `requested`/the very start of `executing` (nothing
   * purged yet, including Stripe), and `no_progress` detection can trip on
   * a purge stuck IN the stripe phase itself. Caller computes this from
   * `ledger.completedPhases?.includes('stripe')` — this template never
   * guesses.
   */
  billingStopped: boolean;
}

/**
 * "Something went wrong" mail — issue #331/#335. Sent once per request
 * (`applyFailedTransition` in failDeletion.ts gates it on
 * `!ledger.failedNotifiedAt`) to every admin still on the company, or to the
 * original requester's own address when none remain and the request was
 * `mode: 'window'` — see that function's docblock.
 *
 * DELIBERATELY UNLIKE the other three deletion mails (Requested/Reminder/
 * Cancelled): no date promise ("this will be finished by ___") and no cancel
 * link. Neither is true here — a failed purge has already run partway
 * through, may have already cancelled Stripe and deleted part of the
 * company's data, and "cancel" would falsely suggest the customer can still
 * stop something that already happened. The one honest thing this mail can
 * say is that the deletion started, hasn't finished, and someone (Allocate
 * support) is aware and will finish it by hand — which is also why the
 * accent is amber (a stalled process) rather than the red `companyDeleted`
 * uses for an irreversible, completed one.
 */
export function companyDeletionFailedEmail(data: CompanyDeletionFailedData): RenderedEmail {
  const { companyName, requestedAtFormatted, failedAtFormatted, openUrl, recipientRole, billingStopped } = data;

  const subject = `${companyName}'s deletion ran into a problem`;

  const preheader = `The deletion of ${companyName} started but hasn't finished. No action is needed from you.`;

  // Only claimed when it's actually true — see `billingStopped`'s docblock.
  // The neutral fallback still commits to something actionable rather than
  // saying nothing about billing at all.
  const billingLine = billingStopped
    ? 'Billing has already been stopped.'
    : 'If you notice any further charges, contact support.';

  const footerSentence =
    recipientRole === 'admin'
      ? `You are getting this because you are an administrator of ${companyName}.`
      : `You are getting this because you requested the deletion of ${companyName}.`;

  const bodyHtml = `The deletion of <span style="color:#ffffff;">${escapeHtml(
    companyName,
  )}</span>, requested on ${escapeHtml(requestedAtFormatted)}, started but ran into a problem and hasn't finished.<br><br>Some of the company's data may still be stored until it's completed. ${escapeHtml(
    billingLine,
  )} Our support team can see this and will complete the deletion — you do not need to do anything.`;

  const noteHtml =
    'Questions? Contact support and mention the company name — we can look this up from our side.';

  const text = [
    preheader,
    '',
    `The deletion of ${companyName}, requested on ${requestedAtFormatted}, started but ran into a problem and hasn't finished.`,
    '',
    `Some of the company's data may still be stored until it's completed. ${billingLine} Our support team can see this and will complete the deletion — you do not need to do anything.`,
    '',
    `Requested: ${requestedAtFormatted}`,
    `Stalled: ${failedAtFormatted}`,
    '',
    noteHtml,
    '',
    `Open Allocate: ${openUrl}`,
    '',
    footerSentence,
  ].join('\n');

  const html = renderLayout({
    preheader,
    eyebrow: 'DELETION STALLED',
    eyebrowAccent: 'amber',
    hero: ['Needs a', 'closer look'],
    bodyHtml,
    dataRows: [
      { label: 'REQUESTED', value: requestedAtFormatted },
      { label: 'STALLED', value: failedAtFormatted, labelAccent: 'amber' },
    ],
    buttonLabel: 'OPEN ALLOCATE',
    buttonUrl: openUrl,
    noteHtml,
    showFallbackLink: false,
    footerSentence,
  });

  return { subject, html, text };
}
