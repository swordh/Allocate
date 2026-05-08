'use client'

import { AuthProvider } from '@/lib/auth-context'
import { ToastProvider } from '@/lib/toast-context'
import { ToastContainer } from '@/components/ui/Toast'
import { SupportProvider } from '@/lib/support-context'
import SupportModal from '@/components/support/SupportModal'
import NotificationsPanel from '@/components/support/NotificationsPanel'

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <SupportProvider>
          {children}
          <SupportModal />
          <NotificationsPanel />
        </SupportProvider>
        <ToastContainer />
      </ToastProvider>
    </AuthProvider>
  )
}
