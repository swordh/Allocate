import { RenderedEmail } from '../send';
import { renderLayout } from './_shared';

export interface VerifyEmailData {
  verifyUrl: string;
}

/**
 * "Confirm your email address" email. The verifyUrl is our own
 * allocate.at/auth/action link carrying the Firebase oobCode — never Firebase's
 * own /__/auth/action link.
 */
export function verifyEmailEmail(data: VerifyEmailData): RenderedEmail {
  const { verifyUrl } = data;

  const subject = 'Confirm your email address';

  const text = [
    'Confirm this address to finish setting up your Allocate account. The link is valid for one hour.',
    '',
    `Confirm your email: ${verifyUrl}`,
    '',
    "If you didn't create an Allocate account, you can safely ignore this email.",
  ].join('\n');

  const html = renderLayout({
    preheader: 'Confirm your email address to finish setting up your Allocate account',
    eyebrow: 'ACCOUNT SETUP',
    hero: ['Confirm', 'your email'],
    bodyHtml: 'Confirm this address to finish setting up your Allocate account. The link is valid for one hour.',
    buttonLabel: 'CONFIRM EMAIL',
    buttonUrl: verifyUrl,
    footerSentence: "If you didn't create an Allocate account, you can safely ignore this email.",
  });

  return { subject, html, text };
}
