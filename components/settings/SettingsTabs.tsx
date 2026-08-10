'use client'

import { usePathname } from 'next/navigation'
import TabRail from '@/components/ui/TabRail'
import { settingsItemsForRole } from '@/components/nav/nav-items'
import type { Role } from '@/types'

interface SettingsTabsProps {
  role: Role
}

/**
 * Settings tab row — route navigation between the five settings pages
 * (decision 7: routes, not local component state). Hidden on mobile via
 * settings-shell.module.css; sections are chosen from the hamburger sheet
 * there instead.
 */
export default function SettingsTabs({ role }: SettingsTabsProps) {
  const pathname = usePathname()
  const items = settingsItemsForRole(role)

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
