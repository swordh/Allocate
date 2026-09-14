/**
 * Shared building blocks for Allocate's transactional emails (invitation,
 * verify, reset, change). Dark shell matching the design handoff: black
 * background, 600px container, zero border-radius except the eyebrow dot,
 * hardcoded hex (email clients can't read CSS custom properties).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Splits a name across two lines for the hero slot, breaking on the LAST
 * whitespace. Only splits when the name has two or more words AND neither
 * resulting half exceeds ~14 characters — otherwise a long single word (or a
 * long half) would just wrap ungracefully, so we degrade to one line.
 */
export function splitHero(name: string): string | [string, string] {
  const trimmed = name.trim();
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return trimmed;

  const first = trimmed.slice(0, lastSpace).trim();
  const second = trimmed.slice(lastSpace + 1).trim();
  if (!first || !second) return trimmed;
  if (first.length > 14 || second.length > 14) return trimmed;

  return [first, second];
}

/** Named accent colors used for the eyebrow dot and, per-row, a data-table label. */
export type LayoutAccent = 'amber' | 'gray' | 'red';

const ACCENT_HEX: Record<LayoutAccent, string> = {
  amber: '#f4b24a',
  gray: '#8a8b93',
  red: '#e5484d',
};

/** Default (unaccented) label color for a `dataRows` row — a dimmer neutral
 * than the `gray` eyebrow accent, matching the design handoff exactly. */
const ROW_LABEL_NEUTRAL_HEX = '#6a6b72';

/** One row of the wide, multi-row data table (see `dataRows`). Plain text. */
export interface DataTableRow {
  label: string;
  value: string;
  /** Accent color for just this row's label. Defaults to neutral grey (#6a6b72). */
  labelAccent?: LayoutAccent;
}

export interface LayoutOptions {
  /** Hidden preheader line shown in the inbox list. Plain text. */
  preheader: string;
  /** Accent eyebrow beside the 5px dot, e.g. 'ACCOUNT SETUP'. Plain text. */
  eyebrow: string;
  /** Color of the eyebrow dot + text. Defaults to amber (the original design). */
  eyebrowAccent?: LayoutAccent;
  /** Hero. One or two lines; two lines render with a hard <br>. Plain text. */
  hero: string | [string, string];
  /** Body paragraph HTML. Caller escapes dynamic values. */
  bodyHtml: string;
  /**
   * Optional bordered label/value row between body and CTA. Plain text.
   * This is the original compact single-row table (invitation/auth mails).
   */
  dataRow?: { label: string; value: string };
  /**
   * Optional wide, multi-row data table between body and CTA (company
   * deletion mails). Distinct markup from `dataRow` by design, not
   * accident — the deletion mails' table is taller, top-aligned and carries
   * per-row label accent colors; forcing the compact single-row markup to
   * also do that would fight its own layout. Mutually exclusive with
   * `dataRow` in practice, but nothing stops a caller from using neither.
   */
  dataRows?: DataTableRow[];
  buttonLabel: string;
  buttonUrl: string;
  /**
   * Optional paragraph rendered after the CTA button, before the
   * copy-paste fallback link. Caller escapes dynamic values.
   */
  noteHtml?: string;
  /**
   * Whether to render the "Button not working? Copy this link" fallback
   * block. Defaults to true. Mails whose CTA is a plain, non-token URL (open
   * the app, start a new company) have nothing worth pasting and the design
   * handoff omits the block entirely for those.
   */
  showFallbackLink?: boolean;
  /** Grey sentence under the fallback link. Plain text. */
  footerSentence: string;
}

/**
 * Renders the standard Allocate email shell: wordmark, eyebrow with accent
 * dot, hero headline, body copy, optional data row, primary CTA button and a
 * copy-paste fallback link with a footer sentence.
 */
