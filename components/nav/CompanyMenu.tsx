'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { deleteSession } from '@/actions/auth'
import { getSwitchableCompanies } from '@/actions/companies'
import { useSupportContext } from '@/lib/support-context'
import { useCompanySwitch } from '@/lib/useCompanySwitch'
import type { UserCompany } from '@/lib/queries/companies'
import Icon from '@/components/ui/Icon'
import Popover from '@/components/ui/Popover'
import CompanySwitchOverlay from '@/components/ui/CompanySwitchOverlay'
import CompanyRow from './CompanyRow'
import styles from './CompanyMenu.module.css'

interface CompanyMenuProps {
  name: string
  email: string
  activeCompanyId: string
}

/**
 * Desktop user menu — person-icon trigger in the header, per issue #352's
 * design handoff (`design_handoff_user_menu_company_switch/`): identity
 * block, Help & feedback, YOUR COMPANIES (hidden entirely for a
 * single-company user), Sign out.
 */
export default function CompanyMenu({ name, email, activeCompanyId }: CompanyMenuProps) {
  const [open, setOpen] = useState(false)
  const [companies, setCompanies] = useState<UserCompany[] | null>(null)
  const [switchingName, setSwitchingName] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const { openHelp } = useSupportContext()
  const { status, error, switchTo } = useCompanySwitch()
  const router = useRouter()

  useEffect(() => {
    if (!open || companies !== null) return
    let cancelled = false
    getSwitchableCompanies()
      .then((cs) => { if (!cancelled) setCompanies(cs) })
      .catch(() => { if (!cancelled) setCompanies([]) })
    return () => { cancelled = true }
  }, [open, companies])

  function handleOpenHelp() {
    setOpen(false)
    openHelp()
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
      setSigningOut(false)
    }
  }

  async function handleRowClick(company: UserCompany) {
    setOpen(false)
    if (company.id === activeCompanyId) return
    setSwitchingName(company.name)
    const result = await switchTo(company.id)
    // On success switchTo() navigates away (window.location.href) — this
    // component unmounts, so reopening here only matters on failure.
    if (!result.ok) setOpen(true)
  }

  const showCompanies = (companies?.length ?? 0) > 1

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close account menu' : 'Open account menu'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="person" size={20} strokeWidth={1.9} className={open ? styles.triggerIconOpen : undefined} />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor="right"
        menu
        ariaLabel="Account menu"
        className={styles.panel}
      >
        <div className={styles.identity}>
          <p className={styles.name}>{name}</p>
          <p className={styles.email}>{email}</p>
        </div>

        <div className={styles.section}>
          <button type="button" role="menuitem" className={styles.actionRow} onClick={handleOpenHelp}>
            Help &amp; feedback
          </button>
        </div>

        {error && (
          <div className={styles.section}>
            <p className={styles.error}>{error}</p>
          </div>
        )}

        {showCompanies && (
          <div className={styles.section}>
            <p className={styles.sectionLabel}>Your companies</p>
            <div className={styles.rowList}>
              {companies!.map((company) => (
                <CompanyRow
                  key={company.id}
                  name={company.name}
                  active={company.id === activeCompanyId}
                  variant="menu"
                  role="menuitem"
                  onClick={() => handleRowClick(company)}
                />
              ))}
            </div>
          </div>
        )}

        <div className={styles.section}>
          <button
            type="button"
            role="menuitem"
            className={styles.actionRow}
            onClick={handleSignOut}
            disabled={signingOut}
          >
            Sign out
          </button>
        </div>
      </Popover>

      {status === 'switching' && switchingName && <CompanySwitchOverlay targetCompanyName={switchingName} />}
    </div>
  )
}
