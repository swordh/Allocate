import type { Metadata } from 'next'
import VerifyEmailForm from '@/components/auth/VerifyEmailForm'

export const metadata: Metadata = {
  title: 'Verify Email — Allocate',
}

export default function VerifyEmailPage() {
  return <VerifyEmailForm />
}
