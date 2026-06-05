import { RenderedEmail } from '../send';

export interface InvitationEmailData {
  companyName: string;
  inviterName: string;
  acceptUrl: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'an Admin',
  crew: 'Crew',
  viewer: 'a Viewer',
};

/**
 * Renders the "you've been invited" email. New templates (e.g. booking
 * reminders) live beside this file and are selected by the mail doc's
 * `template` field in onMailQueued.
 */
export function invitationEmail(data: InvitationEmailData): RenderedEmail {
  const { companyName, inviterName, acceptUrl } = data;
  const roleLabel = ROLE_LABEL[data.role] ?? data.role;

  const subject = `${inviterName} invited you to ${companyName} on Allocate`;

  const text = [
    `${inviterName} has invited you to join ${companyName} on Allocate as ${roleLabel}.`,
    '',
    `Accept your invitation: ${acceptUrl}`,
    '',
    'If you weren’t expecting this, you can safely ignore this email.',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
        <tr><td style="padding:28px 32px 8px;">
          <span style="font-size:15px;font-weight:700;letter-spacing:0.18em;color:#18181b;">ALLOCATE</span>
        </td></tr>
        <tr><td style="padding:8px 32px 0;">
          <h1 style="margin:0;font-size:20px;line-height:1.35;color:#18181b;font-weight:600;">You’ve been invited to ${escapeHtml(companyName)}</h1>
        </td></tr>
        <tr><td style="padding:14px 32px 0;">
          <p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46;">
            <strong>${escapeHtml(inviterName)}</strong> has invited you to join
            <strong>${escapeHtml(companyName)}</strong> on Allocate as ${escapeHtml(roleLabel)}.
          </p>
        </td></tr>
        <tr><td style="padding:24px 32px 4px;">
          <a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">Accept invitation</a>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
            If the button doesn’t work, copy and paste this link into your browser:<br>
            <a href="${escapeHtml(acceptUrl)}" style="color:#71717a;word-break:break-all;">${escapeHtml(acceptUrl)}</a>
          </p>
        </td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#a1a1aa;">If you weren’t expecting this, you can safely ignore this email.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
