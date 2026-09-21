'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  updateUserProfile,
  deleteAccount,
  exportUserData,
  getAccountDeletionPreview,
  type AccountDeletionPreview,
} from '@/actions/account'
import { deleteSession } from '@/actions/auth'
import { requestEmailChange, requestPasswordReset } from '@/actions/auth-email'
import { auth } from '@/lib/firebase'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Chip, { type ChipTone } from '@/components/ui/Chip'
import ErrorBanner from '@/components/ui/ErrorBanner'
import LeaveCompanyFlow from './LeaveCompanyFlow'
import LeaveCompanyEntry from './LeaveCompanyEntry'
import { BOOKING_VIEW_OPTIONS, BOOKING_VIEW_LABELS, type BookingViewOption } from '@/constants/company'
import type { CompanyDeletionOutcome, DeletionOutcome } from '@/lib/queries/deletionOutcomes'
import styles from './AccountSettingsForm.module.css'

// ── Account-deletion preview copy (issue #252 step 6 PR 2) ─────────────────
//
// One entry per `DeletionOutcome` (lib/queries/deletionOutcomes.ts). Kept as
// small lookup tables rather than inline in the JSX so `close`'s wording is
// easy to audit in one place: per the designbrief, this is the ONE outcome
// whose copy must never mention a deadline, a 7-day window, or support being
// able to stop it — none of that applies here, and PR 1 just introduced all
// three phrases elsewhere in this app's company-deletion copy, which is
// exactly the context a "quick" wording pass on this outcome could bleed in
// from by habit.
const PREVIEW_LABELS: Record<DeletionOutcome, string> = {
  leave: 'STAYS OPEN',
  blocked: 'NEEDS ACTION',
  close: 'DELETED WITH ACCOUNT',
  unknown: 'COULD NOT CHECK',
}

const PREVIEW_CHIP_TONE: Record<DeletionOutcome, ChipTone> = {
  leave: 'neutral',
  blocked: 'danger',
  close: 'danger',
  unknown: 'neutral',
}

function previewBody(company: CompanyDeletionOutcome): string {
  switch (company.outcome) {
    case 'leave':
      return "You'll leave this company. It carries on without you."
    case 'blocked': {
      const otherCount = Math.max(company.memberCount - 1, 0)
      const people = otherCount === 1 ? '1 other person works' : `${otherCount} other people work`
      return `You're the only administrator here, where ${people}. Make someone else an administrator first, then you'll be able to delete your account.`
    }
    case 'close':
      // No mention of a deadline, a window, or support stopping it — none of
      // that applies to this outcome. See this table's own comment above.
      return "You're its only member, so it will be permanently deleted the moment your account is — immediately, with no way to undo it."
    case 'unknown':
      return "Something went wrong reading this company. That's a technical problem, not something blocking you — try again in a moment."
  }
}

interface AccountSettingsFormProps {
  name: string
  email: string
  defaultBookingView?: BookingViewOption
  activeCompanyId: string
}

