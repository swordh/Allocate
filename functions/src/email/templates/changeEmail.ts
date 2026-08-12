import { RenderedEmail } from '../send';
import { renderLayout } from './_shared';

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
    'You asked to sign in to Allocate with this address instead. Confirm the change below — the link is valid for one hour.',
    '',
    `New address: ${newEmail}`,
    '',
    `Confirm the change: ${verifyUrl}`,
    '',
    "If you didn't request this, you can safely ignore this email — nothing will change.",
  ].join('\n');

  const html = renderLayout({
    preheader: 'Confirm the new sign-in address for your Allocate account',
    eyebrow: 'EMAIL CHANGE',
    hero: ['Confirm', 'new email'],
    bodyHtml:
      'You asked to sign in to Allocate with this address instead. Confirm the change below — the link is valid for one hour.',
    dataRow: { label: 'NEW ADDRESS', value: newEmail },
    buttonLabel: 'CONFIRM CHANGE',
    buttonUrl: verifyUrl,
    footerSentence: "If you didn't request this, you can safely ignore this email — nothing will change.",
  });

  return { subject, html, text };
}
