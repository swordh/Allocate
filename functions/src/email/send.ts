import { Resend } from 'resend';

/**
 * Default sender. Must be an address on a domain verified in Resend.
 * Overridable per environment via the MAIL_FROM env var.
 */
const DEFAULT_FROM = 'Allocate <noreply@allocate.at>';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailParams extends RenderedEmail {
  to: string;
}

/**
 * Thin wrapper around the Resend client. This is the single place that talks to
 * the email provider — invites use it now, reminders will reuse it later.
 *
 * @param apiKey  Resend API key (read from the RESEND_API_KEY secret).
 * @returns the provider message id.
 * @throws if Resend returns an error.
 */
export async function sendEmail(apiKey: string, params: SendEmailParams): Promise<string> {
  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    from: process.env.MAIL_FROM ?? DEFAULT_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });

  if (error) {
    throw new Error(`Resend ${error.name}: ${error.message}`);
  }

  return data?.id ?? '';
}
