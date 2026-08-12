import { RenderedEmail } from '../send';
import { renderLayout, escapeHtml, splitHero } from './_shared';

export interface InvitationEmailData {
  companyName: string;
  inviterName: string;
  acceptUrl: string;
  role: string;
}

/** Grammatical role label, used inside a sentence ("as an Admin"). */
const ROLE_LABEL: Record<string, string> = {
  admin: 'an Admin',
  crew: 'Crew',
  viewer: 'a Viewer',
};

/** Bare role label for the eyebrow ("INVITED AS ADMIN"). */
const ROLE_EYEBROW: Record<string, string> = {
  admin: 'ADMIN',
  crew: 'CREW',
  viewer: 'VIEWER',
};

/**
 * Renders the "you've been invited" email. New templates (e.g. booking
 * reminders) live beside this file and are selected by the mail doc's
 * `template` field in onMailQueued.
 */
export function invitationEmail(data: InvitationEmailData): RenderedEmail {
  const { companyName, inviterName, acceptUrl } = data;
  const roleLabel = ROLE_LABEL[data.role] ?? data.role;
  const roleEyebrow = (ROLE_EYEBROW[data.role] ?? data.role).toUpperCase();

  const subject = `${inviterName} invited you to ${companyName} on Allocate`;

  const text = [
    `${inviterName} has invited you to the company workspace on Allocate as ${roleLabel}.`,
    '',
    `Accept your invitation: ${acceptUrl}`,
    '',
    "If you weren't expecting this, you can safely ignore this email.",
  ].join('\n');

  const html = renderLayout({
    preheader: `${inviterName} invited you to join ${companyName} on Allocate`,
    eyebrow: `INVITED AS ${roleEyebrow}`,
    hero: splitHero(companyName),
    bodyHtml: `${escapeHtml(inviterName)} has invited you to the company workspace on Allocate.`,
    buttonLabel: 'ACCEPT INVITATION',
    buttonUrl: acceptUrl,
    footerSentence: "If you weren't expecting this, you can safely ignore this email.",
  });

  return { subject, html, text };
}
