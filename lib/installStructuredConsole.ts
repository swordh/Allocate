/**
 * Patches the global `console.error/warn/info/log/debug` methods so every
 * server-side log call emits exactly one line of Cloud-Logging-shaped JSON
 * (see `formatLogEntry` in lib/structuredLog.ts for why).
 *
 * DESIGN NOTE — why this delegates to the previous console method instead of
 * writing to process.stdout/stderr directly:
 *
 * Next.js already patches `console.*` at server startup, before our
 * `register()` hook ever runs — see
 * node_modules/next/dist/server/node-environment-extensions/console-exit.js
 * and .../console-dim.external.js. `console-exit`'s own docblock says
 * explicitly: "if you further patch the console method after this and add
 * any sync IO there it will trigger sync IO warnings while prerendering."
 * `console-exit` wraps each method to run inside
 * `workUnitAsyncStorage.exit(...)`, which is what suppresses that warning —
 * but that suppression only covers sync IO that happens INSIDE the call
 * chain it wraps. If we called `process.stdout.write`/`process.stderr.write`
 * ourselves from an even-later patch, that write would happen OUTSIDE the
 * `exit()` wrapper and would (re)trigger the warning during prerendering.
 *
 * The fix is to never do our own IO: capture whatever `console.error` (etc.)
 * already is at install time — Next's own wrapper, if it has run — and hand
 * it our single formatted JSON string. That string flows down through
 * Next's `console-dim`/`console-exit` wrappers exactly as any other log call
 * would, and the real IO happens at the bottom of that existing chain, still
 * inside `exit()`.
 *
 * Read `console-dim.external.js` to confirm this doesn't mangle our output:
 * `convertToDimmedArgs` (and therefore any color/dim codes) is only applied
 * when `workUnitAsyncStorage`'s `dim` flag is set or a React cache signal is
 * aborted — both exclusively prerender-time conditions (aborted static
 * generation, or an explicit "past due" prerender scope). Outside of a
 * prerender, `patchConsoleMethod`'s wrapper takes the
 * `originalMethod.apply(this, args)` branch untouched. So for ordinary
 * request-time logging (the case this patch exists for), our single string
 * argument reaches Node's real `console.error`/etc. unmodified — one
 * argument, no substitution templates to apply, printed as one line via
 * `util.format` (which is a no-op on a single string with no extra args).
 * Only inside an aborted/dimmed prerender scope could Next wrap our line
 * with ANSI dim codes or drop it (`HIDDEN_STYLE`) — that's Next's own
 * intended behavior for that scope, not something this patch introduces or
 * needs to work around.
 *
 * Node routes console.error/warn to stderr and info/log/debug to stdout
 * internally — we don't choose the stream ourselves, delegation preserves
 * whatever the previous method already did.
 *
 * TRADE-OFF TO RE-VERIFY LATER: this reasoning covers the workUnitStore
 * `type`s that exist in Next 16.2.1's prerender model (see the `switch` in
 * `console-dim.external.js`). If cacheComponents/PPR/`'use cache'`
 * prerendering is turned on for this app later, re-check that no new
 * sync-IO warnings appear — the dimming/exit machinery is the part of Next
 * most likely to grow new prerender states.
 *
 * Idempotent: calling this more than once (e.g. hot reload, multiple
 * `register()` invocations) is a no-op after the first call. The flag lives
 * on `globalThis` (via `Symbol.for`, so it's shared across module
 * instances), not a module-scoped variable — `instrumentation.ts` is
 * bundled separately for the main server runtime and for `proxy.ts` (see
 * next/dist/server/web/globals.js, which loads middleware/proxy code via its
 * own `_ENTRIES` bundle), so each is a DIFFERENT copy of this module with
 * its own module scope. A module-scoped flag would let each bundle patch
 * `console` once, independently — two patches stacked on top of each other.
 */

import { formatLogEntry } from './structuredLog'

type Level = 'error' | 'warn' | 'info' | 'log' | 'debug'
type ConsoleMethod = (...args: unknown[]) => void
type OriginalConsoleMethods = Record<Level, ConsoleMethod>

// Symbol.for gives every bundle/module-instance of this file the SAME global
// slot, which is what makes the idempotency check work across separately
// bundled copies (see the docblock above).
const INSTALLED_KEY = Symbol.for('allocate.structuredConsole.installed')
const ORIGINALS_KEY = Symbol.for('allocate.structuredConsole.originals')

type GlobalWithFlags = typeof globalThis & {
  [INSTALLED_KEY]?: boolean
  [ORIGINALS_KEY]?: OriginalConsoleMethods
}

function getGlobal(): GlobalWithFlags {
  return globalThis as GlobalWithFlags
}

function makeWrapper(level: Level, original: ConsoleMethod): ConsoleMethod {
  return (...args: unknown[]): void => {
    try {
      const line = formatLogEntry(level, args)
      // Hand the ORIGINAL method (Next's own console patches, if installed,
      // or Node's real console method) a single string — see the docblock
      // above for why this is delegation rather than a direct stream write.
      original(line)
    } catch {
      // formatLogEntry is designed to never throw, but `original` itself
      // could (e.g. a broken stream) — fall back to logging the untouched
      // original arguments through the same original method, so the log
      // isn't lost even if it can't be structured.
      original(...args)
    }
  }
}

export function installStructuredConsole(): void {
  const g = getGlobal()
  if (g[INSTALLED_KEY]) return

  // Captured at INSTALL time, not module load time — both so a test can
  // swap in a spy on console.* before calling this, and so we wrap whatever
  // Next (or a previous install, in another bundle) has already put there.
  const originals: OriginalConsoleMethods = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    debug: console.debug.bind(console),
  }

  g[INSTALLED_KEY] = true
  g[ORIGINALS_KEY] = originals

  console.error = makeWrapper('error', originals.error)
  console.warn = makeWrapper('warn', originals.warn)
  console.info = makeWrapper('info', originals.info)
  console.log = makeWrapper('log', originals.log)
  console.debug = makeWrapper('debug', originals.debug)
}

/**
 * Test-only: restores the original console methods and clears the
 * idempotency flag (on `globalThis`, so it also undoes state a differently
 * imported module instance would see). Not used by production code — the
 * patch is meant to live for the lifetime of the server process.
 */
export function resetStructuredConsoleForTests(): void {
  const g = getGlobal()
  const originals = g[ORIGINALS_KEY]
  if (originals) {
    console.error = originals.error
    console.warn = originals.warn
    console.info = originals.info
    console.log = originals.log
    console.debug = originals.debug
  }
  delete g[INSTALLED_KEY]
  delete g[ORIGINALS_KEY]
}
