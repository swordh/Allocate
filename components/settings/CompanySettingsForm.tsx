'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateCompanySettings, addCategory, removeCategory } from '@/actions/company'
import { requestCompanyDeletion, cancelCompanyDeletion } from '@/actions/companyDeletion'
import { confirmationMatchesCompanyName, canCancelCompanyDeletionInProduct } from '@/lib/companyDeletionUi'
import { TIMEZONE_OPTIONS } from '@/constants/company'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'
import ErrorBanner from '@/components/ui/ErrorBanner'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import type { Category, CompanyDeletion } from '@/types'
import styles from './CompanySettingsForm.module.css'

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 'S'}`
}

function formatDateFull(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

interface CompanySettingsFormProps {
  name: string
  categories: Category[]
  typeCounts: Record<string, number>
  timezone?: string
  /** Present when this company already has a deletion scheduled (issue #252 step 6). */
  deletion?: CompanyDeletion | null
}

export default function CompanySettingsForm({
  name: initialName,
  categories: initialCategories,
  typeCounts,
  timezone: initialTimezone,
  deletion = null,
}: CompanySettingsFormProps) {
  const router = useRouter()
  const [companyName, setCompanyName] = useState(initialName)
  const [categories, setCategories] = useState<Category[]>(
    [...(initialCategories ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  )
  const [timezone, setTimezone] = useState(initialTimezone ?? 'UTC')
  const [detectedTz, setDetectedTz] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // New-category input.
  const [newCategoryName, setNewCategoryName] = useState('')
  const [addingCategoryLoading, setAddingCategoryLoading] = useState(false)

  // Remove-category confirmation.
  const [removeTarget, setRemoveTarget] = useState<Category | null>(null)
  const [removing, setRemoving] = useState(false)

  // Danger zone — request/cancel company deletion (issue #252 step 6).
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('')
  const [requestingDeletion, setRequestingDeletion] = useState(false)
  const [deletionError, setDeletionError] = useState<string | null>(null)
  const [cancellingDeletion, setCancellingDeletion] = useState(false)

  useEffect(() => {
    try {
      setDetectedTz(Intl.DateTimeFormat().resolvedOptions().timeZone)
    } catch {
      setDetectedTz(null)
    }
  }, [])

  function clearSaved() {
    if (saved) setSaved(false)
  }

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    setSaved(false)

    const result = await updateCompanySettings({
      name: companyName,
      categoryTemplates: [],
      timezone,
    })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSaved(true)
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => setSaved(false), 2600)
    }
  }

  async function handleAddCategory() {
    const trimmed = newCategoryName.trim()
    if (!trimmed) return
    setAddingCategoryLoading(true)
    setError(null)

    const result = await addCategory(trimmed)

    setAddingCategoryLoading(false)

    if (result.error) {
      setError(result.error)
    } else if (result.id) {
      const newCat: Category = {
        id: result.id,
        name: trimmed,
        isDefault: false,
        createdAt: new Date().toISOString(),
        customFieldTemplates: [],
      }
      setCategories((prev) => [...prev, newCat].sort((a, b) => a.name.localeCompare(b.name)))
      setNewCategoryName('')
    }
  }

  async function handleConfirmRemove() {
    if (!removeTarget) return
    setRemoving(true)
    setError(null)

    const result = await removeCategory(removeTarget.id)

    setRemoving(false)

    if (result.error) {
      setError(result.error)
    } else {
      setCategories((prev) => prev.filter((c) => c.id !== removeTarget.id))
    }
    setRemoveTarget(null)
  }

  async function handleRequestDeletion() {
    setRequestingDeletion(true)
    setDeletionError(null)

    const result = await requestCompanyDeletion(deleteConfirmInput)

    setRequestingDeletion(false)

    if (result.error) {
      setDeletionError(result.error)
      return
    }

    // Success covers BOTH a fresh request and `alreadyRequested` — the
    // server treats a repeat as a no-op double-click guard, not an error,
    // and the UI does the same. Re-fetching from the server (rather than
    // fabricating a CompanyDeletion locally) is what makes `requestedByName`
    // and the rest of the record correct without duplicating server logic
    // here.
    setDeleteOpen(false)
    setDeleteConfirmInput('')
    router.refresh()
  }

  async function handleCancelDeletion() {
    setCancellingDeletion(true)
    setDeletionError(null)

    const result = await cancelCompanyDeletion()

    setCancellingDeletion(false)

    if (result.error) {
      setDeletionError(result.error)
      return
    }

    // `deletion` is FieldValue.delete()'d server-side, never set to a
    // 'canceled' value — re-fetching is what makes it disappear here too.
    router.refresh()
  }

  const tzChanged = timezone !== (initialTimezone ?? 'UTC')
  const deletionCancelable = canCancelCompanyDeletionInProduct(deletion)
  // Matched against `initialName` (the SAVED name), not the possibly-edited
  // `companyName` field state above — `requestCompanyDeletion` checks the
  // typed text against the name on the Firestore document, which is
  // `initialName` until "SAVE CHANGES" is pressed. Matching the live input
  // instead would let this button enable on text the server is certain to
  // reject.
  const confirmDisabled =
    requestingDeletion || !confirmationMatchesCompanyName(deleteConfirmInput, initialName)

  return (
    <div className={styles.container}>
      {/* Company name */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Company name</div>
          <div className={styles.rowHelp}>Shown on bookings and invitations.</div>
        </div>
        <div className={styles.rowControl}>
          <Input
            value={companyName}
            onChange={(e) => {
              setCompanyName(e.target.value)
              clearSaved()
            }}
            maxLength={100}
            required
          />
        </div>
      </div>

      {/* Time zone */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Time zone</div>
          <div className={styles.rowHelp}>
            All pickup and return times are shown in this zone.
            {tzChanged && ' Changing this shifts every existing booking time on screen.'}
          </div>
        </div>
        <div className={styles.tzControl}>
          <Select
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value)
              clearSaved()
            }}
          >
            {TIMEZONE_OPTIONS.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          {detectedTz && <span className={styles.detectedTz}>Detected on this device: {detectedTz}</span>}
        </div>
      </div>

      {/* Equipment categories */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Equipment categories</div>
          <div className={styles.rowHelp}>Manage the categories equipment can be organized into.</div>
        </div>
        <div className={styles.categoryList}>
          {categories.map((cat) => (
            <div key={cat.id} className={styles.categoryRow}>
              {/* Name + meta wrap together so mobile can stack them (design:
                  name on top, meta below at 4px) while desktop keeps its
                  existing single-line "NAME ... META" row — see
                  .categoryInfo in CompanySettingsForm.module.css. */}
              <div className={styles.categoryInfo}>
                <span className={styles.categoryName}>{cat.name.toUpperCase()}</span>
                <span className={styles.categoryMeta}>
                  {pluralize(typeCounts[cat.name] ?? 0, 'TYPE')} · {pluralize(cat.customFieldTemplates.length, 'FIELD')}
                </span>
              </div>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => setRemoveTarget(cat)}
                aria-label={`Remove ${cat.name}`}
              >
                ✕
              </button>
            </div>
          ))}
          <div className={styles.addCategoryRow}>
            <Input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="New category"
              inputSize="sm"
              className={`${styles.flexInput} ${styles.addCategoryInput}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddCategory()
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className={styles.addCategoryBtn}
              onClick={handleAddCategory}
              disabled={addingCategoryLoading || !newCategoryName.trim()}
            >
              {addingCategoryLoading ? 'ADDING…' : '+ ADD'}
            </Button>
          </div>
        </div>
      </div>

      {/* Danger zone — request/cancel company deletion. Admin-only in
          practice because this whole page redirects non-admins before it
          renders (app/(app)/settings/company/page.tsx), but the server
          action re-checks the role live from the transaction regardless —
          this component is never the only gate. */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowLabel}>Delete company</div>
          <div className={styles.rowHelp}>
            {deletion ? (
              deletionCancelable ? (
                <>
                  {deletion.requestedByName || 'An administrator'} requested this on{' '}
                  {formatDateFull(deletion.requestedAt)}. {initialName} works as usual until it is deleted
                  on {formatDateFull(deletion.scheduledFor)} — every member is affected, and any
                  administrator can cancel before then. Remaining paid time is not refunded.
                </>
              ) : (
                <>
                  The deletion of {initialName} has already started and can no longer be stopped here.
                  Contact support.
                </>
              )
            ) : (
              <>
                Deletes {initialName || 'this company'} and everything in it, seven days after you confirm.
                It keeps working as normal for every member during that time, and any administrator can
                cancel. Remaining paid time is not refunded.
              </>
            )}
          </div>
        </div>
        <div className={styles.buttonsRow}>
          {deletion ? (
            deletionCancelable && (
              <Button variant="secondary" size="sm" onClick={handleCancelDeletion} disabled={cancellingDeletion}>
                {cancellingDeletion ? 'CANCELLING…' : 'CANCEL DELETION'}
              </Button>
            )
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen((v) => !v)}
              disabled={requestingDeletion}
            >
              REQUEST DELETION
            </Button>
          )}
        </div>
      </div>

      {!deletion && deleteOpen && (
        <div className={styles.deleteConfirm}>
          <span className={styles.deleteText}>
            Type <strong>{initialName}</strong> to confirm. This starts a seven-day countdown; the
            company keeps working until then, and any administrator can cancel it before it runs out.
          </span>
          <div className={styles.deleteInputRow}>
            <Input
              value={deleteConfirmInput}
              onChange={(e) => {
                setDeleteConfirmInput(e.target.value)
                setDeletionError(null)
              }}
              placeholder={initialName}
              className={styles.deleteInput}
            />
            <Button
              variant="danger-solid"
              size="sm"
              onClick={handleRequestDeletion}
              disabled={confirmDisabled}
            >
              {requestingDeletion ? 'REQUESTING…' : 'CONFIRM'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDeleteOpen(false)
                setDeleteConfirmInput('')
                setDeletionError(null)
              }}
              disabled={requestingDeletion}
            >
              CANCEL
            </Button>
          </div>
        </div>
      )}

      {deletionError && <ErrorBanner tone="danger">{deletionError}</ErrorBanner>}

      <div className={styles.saveRow}>
        {saved && <span className={styles.saveNote}>COMPANY SETTINGS SAVED</span>}
        <Button variant="primary" size="sm" onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      <div className={styles.stickyBar}>
        <span className={styles.saveNote}>{saved ? 'SAVED' : ''}</span>
        <Button variant="primary" size="lg" onClick={handleSave} disabled={submitting}>
          {submitting ? 'SAVING…' : 'SAVE CHANGES'}
        </Button>
      </div>

      {error && <ErrorBanner tone="danger">{error}</ErrorBanner>}

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name ?? ''}?`}
        body="Equipment already assigned to this category keeps its value, but the category will no longer be selectable. This can't be undone."
        confirmLabel="REMOVE"
        cancelLabel="CANCEL"
        tone="danger"
        busy={removing}
        onConfirm={handleConfirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}
