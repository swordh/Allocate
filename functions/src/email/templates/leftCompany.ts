import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml } from './_shared';

export interface LeftCompanyData {
  companyName: string;
  /** Where the CTA points — the caller (actions/team.ts's leaveCompany) builds this from NEXT_PUBLIC_APP_URL. */
  ctaUrl: string;
}

/**
 * Receipt mailed to a user immediately after they leave a company
 * themselves (issue #352, actions/team.ts's `leaveCompany`) — distinct from
 * `companyDeleted.ts`, which is sent when the whole COMPANY is gone. Leaving
 * changes nothing about the company itself; only this one person's access.
 */
export function leftCompanyEmail(data: LeftCompanyData): RenderedEmail {
  const { companyName, ctaUrl } = data;
  const firstWord = companyName.trim().split(/\s+/)[0] || companyName;

  const subject = `You've left ${companyName}`;
  const preheader = `You no longer have access to ${companyName}.`;

  const bodyHtml = `You are no longer a member of <span style="color:#ffffff;">${escapeHtml(
    companyName,
  )}</span>. Your access to its bookings, equipment and team ended immediately, on every device.`;

  const text = [
    preheader,
    '',
    `You are no longer a member of ${companyName}. Your access to its bookings, equipment and team ended immediately, on every device.`,
    '',
    'ACCESS: Removed now, everywhere.',
    'YOUR BOOKINGS: Stay in the company, anonymised — your name comes off them.',
    'COMING BACK: Only if an administrator invites you again.',
    '',
    `OPEN ALLOCATE: ${ctaUrl}`,
    '',
    `You are getting this because you just left ${companyName}.`,
  ].join('\n');

  const html = renderLayout({
    preheader,
    eyebrow: 'LEFT COMPANY',
    eyebrowAccent: 'gray',
    hero: [firstWord, 'without you'],
    bodyHtml,
    dataRows: [
      { label: 'ACCESS', value: 'Removed now, everywhere.', labelAccent: 'red' },
      { label: 'YOUR BOOKINGS', value: 'Stay in the company, anonymised — your name comes off them.' },
      { label: 'COMING BACK', value: 'Only if an administrator invites you again.' },
    ],
    buttonLabel: 'OPEN ALLOCATE',
    buttonUrl: ctaUrl,
    showFallbackLink: false,
    footerSentence: `You are getting this because you just left ${companyName}.`,
  });

  return { subject, html, text };
}
