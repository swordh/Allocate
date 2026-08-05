import { RenderedEmail } from '../send';
import { renderLayout } from './_shared';

export interface ResetPasswordData {
  resetUrl: string;
}

/**
 * "Reset your password" email. The resetUrl is our own allocate.at/auth/action
 * link carrying the Firebase oobCode (mode=resetPassword).
 */
export function resetPasswordEmail(data: ResetPasswordData): RenderedEmail {
  const { resetUrl } = data;

  const subject = 'Reset your Allocate password';

  const text = [
    'A password reset was requested for this account. Set a new password below — the link is valid for one hour.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    "If you didn't request this, you can safely ignore this email — your password won't change.",
  ].join('\n');

  const html = renderLayout({
    preheader: 'Set a new password for your Allocate account',
    eyebrow: 'PASSWORD RESET',
    hero: ['Reset your', 'password'],
    bodyHtml:
      'A password reset was requested for this account. Set a new password below — the link is valid for one hour.',
    buttonLabel: 'RESET PASSWORD',
    buttonUrl: resetUrl,
    footerSentence: "If you didn't request this, you can safely ignore this email — your password won't change.",
  });

  return { subject, html, text };
}
