import { defineConfig, type Plugin } from 'vitest/config'
import path from 'path'

/**
 * Separate from vitest.config.ts on purpose — do not merge them.
 *
 * These tests talk to a real (local) Firestore/Auth emulator instead of mocks,
 * so they need a much longer timeout, must never run under a plain
 * `npx vitest run` (that command has no emulator behind it and would either
 * hang or, far worse, silently fall through to whatever Firestore project the
 * environment happens to be configured for), and must run one file at a time
 * against the single shared emulator instance instead of vitest's normal
 * per-file parallelism.
 *
 * The `include` pattern below intentionally does NOT end in `.test.ts` or
 * `.spec.ts` — vitest's default include glob (used by vitest.config.ts) only
 * matches files whose final segment before the extension is exactly "test"
 * or "spec", so a name like `foo.emulator.ts` is invisible to the normal
 * suite while still reading clearly as a test file. Do not rename these to
 * `*.emulator.test.ts` — that suffix DOES end in ".test.ts" and would get
 * picked up by both configs, defeating the whole point.
 *
 * JRE requirement: the Firestore emulator ships as a Java jar and refuses to
 * start without a JRE on PATH; the Auth emulator is plain Node and needs
 * none. `test:emulator` in package.json prepends Homebrew's openjdk
 * (`/opt/homebrew/opt/openjdk/bin`) to PATH before invoking
 * `firebase emulators:exec` — that's a macOS convenience for local dev, not
 * a real fix, and package.json has nowhere to explain it (no comments
 * allowed there), hence this note living here instead. A CI runner has no
 * such Homebrew install and must provide its own JRE (e.g. actions/setup-java)
 * or the Firestore emulator will fail to start with a fairly cryptic error
 * that gives no hint the actual problem is a missing Java runtime.
 *
 * Ports: firestore 8180, auth 9299 (see constants.ts, which every test and
 * this setup import from). Both are hardcoded to match the "emulators"
 * block in firebase.json — vitest has no way to read that file at config
 * time, so if you change a port there, update constants.ts by hand too, or
 * `firebase emulators:exec` and the test client end up talking past each
 * other and everything just hangs/times out with no obvious cause.
 */
function stripNextDirectives(): Plugin {
  return {
    name: 'strip-next-directives',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) return null
      const stripped = code.replace(/^['"]use (server|client)['"]\s*\n?/m, '')
      if (stripped !== code) {
        return { code: stripped, map: null }
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [stripNextDirectives()],
  test: {
    environment: 'node',
    globals: true,
    pool: 'forks',
    // The emulator is one shared process behind every test file; running
    // files in parallel would let them race on the same Firestore data.
    // Sequencing them here is what makes the per-file `beforeEach` cleanup
    // in emulatorSetup.ts sufficient for isolation.
    fileParallelism: false,
    include: ['__tests__/emulator/**/*.emulator.ts'],
    setupFiles: ['__tests__/emulator/emulatorSetup.ts'],
    // The emulator does real network round-trips per operation, so the
    // default 5s unit-test timeout is routinely too tight once a test seeds
    // more than a handful of documents.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // Same stubs vitest.config.ts uses — lib/companyStats.ts and friends
      // import 'server-only', and some queries pull in next/cache et al.
      'server-only': path.resolve(__dirname, '__tests__/__mocks__/server-only.ts'),
      'next/cache': path.resolve(__dirname, '__tests__/__mocks__/next-cache.ts'),
      'next/headers': path.resolve(__dirname, '__tests__/__mocks__/next-headers.ts'),
      'next/navigation': path.resolve(__dirname, '__tests__/__mocks__/next-navigation.ts'),
    },
  },
})
