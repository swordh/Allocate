/**
 * `installStructuredConsole` patches the global console methods so each
 * call hands the PREVIOUSLY INSTALLED console method (Next's own patches,
 * if present, or Node's real console method) a single formatted JSON
 * string, rather than writing to process.stdout/stderr itself — see
 * lib/installStructuredConsole.ts's docblock for why (Next's
 * console-exit/console-dim extensions patch console before our
 * instrumentation hook runs, and further sync IO added on top of those
 * patches can trigger sync-IO warnings during prerendering; delegating
 * avoids that).
 *
 * The patch is process-global, so every test here restores the original
 * console (and the idempotency flag) via `resetStructuredConsoleForTests`
 * afterwards — this patch must never leak into other test files or be
 * "accidentally on" for a test that didn't ask for it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  installStructuredConsole,
  resetStructuredConsoleForTests,
} from '@/lib/installStructuredConsole'

afterEach(() => {
  resetStructuredConsoleForTests()
  vi.restoreAllMocks()
})

describe('installStructuredConsole', () => {
  it('delegates console.error to the previously installed console.error with one formatted JSON string', () => {
    const previousError = vi.fn()
    console.error = previousError

    installStructuredConsole()
    console.error('[tag]', { action: 'x' })

    expect(previousError).toHaveBeenCalledTimes(1)
    const [line] = previousError.mock.calls[0] as [string]
    expect(previousError.mock.calls[0]).toHaveLength(1) // exactly one arg — no template substitution risk
    expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(line)).toMatchObject({ severity: 'ERROR', action: 'x' })
  })

  it('delegates console.warn to the previously installed console.warn', () => {
    const previousWarn = vi.fn()
    console.warn = previousWarn
    installStructuredConsole()
    console.warn('careful')
    expect(previousWarn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(previousWarn.mock.calls[0][0] as string).severity).toBe('WARNING')
  })

  it('delegates console.log/info/debug to their previously installed methods', () => {
    const previousLog = vi.fn()
    const previousInfo = vi.fn()
    const previousDebug = vi.fn()
    console.log = previousLog
    console.info = previousInfo
    console.debug = previousDebug
    installStructuredConsole()
    console.log('a')
    console.info('b')
    console.debug('c')
    expect(previousLog).toHaveBeenCalledTimes(1)
    expect(previousInfo).toHaveBeenCalledTimes(1)
    expect(previousDebug).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — a second install call does not re-wrap an already-wrapped console method', () => {
    installStructuredConsole()
    const afterFirst = console.error
    installStructuredConsole()
    expect(console.error).toBe(afterFirst)
  })

  it('is idempotent across separately bundled module instances via a globalThis flag', async () => {
    // Simulate instrumentation.ts's two separate bundles (main server runtime
    // vs. proxy.ts's own bundle, per next/dist/server/web/globals.js) each
    // importing a FRESH copy of this module — vi.resetModules forces a
    // distinct module instance on re-import, the same way two bundles would
    // each get their own module scope. The flag must still be shared via
    // globalThis, so only the FIRST install wins.
    const previousError = vi.fn()
    console.error = previousError

    const first = await import('@/lib/installStructuredConsole')
    first.installStructuredConsole()
    const afterFirstInstall = console.error

    vi.resetModules()
    const second = await import('@/lib/installStructuredConsole')
    second.installStructuredConsole()

    expect(console.error).toBe(afterFirstInstall)

    // Clean up via whichever module instance is current post-reset.
    second.resetStructuredConsoleForTests()
  })

  it('falls back to the previously installed console method, with the ORIGINAL unmodified args, when delegation itself throws', () => {
    const previousError = vi.fn().mockImplementationOnce(() => {
      throw new Error('downstream console blew up')
    })
    console.error = previousError

    installStructuredConsole()
    console.error('will fail on the structured attempt', { x: 1 })

    // First call: our wrapper's normal attempt (the JSON string), which the
    // mock is set to throw on. Second call: the fallback, with the ORIGINAL
    // arguments untouched.
    expect(previousError).toHaveBeenCalledTimes(2)
    expect(previousError.mock.calls[1]).toEqual(['will fail on the structured attempt', { x: 1 }])
  })
})
