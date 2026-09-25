/**
 * Next.js instrumentation hook — `register()` runs once when a new server
 * instance starts, for BOTH the Node.js and Edge runtimes (see
 * https://nextjs.org/docs/app/guides/instrumentation). We only want the
 * console patch in the Node.js process, so we gate on `NEXT_RUNTIME`.
 *
 * What this installs: on App Hosting/Cloud Run, `console.error('[tag]', {obj})`
 * gets pretty-printed by Node across multiple lines, and Cloud Run's log
 * agent reads stdout/stderr line by line — so one log call becomes several
 * unstructured entries, every one at severity DEFAULT (verified on alpha).
 * `installStructuredConsole` (lib/installStructuredConsole.ts) replaces the
 * console methods with wrappers that emit one line of Cloud-Logging-shaped
 * JSON per call, with a real `severity` and searchable fields. This applies
 * to ALL server-side logging — Next.js's own internal logs, `proxy.ts`
 * (which always runs in the Node.js runtime on Next 16, not Edge), Server
 * Components, Server Actions, and Route Handlers — since it patches the
 * global `console` object itself rather than requiring each call site to
 * change.
 *
 * Only active in production: local `next dev` output is unaffected, and
 * `STRUCTURED_LOGS=off` is an emergency kill switch back to the old format
 * without a redeploy.
 */
export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NODE_ENV === 'production' &&
    process.env.STRUCTURED_LOGS !== 'off'
  ) {
    const { installStructuredConsole } = await import('./lib/installStructuredConsole')
    installStructuredConsole()
  }
}
