// Minimal shell for unauthenticated routes — no auth check, no shared chrome.
// Each auth page renders its own AuthShell/AuthCard (components/auth), so this
// layout only needs to provide the single <main> landmark for the route group.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>
}