export default function AccountSettingsForm({
  name: initialName,
  email,
  defaultBookingView: initialView,
  activeCompanyId,
}: AccountSettingsFormProps) {
  const router = useRouter()

  const [name, setName] = useState(initialName)
  const [defaultBookingView, setDefaultBookingView] = useState<BookingViewOption>(initialView ?? 'list')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [confirmInput, setConfirmInput] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // issue #349: `setDeleting(true)` isn't synchronous, so a fast double click
  // can fire handleDeleteAccount twice before `disabled` re-renders. This ref
  // is set synchronously, before any `await`, closing that window on the
  // client — the server-side lock (actions/account.ts) is the real guard.
  const deletingRef = useRef(false)

  // Per-company consequence preview (issue #252 step 6 PR 2). Fetched fresh
  // every time the delete panel opens, and again on demand via "REFRESH" —
  // e.g. after the user hands over admin rights on /settings/team and comes
  // back. Advisory only: see getAccountDeletionPreview's own docblock. Never
  // used to enable/disable the CONFIRM button below — a stale "safe" or
  // stale "blocked" reading here must not change what deleteAccount does.
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Which company the "My companies" section (issue #352) is showing the
  // leave-company flow for, if any.
  const [leavingCompany, setLeavingCompany] = useState<CompanyDeletionOutcome | null>(null)

  const [signingOut, setSigningOut] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // Change-email flow: an inline form revealed by "CHANGE EMAIL →".
  const [showEmailChange, setShowEmailChange] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailSubmitting, setEmailSubmitting] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)

  // Change-password flow: sends a reset link to the user's own address.
  // requestPasswordReset is deliberately enumeration-safe (it never returns an
  // error), so the confirmation below is shown unconditionally.
  const [passwordSending, setPasswordSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  function clearSaved() {
    if (saved) setSaved(false)
  }

  async function handleEmailChange() {
    if (emailSubmitting || newEmail.trim().length === 0) return
    setEmailSubmitting(true)
    setEmailError(null)
    try {
      const user = auth.currentUser
      if (!user) {
        setEmailError('Your session expired. Please sign in again.')
        return
      }
      const idToken = await user.getIdToken()
      const result = await requestEmailChange(idToken, newEmail.trim())
      if (result.error) {
        setEmailError(result.error)
      } else {
        setEmailSent(true)
      }
    } catch {
      setEmailError('Something went wrong. Please try again.')
    } finally {
      setEmailSubmitting(false)
    }
  }

  async function handlePasswordReset() {
    setPasswordSending(true)
    try {
      await requestPasswordReset(email)
      setResetSent(true)
    } finally {
      setPasswordSending(false)
    }
  }

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    setSaved(false)

    const result = await updateUserProfile({ name, defaultBookingView })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => setSaved(false), 2600)
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await deleteSession()
      router.push('/login')
    } catch (err) {
      console.error('Sign out failed:', err)
    } finally {
      setSigningOut(false)
    }
  }

  async function handleExportData() {
    setExporting(true)
    setExportError(null)
    const result = await exportUserData()
    setExporting(false)
    if (result.error) {
      setExportError(result.error)
      return
    }
    const blob = new Blob([result.json!], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'allocate-my-data.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadPreview() {
    setPreviewLoading(true)
    const result = await getAccountDeletionPreview()
    setPreview(result)
    setPreviewLoading(false)
  }

  // Fetched once on mount rather than lazily on delete-panel open (as it
  // used to be pre-#352): the same per-company membership list now also
  // backs the "My companies" section below, which is visible unconditionally,
  // not just after expressing intent to delete. REFRESH buttons throughout
  // (including inside the delete panel) re-run this on demand — e.g. after
  // leaving/promoting on another tab, or after the delete panel's own
  // "GO TO TEAM →" round trip.
  useEffect(() => {
    loadPreview()
  }, [])

  async function handleDeleteAccount() {
    if (confirmInput !== 'DELETE' || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)

    const result = await deleteAccount()

    if (result.error) {
      setDeleteError(result.error)
      setDeleting(false)
      deletingRef.current = false
    } else {
      router.push('/login')
    }
  }

  // Derived purely for the extra warning sentence next to the DELETE input
  // below — never used to gate the CONFIRM button. See loadPreview's and
  // getAccountDeletionPreview's docblocks: this preview can be stale, and
  // deleteAccount's own guard (not this component) is what actually decides.
  const closingCompanies =
    preview?.status === 'ready' ? preview.companies.filter((c) => c.outcome === 'close') : []

  return (
    <div className={styles.container}>
      {/* Name */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Name</div>
          <div className={styles.rowHelp}>Shown on bookings you create.</div>
        </div>
        <div className={styles.rowControl}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              clearSaved()
            }}
            maxLength={100}
            required
          />
        </div>
      </div>

      {/* Email */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Email</div>
          <div className={styles.rowHelp}>Used to sign in. Changing it requires confirming the new address.</div>
        </div>
        <div className={styles.rowControl}>
          <div className={styles.emailValueRow}>
            <div className={styles.emailBox}>
              <span className={styles.emailValue}>{email}</span>
              {!emailSent && (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setShowEmailChange((v) => !v)}
                >
                  {showEmailChange ? 'CANCEL' : 'CHANGE EMAIL →'}
                </button>
              )}
            </div>
            {showEmailChange && !emailSent && (
              <div className={styles.inlineRow}>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="new@address.com"
                  value={newEmail}
                  onChange={(e) => {
                    setNewEmail(e.target.value)
                    setEmailError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleEmailChange()
                    }
                  }}
                  disabled={emailSubmitting}
                  className={styles.flexInput}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleEmailChange}
                  disabled={emailSubmitting || newEmail.trim().length === 0}
                >
                  {emailSubmitting ? 'SENDING…' : 'SEND LINK'}
                </Button>
              </div>
            )}
            {emailError && <ErrorBanner tone="danger">{emailError}</ErrorBanner>}
            {emailSent && (
              <ErrorBanner tone="info">
                We sent a confirmation link to {newEmail.trim()}. The change takes effect once you click it.
              </ErrorBanner>
            )}
          </div>
        </div>
      </div>

      {/* Default view — no design mockup for this row; the design's own
          viewChips helper exists but is unrendered anywhere. Preserved here
          per correction: "defaultBookingView stays on the Account form where
          it already is." Styled to match the surrounding rows. */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Default view</div>
          <div className={styles.rowHelp}>Choose which view opens by default when you navigate to Bookings.</div>
        </div>
        <div className={styles.chipRow}>
          {BOOKING_VIEW_OPTIONS.map((v) => (
            <Chip
              key={v}
              active={defaultBookingView === v}
              onClick={() => {
                setDefaultBookingView(v)
                clearSaved()
              }}
            >
              {BOOKING_VIEW_LABELS[v]}
            </Chip>
          ))}
        </div>
      </div>

      {/* My companies (issue #352) — one row per membership, each with its
          own "Leave …" entry point. Shares the same fetched CompanyDeletionOutcome[]
          the delete-account panel below already uses (loadPreview effect above) —
          `outcome` doesn't map 1:1 onto leave-company UX (`close` here just
          means "leave routes into the deletion flow", not "delete my
          account"), but the underlying role/memberCount/adminCount read is
          identical, so a second query would be pure duplication. */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>My companies</div>
          <div className={styles.rowHelp}>
            Step out of a company yourself. No administrator has to remove you.
          </div>
        </div>
        <div className={styles.rowControl}>
          {previewLoading && !preview && <p className={styles.previewStatus}>Checking your companies…</p>}
          {preview?.status === 'ready' && preview.companies.length === 0 && (
            <p className={styles.previewStatus}>You are not a member of any company.</p>
          )}
          {preview?.status === 'ready' && preview.companies.length > 0 && (
            <div className={styles.companiesList}>
              {preview.companies.map((company) => (
                <LeaveCompanyEntry
                  key={company.companyId}
                  companyName={company.companyName || 'Untitled company'}
                  outcome={company.outcome}
                  memberCount={company.memberCount}
                  onOpen={() => setLeavingCompany(company)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Password & data */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Password &amp; data</div>
          <div className={styles.rowHelp}>Reset your password or download everything we store about you.</div>
        </div>
        <div className={styles.buttonsRow}>
          <Button variant="secondary" size="sm" onClick={handlePasswordReset} disabled={passwordSending}>
            {passwordSending ? 'SENDING…' : 'SEND RESET LINK'}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleExportData} disabled={exporting}>
            {exporting ? 'PREPARING…' : 'EXPORT MY DATA'}
          </Button>
        </div>
      </div>

      {/* Session & account */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Session &amp; account</div>
          <div className={styles.rowHelp}>Sign out on this device, or permanently delete your account.</div>
        </div>
        <div className={styles.buttonsRow}>
          <Button variant="secondary" size="sm" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? 'SIGNING OUT…' : 'SIGN OUT'}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen((v) => !v)}>
            DELETE ACCOUNT
          </Button>
        </div>
      </div>

      <div className={styles.saveRow}>
        {saved && <span className={styles.saveNote}>ACCOUNT SAVED</span>}
        <Button variant="primary" size="sm" onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      {/* Mobile-only sticky bar — same handler, duplicated per the desktop
          row because the design shows the CTA fixed to the viewport bottom
          on small screens instead of inline. */}
      <div className={styles.stickyBar}>
        <span className={styles.saveNote}>{saved ? 'SAVED' : ''}</span>
        <Button variant="primary" size="lg" fullWidth={false} onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}
      {exportError && <ErrorBanner tone="danger">{exportError}</ErrorBanner>}

      {resetSent && (
        <ErrorBanner
          tone="info"
          action={
            <button type="button" className={styles.dismissBtn} onClick={() => setResetSent(false)}>
              DISMISS
            </button>
          }
        >
          Reset link sent to {email}. It expires in 1 hour — check your spam folder if it does not arrive.
        </ErrorBanner>
      )}

      {deleteOpen && (
        <div className={styles.deletePanel}>
          {/* Per-company consequence preview — designbrief "Del 1": "Förstå
              exakt vad som händer med varje företag hen tillhör, innan
              raderingen påbörjas." Every company gets its own line; this is
              never collapsed into a single worst-case message. */}
          {previewLoading && !preview && (
            <p className={styles.previewStatus}>Checking your companies…</p>
          )}

          {preview?.status === 'error' && (
            <ErrorBanner
              tone="neutral"
              action={
                <button
                  type="button"
                  className={styles.dismissBtn}
                  onClick={loadPreview}
                  disabled={previewLoading}
                >
                  {previewLoading ? 'CHECKING…' : 'RETRY'}
                </button>
              }
            >
              Could not check your companies right now. That&apos;s a technical problem — it doesn&apos;t mean
              you&apos;re blocked. Try again, or delete anyway and we&apos;ll check for real at that point.
            </ErrorBanner>
          )}

          {preview?.status === 'ready' && preview.companies.length > 0 && (
            <ul className={styles.previewList}>
              {preview.companies.map((company) => (
                <li key={company.companyId} className={styles.previewItem}>
                  <div className={styles.previewHeader}>
                    <span className={styles.previewCompany}>{company.companyName || 'Untitled company'}</span>
                    <Chip size="sm" tone={PREVIEW_CHIP_TONE[company.outcome]} interactive={false}>
                      {PREVIEW_LABELS[company.outcome]}
                    </Chip>
                  </div>
                  <p className={styles.previewBody}>{previewBody(company)}</p>
                  {company.outcome === 'blocked' && (
                    <div className={styles.previewActions}>
                      <Button variant="secondary" size="sm" href="/settings/team">
                        GO TO TEAM →
                      </Button>
                      <button
                        type="button"
                        className={styles.dismissBtn}
                        onClick={loadPreview}
                        disabled={previewLoading}
                      >
                        {previewLoading ? 'CHECKING…' : 'REFRESH'}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className={styles.deleteConfirm}>
            <span className={styles.deleteText}>
              Type DELETE to permanently remove your account.
              {closingCompanies.length > 0 && (
                <>
                  {' '}
                  {/* Hedged on WHICH companies, not on what happens to them: this
                      reads from `preview`, which can go stale the moment a tab
                      elsewhere changes something (see getAccountDeletionPreview's
                      and loadPreview's own docblocks). "As last checked" is
                      honest about that without softening the consequence itself —
                      deleteAccount's own guard decides for real, live, when
                      CONFIRM is pressed; this sentence never claims to. */}
                  As last checked, this also permanently deletes{' '}
                  {closingCompanies.length === 1
                    ? closingCompanies[0]!.companyName || 'the company above'
                    : `${closingCompanies.length} companies`}{' '}
                  — immediately, no undo.{' '}
                  <button
                    type="button"
                    className={styles.dismissBtn}
                    onClick={loadPreview}
                    disabled={previewLoading}
                  >
                    {previewLoading ? 'CHECKING…' : 'REFRESH'}
                  </button>
                </>
              )}
            </span>
            <div className={styles.deleteInputRow}>
              <Input
                value={confirmInput}
                onChange={(e) => {
                  setConfirmInput(e.target.value)
                  setDeleteError(null)
                }}
                placeholder="DELETE"
                className={styles.deleteInput}
              />
              <Button
                variant="danger-solid"
                size="sm"
                onClick={handleDeleteAccount}
                disabled={confirmInput !== 'DELETE' || deleting}
              >
                {deleting ? 'DELETING…' : 'CONFIRM'}
              </Button>
            </div>
            {deleteError && <ErrorBanner tone="danger">{deleteError}</ErrorBanner>}
          </div>
        </div>
      )}

      {leavingCompany && (
        <LeaveCompanyFlow
          key={leavingCompany.companyId}
          companyId={leavingCompany.companyId}
          companyName={leavingCompany.companyName || 'this company'}
          isActiveCompany={leavingCompany.companyId === activeCompanyId}
          email={email}
          outcome={leavingCompany.outcome}
          memberCount={leavingCompany.memberCount}
          onClose={() => {
            setLeavingCompany(null)
            loadPreview()
          }}
        />
      )}
    </div>
  )
}
