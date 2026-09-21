/**
 * `appUrl`/`appBaseUrl` are the functions-side equivalent of
 * `NEXT_PUBLIC_APP_URL` — Cloud Functions can't see that App Hosting env
 * var, so this keys off the Firebase project id the runtime sets
 * automatically. Added alongside issue #348, where `buildCancelUrl`
 * hardcoded `https://allocate.at` (a separate, unrelated Hosting site that
 * 404s on every app route) in every environment including prod.
 *
 * Assertions here are deliberately exact strings, not `toContain`-style
 * substring checks — a weak assertion would keep passing with the bug back
 * in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appBaseUrl, appUrl } from '../../functions/src/appUrl'
import { buildCancelUrl } from '../../functions/src/company/format'

let originalEnv: NodeJS.ProcessEnv

beforeEach(() => {
  originalEnv = { ...process.env }
  delete process.env.APP_BASE_URL
  delete process.env.GCLOUD_PROJECT
  delete process.env.GOOGLE_CLOUD_PROJECT
})

afterEach(() => {
  process.env = originalEnv
  vi.restoreAllMocks()
})

describe('appBaseUrl', () => {
  it('maps allocate-e0735 to the prod app domain', () => {
    process.env.GCLOUD_PROJECT = 'allocate-e0735'
    expect(appBaseUrl()).toBe('https://app.allocate.at')
  })

  it('maps allocate-beta to the beta app domain', () => {
    process.env.GCLOUD_PROJECT = 'allocate-beta'
    expect(appBaseUrl()).toBe('https://beta.allocate.at')
  })

  it('maps allocate-alpha to the alpha app domain', () => {
    process.env.GCLOUD_PROJECT = 'allocate-alpha'
    expect(appBaseUrl()).toBe('https://alpha.allocate.at')
  })

  it('falls back to GOOGLE_CLOUD_PROJECT when GCLOUD_PROJECT is unset', () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'allocate-beta'
    expect(appBaseUrl()).toBe('https://beta.allocate.at')
  })

  it('APP_BASE_URL overrides the project map', () => {
    process.env.GCLOUD_PROJECT = 'allocate-alpha'
    process.env.APP_BASE_URL = 'https://custom.example.com'
    expect(appBaseUrl()).toBe('https://custom.example.com')
  })

  it('strips trailing slashes from APP_BASE_URL', () => {
    process.env.APP_BASE_URL = 'https://custom.example.com///'
    expect(appBaseUrl()).toBe('https://custom.example.com')
  })

  it('logs an error and falls back to the prod base for an unknown project id', async () => {
    // Resolves to __tests__/__mocks__/firebase-functions-v2.ts via the alias
    // in vitest.config.ts — the same object appUrl.ts holds, so spying here
    // is spying on exactly the call the helper makes.
    const { logger } = await import('firebase-functions/v2')
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    process.env.GCLOUD_PROJECT = 'demo-allocate-test'

    expect(appBaseUrl()).toBe('https://app.allocate.at')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toMatchObject({ projectId: 'demo-allocate-test' })
  })

  it('logs an error and falls back to the prod base when no project id is set at all', async () => {
    const { logger } = await import('firebase-functions/v2')
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)

    expect(appBaseUrl()).toBe('https://app.allocate.at')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toMatchObject({ projectId: null })
  })
})

describe('appUrl', () => {
  beforeEach(() => {
    process.env.GCLOUD_PROJECT = 'allocate-alpha'
  })

  it('joins base and path with exactly one slash', () => {
    expect(appUrl('/login')).toBe('https://alpha.allocate.at/login')
  })

  it('does not double the slash when the path already starts with one', () => {
    expect(appUrl('/company/new')).not.toMatch(/\/\/company/)
  })

  it('appUrl("/") yields "<base>/"', () => {
    expect(appUrl('/')).toBe('https://alpha.allocate.at/')
  })

  it('never produces a double slash for a path without a leading slash either', () => {
    expect(appUrl('signup')).toBe('https://alpha.allocate.at/signup')
  })
})

describe('buildCancelUrl', () => {
  it('under GCLOUD_PROJECT=allocate-alpha yields the alpha domain, not the broken allocate.at', () => {
    process.env.GCLOUD_PROJECT = 'allocate-alpha'
    const url = buildCancelUrl('tok_123')

    expect(url).toBe('https://alpha.allocate.at/company-deletion/cancel/tok_123')
    expect(url).not.toContain('//allocate.at/')
  })
})
