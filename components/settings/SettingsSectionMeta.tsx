'use client'

import { usePathname } from 'next/navigation'
import { SETTINGS_ITEMS } from '@/components/nav/nav-items'

interface SettingsSectionMetaProps {
  companyName: string
}

/**
 * Mobile meta line under the SETTINGS heading: "{SECTION} · {COMPANY}"
 * (design line 53, sectionLabel derived per line 458).
 *
 * SettingsLayout (app/(app)/settings/layout.tsx) is a Server Component
 * wrapping every /settings/* page, so it has no way to know which tab is
 * active — a Next layout segment isn't handed the active child route as a
 * prop. Resolved client-side via usePathname() instead, matched against the
 * same SETTINGS_ITEMS used by the tab rail (components/nav/nav-items.ts) so
 * the label list isn't duplicated anywhere.
 */
export default function SettingsSectionMeta({ companyName }: SettingsSectionMetaProps) {
  const pathname = usePathname()
  const section = SETTINGS_ITEMS.find(
    (item) => pathname === item.href || pathname?.startsWith(`${item.href}/`)
  )
  const label = (section ?? SETTINGS_ITEMS[0]).label.toUpperCase()

  return (
    <>
      {label} · {companyName}
    </>
  )
}
