import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface ChangeEmailData {
  verifyUrl: string;
  /** The new address the user is switching to (shown for confirmation). */
  newEmail: string;
}

/**
 * "Confirm your new email address" email, sent to the NEW address during an
 * email-change. The verifyUrl is our own allocate.at/auth/action link carrying
 * the Firebase oobCode (mode=verifyAndChangeEmail).
 */
export function changeEmailEmail(data: ChangeEmailData): RenderedEmail {
  const { verifyUrl, newEmail } = data;

  const subject = 'Confirm your new email address';

  const text = [
    `You asked to change your Allocate sign-in email to ${newEmail}.`,
    '',
    `Confirm the change: ${verifyUrl}`,
    '',
    'If you didn’t request this, you can safely ignore this email — nothing will change.',
  ].join('\n');

  const html = renderLayout({
    heading: 'Confirm your new email address',
    introHtml: `You asked to change your Allocate sign-in email to <strong>${escapeHtml(newEmail)}</strong>.`,
    buttonLabel: 'Confirm change',
    buttonUrl: verifyUrl,
    footnote: 'If you didn’t request this, you can safely ignore this email — nothing will change.',
  });

  return { subject, html, text };
}
