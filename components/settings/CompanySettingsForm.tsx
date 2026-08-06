'use client'

import { useEffect, useRef, useState } from 'react'
import { updateCompanySettings, addCategory, removeCategory } from '@/actions/company'
import { TIMEZONE_OPTIONS } from '@/constants/company'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'
import ErrorBanner from '@/components/ui/ErrorBanner'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import type { Category } from '@/types'
import styles from './CompanySettingsForm.module.css'

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 'S'}`
}

interface CompanySettingsFormProps {
  name: string
  categories: Category[]
  typeCounts: Record<string, number>
  timezone?: string
}

export default function CompanySettingsForm({
  name: initialName,
  categories: initialCategories,
  typeCounts,
  timezone: initialTimezone,
}: CompanySettingsFormProps) {
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

  const tzChanged = timezone !== (initialTimezone ?? 'UTC')

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
              <span className={styles.categoryName}>{cat.name.toUpperCase()}</span>
              <span className={styles.categoryMeta}>
                {pluralize(typeCounts[cat.name] ?? 0, 'TYPE')} · {pluralize(cat.customFieldTemplates.length, 'FIELD')}
              </span>
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
              className={styles.flexInput}
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
              onClick={handleAddCategory}
              disabled={addingCategoryLoading || !newCategoryName.trim()}
            >
              {addingCategoryLoading ? 'ADDING…' : '+ ADD'}
            </Button>
          </div>
        </div>
      </div>

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
