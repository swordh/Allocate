import { Suspense } from 'react'
import SignupForm from '@/components/auth/SignupForm'

// Server Component shell — SignupForm handles all interactive Firebase Auth logic.
// Suspense is required because SignupForm reads useSearchParams() at render time.
export default function SignupPage() {
  return (
    <main>
      <Suspense>
        <SignupForm />
      </Suspense>
    </main>
  )
}
