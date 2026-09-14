import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface CompanyDeletionRequestedData {
  companyName: string;
  /** Who asked for the deletion — always an admin (see PR F's role guard). */
  requestedByName: string;
  /** Formatted for display, e.g. "12 September 2026". Caller formats the date. */
  requestedAtFormatted: string;
  /** Formatted for display, e.g. "19 September 2026". */
  scheduledForFormatted: string;
  /** Short form for the hero/eyebrow, e.g. "19 Sep". */
  scheduledForShort: string;
  /** One-time, admin-scoped cancel link (`companyDeletionCancelTokens/{token}`). */
  stopUrl: string;
  /** "23 bookings, 14 pieces of equipment, access for all 6 members". */
  whatGoesSummary: string;
}

/**
 * "A deletion has been requested" email — sent to every ADMIN of the company
 * (never to regular members; the design brief is explicit that members only
 * ever learn about this from the in-product banner). Fired from
 * `onDocumentCreated('companyDeletions/{requestId}')`, once per admin.
 *
 * Only for `mode: 'window'` requests. A sole-member company is deleted
 * immediately (see "Ensam-medlem-vakten" in the plan) — there is no window
 * to describe, nothing to stop, and this template's whole body ("it happens
 * on {date}", "until then nothing changes", the STOP button) would be
 * false for that case. The caller must not queue this template for an
 * immediate-mode request; that recipient gets `companyDeleted` once the
 * purge finishes, same as everyone else, just without the wait.
 */
export function companyDeletionRequestedEmail(data: CompanyDeletionRequestedData): RenderedEmail {
  const { companyName, requestedByName, requestedAtFormatted, scheduledForFormatted, scheduledForShort, stopUrl, whatGoesSummary } =
    data;

  const subject = `${companyName} is set to be deleted on ${scheduledForFormatted}`;

  const text = [
    `${requestedByName} requested the deletion of ${companyName}.`,
    '',
    `It happens on ${scheduledForFormatted}, and it cannot be undone after that. Until then nothing changes: people can book, edit and sign in as usual. Any administrator — including you — can stop it.`,
    '',
    `Requested by: ${requestedByName}, ${requestedAtFormatted}`,
    `Deleted on: ${scheduledForFormatted}`,
    `What goes: ${whatGoesSummary}`,
    'Billing: Paused until then. Stop it and the same plan resumes; let it run and paid time is not refunded.',
    '',
    `Stop the deletion: ${stopUrl}`,
    '',
    'This link only stops the deletion. Nothing in this email can delete anything — that can only be done from inside Allocate.',
    '',
    `You are getting this because you are an administrator of ${companyName}.`,
  ].join('\n');

  const html = renderLayout({
    preheader: `${requestedByName} requested the deletion of ${companyName}. You can stop it.`,
    eyebrow: 'DELETION REQUESTED',
    hero: ['Deleted', scheduledForShort],
    bodyHtml: `${escapeHtml(requestedByName)} asked for <span style="color:#ffffff;">${escapeHtml(
      companyName,
    )}</span> to be deleted. It happens on ${escapeHtml(
      scheduledForFormatted,
    )}, and it cannot be undone after that.<br><br>Until then nothing changes: people can book, edit and sign in as usual. Any administrator — including you — can stop it.`,
    dataRows: [
      { label: 'REQUESTED BY', value: `${requestedByName}, ${requestedAtFormatted}` },
      { label: 'DELETED ON', value: scheduledForFormatted, labelAccent: 'amber' },
      { label: 'WHAT GOES', value: whatGoesSummary },
      { label: 'BILLING', value: 'Paused until then. Stop it and the same plan resumes; let it run and paid time is not refunded.' },
    ],
    buttonLabel: 'STOP THE DELETION',
    buttonUrl: stopUrl,
    noteHtml: 'This link only stops the deletion. Nothing in this email can delete anything — that can only be done from inside Allocate.',
    footerSentence: `You are getting this because you are an administrator of ${companyName}.`,
  });

  return { subject, html, text };
}
