// Minimal shell for unauthenticated routes — no nav, no auth check.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
