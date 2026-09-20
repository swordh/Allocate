import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface CompanyDeletionCancelledData {
  companyName: string;
  /** Whoever cancelled — any admin can, not just the one who requested it. */
  cancelledByName: string;
  cancelledAtFormatted: string;
  /** The date it would have happened on, now moot. */
  scheduledForFormatted: string;
  /** Deep link into the app, e.g. `https://app.allocate.at/`. No token — plain URL. */
  openUrl: string;
}

/**
 * "The deletion was stopped" email — sent to every ADMIN, mirroring
 * companyDeletionRequested's audience. Members are never emailed about the
 * deletion lifecycle; the in-app banner disappearing is their signal.
 *
 * Only reachable for `mode: 'window'` requests, for the same reason
 * `companyDeletionRequested` is: an immediate (sole-member) deletion runs to
 * completion the moment it's requested, so there is no in-between state for
 * an admin to cancel out of. Cancellation as a feature only exists because a
 * window exists.
 */
export function companyDeletionCancelledEmail(data: CompanyDeletionCancelledData): RenderedEmail {
  const { companyName, cancelledByName, cancelledAtFormatted, scheduledForFormatted, openUrl } = data;

  const subject = `The deletion of ${companyName} was stopped`;

  const text = [
    `${cancelledByName} stopped it. Nothing was deleted.`,
    '',
    `${cancelledByName} stopped the deletion of ${companyName} on ${cancelledAtFormatted}. The company, its bookings and its equipment are all still here. Nobody lost anything.`,
    '',
    `Stopped by: ${cancelledByName}, ${cancelledAtFormatted}`,
    `Was due: ${scheduledForFormatted} — cancelled`,
    'Billing: Resumed on the same plan and period. Nothing to re-subscribe.',
    '',
    `Open Allocate: ${openUrl}`,
    '',
    'Only administrators are emailed about deletions. Members see the state in the app.',
  ].join('\n');

  const html = renderLayout({
    preheader: `${cancelledByName} stopped it. Nothing was deleted.`,
    eyebrow: 'DELETION STOPPED',
    eyebrowAccent: 'gray',
    hero: ['Nothing', 'deleted'],
    bodyHtml: `<span style="color:#ffffff;">${escapeHtml(cancelledByName)}</span> stopped the deletion of ${escapeHtml(
      companyName,
    )} on ${escapeHtml(cancelledAtFormatted)}.<br><br>The company, its bookings and its equipment are all still here. Nobody lost anything.`,
    dataRows: [
      { label: 'STOPPED BY', value: `${cancelledByName}, ${cancelledAtFormatted}` },
      { label: 'WAS DUE', value: `${scheduledForFormatted} — cancelled` },
      { label: 'BILLING', value: 'Resumed on the same plan and period. Nothing to re-subscribe.' },
    ],
    buttonLabel: 'OPEN ALLOCATE',
    buttonUrl: openUrl,
    showFallbackLink: false,
    footerSentence: 'Only administrators are emailed about deletions. Members see the state in the app.',
  });

  return { subject, html, text };
}