export function renderLayout(opts: LayoutOptions): string {
  const {
    preheader,
    eyebrow,
    eyebrowAccent,
    hero,
    bodyHtml,
    dataRow,
    dataRows,
    buttonLabel,
    buttonUrl,
    noteHtml,
    showFallbackLink = true,
    footerSentence,
  } = opts;
  const safeUrl = escapeHtml(buttonUrl);
  const heroHtml = Array.isArray(hero)
    ? `${escapeHtml(hero[0])}<br>${escapeHtml(hero[1])}`
    : escapeHtml(hero);
  const eyebrowHex = ACCENT_HEX[eyebrowAccent ?? 'amber'];
  const hasDataBlock = !!dataRow || (!!dataRows && dataRows.length > 0);
  const bodyPaddingBottom = hasDataBlock ? 24 : 34;

  const dataRowHtml = dataRow
    ? `<tr><td class="pad" align="left" style="padding:0 40px 34px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(255,255,255,0.12);"><tr>
<td style="padding:14px 18px;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.4px;color:#7f8088;">${escapeHtml(dataRow.label)}</td>
<td style="padding:14px 18px 14px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ECECEE;">${escapeHtml(dataRow.value)}</td>
</tr></table>
</td></tr>`
    : '';

  const dataRowsHtml = dataRows && dataRows.length > 0
    ? `<tr><td class="pad" align="left" style="padding:0 40px 34px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(255,255,255,0.1);">
${dataRows
  .map((row) => {
    const labelHex = row.labelAccent ? ACCENT_HEX[row.labelAccent] : ROW_LABEL_NEUTRAL_HEX;
    return `<tr>
<td width="150" valign="top" style="width:150px;padding:14px 0 14px 18px;font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.7px;color:${labelHex};">${escapeHtml(row.label)}</td>
<td valign="top" style="padding:14px 18px 14px 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#a8a9b0;">${escapeHtml(row.value)}</td>
</tr>`;
  })
  .join('')}
</table>
</td></tr>`
    : '';

  const noteHtmlRow = noteHtml
    ? `<tr><td class="pad" align="left" style="padding:0 40px 34px 40px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#8a8b93;">
${noteHtml}
</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(preheader)}</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  body{margin:0;padding:0;width:100%!important;}
  @media only screen and (max-width:620px){
    .container{width:100%!important;}
    .pad{padding-left:24px!important;padding-right:24px!important;}
    .hero{font-size:38px!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
<span style="display:none;font-size:1px;color:#000000;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#000000;">
<tr><td align="center" style="padding:60px 16px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td class="pad" align="left" style="padding:0 40px 40px 40px;">
<span style="font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:19px;letter-spacing:0.5px;color:#ffffff;">ALLOCATE</span>
</td></tr>
<tr><td class="pad" align="left" style="padding:0 40px 20px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="6" style="width:6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="5" height="5" bgcolor="${eyebrowHex}" style="width:5px;height:5px;border-radius:50%;font-size:1px;line-height:5px;">&nbsp;</td></tr></table></td>
<td style="padding-left:9px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.7px;color:${eyebrowHex};">${escapeHtml(eyebrow)}</td>
</tr></table>
</td></tr>
<tr><td class="pad" align="left" style="padding:0 40px 22px 40px;">
<span class="hero" style="display:block;font-family:Helvetica,Arial,sans-serif;font-size:54px;line-height:0.95;font-weight:700;letter-spacing:-1.5px;color:#ffffff;text-transform:uppercase;">${heroHtml}</span>
</td></tr>
<tr><td class="pad" align="left" style="padding:0 40px ${bodyPaddingBottom}px 40px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#8a8b93;max-width:420px;">
${bodyHtml}
</td></tr>
${dataRowHtml}
${dataRowsHtml}
<tr><td class="pad" align="left" style="padding:0 40px 34px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#ffffff" style="border-radius:0;">
<a href="${safeUrl}" target="_blank" style="display:block;padding:16px 30px;font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1px;color:#000000;text-decoration:none;border-radius:0;">${escapeHtml(buttonLabel)}</a>
</td></tr></table>
</td></tr>
${noteHtmlRow}
<tr><td class="pad" align="left" style="padding:0 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(255,255,255,0.1);">
${
  showFallbackLink
    ? `<tr><td style="padding-top:22px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6a6b72;">
Button not working? Copy this link:<br>
<a href="${safeUrl}" style="color:${eyebrowHex};word-break:break-all;text-decoration:none;">${safeUrl}</a>
</td></tr>`
    : ''
}
<tr><td style="padding-top:18px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#55565d;">
${escapeHtml(footerSentence)}
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
