import { defineConfig, type Plugin } from 'vitest/config'
import path from 'path'

/**
 * Strip 'use server' and 'use client' directives from source files before
 * Vitest processes them.
 *
 * Next.js's SWC transform compiles 'use server' functions into registered
 * server actions that handle errors via React's serialization protocol — this
 * makes them swallow thrown errors at the module boundary, which breaks
 * standard expect(...).rejects.toThrow() assertions.
 *
 * Removing the directive at the Vitest transform stage lets the functions
 * behave as plain async functions, which is exactly what unit tests need.
 */
function stripNextDirectives(): Plugin {
  return {
    name: 'strip-next-directives',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.endsWith('.ts') && !id.endsWith('.tsx')) return null
      // Remove 'use server' and 'use client' as the very first statement.
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
    // Run each test file in isolation — firebase-admin module state must not leak.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['actions/**/*.ts', 'lib/dal.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // 'server-only' and 'next/cache' have no runtime exports — stub them out.
      'server-only': path.resolve(__dirname, '__tests__/__mocks__/server-only.ts'),
      'next/cache': path.resolve(__dirname, '__tests__/__mocks__/next-cache.ts'),
      'next/headers': path.resolve(__dirname, '__tests__/__mocks__/next-headers.ts'),
      'next/navigation': path.resolve(__dirname, '__tests__/__mocks__/next-navigation.ts'),
    },
  },
})
