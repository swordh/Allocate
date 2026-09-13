import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface CompanyDeletionReminderData {
  companyName: string;
  requestedByName: string;
  requestedAtFormatted: string;
  scheduledForFormatted: string;
  /** Whole days left until `scheduledForFormatted`. Used for the hero and copy. */
  daysRemaining: number;
  /** Same one-time, admin-scoped cancel link as the original request email. */
  stopUrl: string;
}

/**
 * "Your deletion window is closing" reminder — sent once, to every admin,
 * when ≤48h remain and no reminder has gone out yet for this request (the
 * sweep sets `remindedAt` in the same transaction it queues this mail, so
 * re-running the sweep never sends a second one).
 *
 * Not part of the design handoff — Claude Design flagged this mail as
 * undesigned. Copy below is written to match the tone of the other three
 * (companyDeletionRequested/-Cancelled/companyDeleted) and is meant to be
 * read and approved before this ships, not treated as final.
 */
export function companyDeletionReminderEmail(data: CompanyDeletionReminderData): RenderedEmail {
  const { companyName, requestedByName, requestedAtFormatted, scheduledForFormatted, daysRemaining, stopUrl } = data;
  const dayWord = daysRemaining === 1 ? 'day' : 'days';

  const subject = `${daysRemaining} ${dayWord} left before ${companyName} is deleted`;

  const text = [
    `${companyName} is still set to be deleted on ${scheduledForFormatted} — ${daysRemaining} ${dayWord} from now.`,
    '',
    `${requestedByName} requested it on ${requestedAtFormatted} and nobody has stopped it since. Any administrator — including you — still can, right up until it happens.`,
    '',
    `Requested by: ${requestedByName}, ${requestedAtFormatted}`,
    `Deleted on: ${scheduledForFormatted}`,
    `Days left: ${daysRemaining}`,
    '',
    `Stop the deletion: ${stopUrl}`,
    '',
    'This link only stops the deletion. Nothing in this email can delete anything — that can only be done from inside Allocate.',
    '',
    `You are getting this because you are an administrator of ${companyName}.`,
  ].join('\n');

  const html = renderLayout({
    preheader: `${daysRemaining} ${dayWord} left to stop the deletion of ${companyName}.`,
    eyebrow: 'DELETION REMINDER',
    hero: [`${daysRemaining} ${dayWord}`, 'left'],
    bodyHtml: `<span style="color:#ffffff;">${escapeHtml(
      companyName,
    )}</span> is still set to be deleted on ${escapeHtml(scheduledForFormatted)} — ${daysRemaining} ${dayWord} from now.<br><br>${escapeHtml(
      requestedByName,
    )} requested it on ${escapeHtml(requestedAtFormatted)} and nobody has stopped it since. Any administrator — including you — still can, right up until it happens.`,
    dataRows: [
      { label: 'REQUESTED BY', value: `${requestedByName}, ${requestedAtFormatted}` },
      { label: 'DELETED ON', value: scheduledForFormatted, labelAccent: 'amber' },
      { label: 'DAYS LEFT', value: `${daysRemaining}`, labelAccent: 'amber' },
    ],
    buttonLabel: 'STOP THE DELETION',
    buttonUrl: stopUrl,
    noteHtml: 'This link only stops the deletion. Nothing in this email can delete anything — that can only be done from inside Allocate.',
    footerSentence: `You are getting this because you are an administrator of ${companyName}.`,
  });

  return { subject, html, text };
}
