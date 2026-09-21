'use client'

import { usePathname } from 'next/navigation'
import TabRail from '@/components/ui/TabRail'
import { settingsItemsFor } from '@/components/nav/nav-items'
import type { Role } from '@/types'

interface SettingsTabsProps {
  role: Role
  /** Issue #350 — a planless company only sees the always-available tabs (Account/Company/Subscription); see settingsItemsFor. */
  hasFullAccess: boolean
}

/**
 * Settings tab row — route navigation between the settings pages (decision
 * 7: routes, not local component state). Hidden on mobile via
 * settings-shell.module.css; sections are chosen from the hamburger sheet
 * there instead.
 */
export default function SettingsTabs({ role, hasFullAccess }: SettingsTabsProps) {
  const pathname = usePathname()
  const items = settingsItemsFor(role, hasFullAccess)

  const activeItem = items.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + '/'),
  )

  const tabs = items.map((item) => ({
    id: item.href,
    label: item.label,
    href: item.href,
  }))

  return (
    <TabRail
      tabs={tabs}
      activeId={activeItem?.href ?? ''}
      ariaLabel="Settings sections"
    />
  )
}
