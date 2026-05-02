'use client'

import { useState } from 'react'
import { updateCompanySettings, addCategory, removeCategory } from '@/actions/company'
import type { Category, CategoryFieldTemplate } from '@/types'
import styles from './CompanySettingsForm.module.css'

interface CompanySettingsFormProps {
  name: string
  categories: Category[]
}

export default function CompanySettingsForm({
  name: initialName,
  categories: initialCategories,
}: CompanySettingsFormProps) {
  const [companyName, setCompanyName] = useState(initialName)
  const [categories, setCategories] = useState<Category[]>(initialCategories ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Inline add-category state
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [addingCategoryLoading, setAddingCategoryLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setSuccess(false)

    const result = await updateCompanySettings({
      name: companyName,
      categoryTemplates: categories.map((cat) => ({
        categoryId: cat.id,
        templates: cat.customFieldTemplates,
      })),
    })

    setSubmitting(false)

    if (result.error) {
      setError(result.error)
    } else {
      setSuccess(true)
    }
  }

  async function handleAddCategory() {
    const trimmed = newCategoryName.trim()
    if (!trimmed) return
    setAddingCategoryLoading(true)

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
      setCategories((prev) => [...prev, newCat])
      setNewCategoryName('')
      setAddingCategory(false)
      setSuccess(false)
    }
  }

  async function handleRemoveCategory(categoryId: string) {
    const result = await removeCategory(categoryId)
    if (result.error) {
      setError(result.error)
    } else {
      setCategories((prev) => prev.filter((c) => c.id !== categoryId))
      setSuccess(false)
    }
  }

  function handleAddField(categoryId: string) {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.id === categoryId
          ? {
              ...cat,
              customFieldTemplates: [
                ...cat.customFieldTemplates,
                { id: crypto.randomUUID(), label: '', type: 'text', defaultValue: '', options: [] },
              ],
            }
          : cat
      )
    )
    setSuccess(false)
  }

  function handleRemoveField(categoryId: string, fieldId: string) {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.id === categoryId
          ? {
              ...cat,
              customFieldTemplates: cat.customFieldTemplates.filter((f) => f.id !== fieldId),
            }
          : cat
      )
    )
    setSuccess(false)
  }

  function handleFieldChange(
    categoryId: string,
    fieldId: string,
    key: keyof CategoryFieldTemplate,
    value: string | boolean | string[]
  ) {
    setCategories((prev) =>
      prev.map((cat) =>
        cat.id === categoryId
          ? {
              ...cat,
              customFieldTemplates: cat.customFieldTemplates.map((f) =>
                f.id === fieldId ? { ...f, [key]: value } : f
              ),
            }
          : cat
      )
    )
    setSuccess(false)
  }

  return (
    <div className={styles.container}>
      <form onSubmit={handleSubmit} className={styles.form}>

        {/* Company Name */}
        <div className={styles.companyNameSection}>
          <div className={styles.companyNameField}>
            <label htmlFor="company-name" className={styles.fieldLabel}>
              Company Name
            </label>
            <input
              id="company-name"
              type="text"
              className={styles.fieldInput}
              value={companyName}
              onChange={(e) => {
                setCompanyName(e.target.value)
                setSuccess(false)
              }}
              maxLength={100}
              required
            />
          </div>
        </div>

        {/* Custom Fields */}
        <div className={styles.customFieldsSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionHeaderLabel}>Custom Fields</span>
            <div className={styles.sectionHeaderLine} />
          </div>
          <p className={styles.customFieldsDescription}>
            Define custom fields per equipment category. These fields appear when adding or editing equipment in that category.
          </p>

          {categories.map((cat) => (
            <details key={cat.id} className={styles.categoryDetails} open>
              <summary className={styles.categorySummary}>
                <span className={styles.categoryName}>{cat.name.toUpperCase()}</span>
                <button
                  type="button"
                  className={styles.btnRemoveCategory}
                  onClick={(e) => {
                    e.preventDefault()
                    handleRemoveCategory(cat.id)
                  }}
                >
                  × REMOVE CATEGORY
                </button>
              </summary>
              <div className={styles.categoryBody}>
                {cat.customFieldTemplates.map((field) => (
                  <div key={field.id} className={styles.fieldRow}>
                    <select
                      value={field.type}
                      onChange={(e) =>
                        handleFieldChange(cat.id, field.id, 'type', e.target.value)
                      }
                      className={styles.fieldTypeSelect}
                    >
                      <option value="text">Text</option>
                      <option value="boolean">Boolean</option>
                      <option value="list">List/Dropdown</option>
                      <option value="value">Numeric Range</option>
                    </select>

                    <input
                      type="text"
                      className={styles.fieldNameInput}
                      placeholder="Field label"
                      value={field.label}
                      onChange={(e) =>
                        handleFieldChange(cat.id, field.id, 'label', e.target.value)
                      }
                    />

                    {field.type === 'text' && (
                      <input
                        type="text"
                        className={styles.fieldDefaultInput}
                        placeholder="Default value"
                        value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                        onChange={(e) =>
                          handleFieldChange(cat.id, field.id, 'defaultValue', e.target.value)
                        }
                      />
                    )}

                    {field.type === 'boolean' && (
                      <div className={styles.booleanToggleRow}>
                        <button
                          type="button"
                          className={`${styles.toggle} ${field.defaultValue === true ? styles.toggleOn : ''}`}
                          onClick={() =>
                            handleFieldChange(cat.id, field.id, 'defaultValue', field.defaultValue !== true)
                          }
                          role="switch"
                          aria-checked={field.defaultValue === true}
                        />
                      </div>
                    )}

                    {field.type === 'list' && (
                      <input
                        type="text"
                        className={styles.fieldOptionsInput}
                        placeholder="Options (comma or space-separated)"
                        value={field.options?.join(', ') || ''}
                        onChange={(e) => {
                          const opts = e.target.value
                            .split(/[,\s]+/)
                            .map(s => s.trim())
                            .filter(s => s.length > 0);
                          handleFieldChange(cat.id, field.id, 'options', opts);
                        }}
                      />
                    )}

                    {field.type === 'value' && (
                      <input
                        type="text"
                        className={styles.fieldDefaultInput}
                        placeholder="Min value (e.g., 0)"
                        value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                        onChange={(e) =>
                          handleFieldChange(cat.id, field.id, 'defaultValue', e.target.value)
                        }
                      />
                    )}

                    <button
                      type="button"
                      className={styles.btnRemoveField}
                      onClick={() => handleRemoveField(cat.id, field.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className={styles.addFieldRow}>
                  <button
                    type="button"
                    className={styles.btnAddField}
                    onClick={() => handleAddField(cat.id)}
                  >
                    + ADD CUSTOM FIELD
                  </button>
                </div>
              </div>
            </details>
          ))}

          {addingCategory ? (
            <div className={styles.addCategoryInline}>
              <input
                type="text"
                className={styles.addCategoryInput}
                placeholder="Category name"
                value={newCategoryName}
                autoFocus
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddCategory()
                  }
                  if (e.key === 'Escape') {
                    setAddingCategory(false)
                    setNewCategoryName('')
                  }
                }}
              />
              <button
                type="button"
                className={styles.btnAddCategoryConfirm}
                onClick={handleAddCategory}
                disabled={addingCategoryLoading || !newCategoryName.trim()}
              >
                {addingCategoryLoading ? 'Adding…' : 'Add'}
              </button>
              <button
                type="button"
                className={styles.btnAddCategoryCancel}
                onClick={() => {
                  setAddingCategory(false)
                  setNewCategoryName('')
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.btnAddCategory}
              onClick={() => setAddingCategory(true)}
            >
              + ADD CATEGORY
            </button>
          )}
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}
        {success && <div className={styles.successBanner}>Changes saved.</div>}

        <button type="submit" className={styles.btnSave} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save Changes'}
        </button>
      </form>
    </div>
  )
}
