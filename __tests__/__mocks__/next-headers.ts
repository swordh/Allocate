// Stub for 'next/headers'. Tests override cookies() via vi.mock in test files.
import { vi } from 'vitest'

export const cookies = vi.fn()
export const headers = vi.fn()
