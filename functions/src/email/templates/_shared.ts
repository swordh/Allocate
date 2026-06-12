/**
 * Shared building blocks for transactional auth emails (verify, reset, change).
 * Mirrors the visual language of invitation.ts (ALLOCATE wordmark, white card,
 * dark CTA button) so every Allocate email looks the same.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LayoutOptions {
  /** Card heading (plain text — escaped internally). */
  heading: string;
  /** Intro paragraph HTML. Caller is responsible for escaping any dynamic values. */
  introHtml: string;
  buttonLabel: string;
  buttonUrl: string;
  /** Small grey footnote shown under the fallback link (plain text — escaped internally). */
  footnote: string;
}

/**
 * Renders the standard Allocate email shell with a single primary action button
 * and a copy-paste fallback link.
 */
export function renderLayout(opts: LayoutOptions): string {
  const { heading, introHtml, buttonLabel, buttonUrl, footnote } = opts;
  const safeUrl = escapeHtml(buttonUrl);

  return `<!DOCTYPE html>
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
          <h1 style="margin:0;font-size:20px;line-height:1.35;color:#18181b;font-weight:600;">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:14px 32px 0;">
          <p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46;">${introHtml}</p>
        </td></tr>
        <tr><td style="padding:24px 32px 4px;">
          <a href="${safeUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">${escapeHtml(buttonLabel)}</a>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;">
          <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
            If the button doesn’t work, copy and paste this link into your browser:<br>
            <a href="${safeUrl}" style="color:#71717a;word-break:break-all;">${safeUrl}</a>
          </p>
        </td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#a1a1aa;">${escapeHtml(footnote)}</p>
    </td></tr>
  </table>
</body>
</html>`;
}
