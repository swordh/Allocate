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
    'We received a request to reset the password for your Allocate account.',
    '',
    `Reset your password: ${resetUrl}`,
    '',
    'If you didn’t request this, you can safely ignore this email — your password won’t change.',
  ].join('\n');

  const html = renderLayout({
    heading: 'Reset your password',
    introHtml: 'We received a request to reset the password for your Allocate account.',
    buttonLabel: 'Reset password',
    buttonUrl: resetUrl,
    footnote: 'If you didn’t request this, you can safely ignore this email — your password won’t change.',
  });

  return { subject, html, text };
}
