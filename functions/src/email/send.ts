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
 * Thrown when Resend's API responds with an error. Carries the raw
 * `error.name` from Resend's `ErrorResponse` (e.g. 'rate_limit_exceeded',
 * 'invalid_from_address') so callers can classify retryable vs. permanent
 * failures without re-parsing an error message string.
 *
 * Verified against the Resend SDK source (node_modules/resend/dist/index.js,
 * `Resend.fetchRequest`): the SDK never throws on a network failure — a
 * fetch that rejects is itself caught and turned into
 * `{ data: null, error: { name: 'application_error', ... } }` — so every
 * failure from `resend.emails.send`, network or API, surfaces here as a
 * `ResendSendError` with a real `RESEND_ERROR_CODES_BY_KEY` name. Nothing
 * else needs to be a "network error" special case.
 */
export class ResendSendError extends Error {
  constructor(
    /** Resend's `ErrorResponse.name`, e.g. 'rate_limit_exceeded'. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ResendSendError';
  }
}

/**
 * Thin wrapper around the Resend client. This is the single place that talks to
 * the email provider — invites use it now, reminders will reuse it later.
 *
 * @param apiKey  Resend API key (read from the RESEND_API_KEY secret).
 * @returns the provider message id.
 * @throws {ResendSendError} if Resend returns an error.
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
    throw new ResendSendError(error.name, `Resend ${error.name}: ${error.message}`);
  }

  return data?.id ?? '';
}
