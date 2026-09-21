import { logger } from 'firebase-functions/v2';

/**
 * Cloud Functions cannot see `NEXT_PUBLIC_APP_URL` — that's an App Hosting
 * env var, set per backend in the console, and functions run in a
 * different runtime entirely. This is the functions-side equivalent,
 * keyed off the Firebase project id the runtime sets automatically.
 */
const BASE_BY_PROJECT: Record<string, string> = {
  'allocate-e0735': 'https://app.allocate.at',
  'allocate-beta': 'https://beta.allocate.at',
  'allocate-alpha': 'https://alpha.allocate.at',
};

const PROD_FALLBACK = BASE_BY_PROJECT['allocate-e0735'];

/**
 * Resolves at call time (not module load) so tests can vary
 * `process.env` per-case without module-cache gymnastics. `APP_BASE_URL`
 * is an explicit override for local/emulator use; otherwise this keys off
 * the project id the Cloud Functions runtime sets automatically. An
 * unrecognised or missing project id — e.g. the emulator's
 * `demo-allocate-test` — falls back to prod, but logs loudly first: a
 * silent fallback is exactly what let `buildCancelUrl` point at a domain
 * that 404s in every environment for months (issue #348).
 */
export function appBaseUrl(): string {
  const override = process.env.APP_BASE_URL;
  if (override) return override.replace(/\/+$/, '');

  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  const base = projectId ? BASE_BY_PROJECT[projectId] : undefined;
  if (base) return base;

  logger.error('appBaseUrl: unrecognised or unset project id, falling back to prod base', {
    projectId: projectId ?? null,
  });
  return PROD_FALLBACK;
}

/**
 * Joins the base URL and a path with exactly one slash — `appUrl('/')` yields
 * `<base>/`. Reads nothing but `process.env`, so it is safe to call inside a
 * transaction callback or a resumable batch loop: a retry recomputes the
 * identical URL (see sweep.ts's reminder transaction and purge.ts's finalize).
 */
export function appUrl(path: string): string {
  const base = appBaseUrl();
  return `${base}/${path.replace(/^\/+/, '')}`;
}
