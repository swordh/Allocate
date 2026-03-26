import { redirect } from 'next/navigation'

/**
 * /settings → redirect to /settings/company (the default tab).
 */
export default function SettingsPage() {
  redirect('/settings/company')
}
