import OperatorLoginForm from '@/components/auth/OperatorLoginForm'

// Server Component shell — OperatorLoginForm handles all interactive Firebase
// Auth logic plus the server-side operator check (actions/operator-auth.ts).
//
// Deliberately a sibling of app/operator/(protected)/, NOT a child of it:
// that route group's layout.tsx calls getOperatorSession(), which redirects
// to /login whenever there is no session cookie yet — exactly the state
// every signed-out operator arrives in. Living outside the group means this
// page renders with no auth gate above it, which is correct: the gate here
// is operatorSignIn() in the server action, run after Firebase Auth
// succeeds, not before the page can even be reached.
export default function OperatorLoginPage() {
  return <OperatorLoginForm />
}
