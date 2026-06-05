import type { Metadata } from 'next'
import AuthActionHandler from '@/components/auth/AuthActionHandler'

export const metadata: Metadata = {
  title: 'Verify — Allocate',
}

export default async function AuthActionPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; oobCode?: string }>
}) {
  const { mode, oobCode } = await searchParams
  return <AuthActionHandler mode={mode} oobCode={oobCode} />
}
