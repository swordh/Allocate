// Stub for 'next/navigation'.
import { vi } from 'vitest'

export const redirect = vi.fn((url: string): never => {
  throw new Error(`REDIRECT:${url}`)
})

export const notFound = vi.fn((): never => {
  throw new Error('NOT_FOUND')
})
