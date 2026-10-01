'use client'

import { useId, type ReactNode } from 'react'
import styles from './Checkbox.module.css'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  id?: string
  disabled?: boolean
}

/** Label + native checkbox, styled to match the app's square, hairline-bordered controls. */
export default function Checkbox({ checked, onChange, label, id, disabled }: CheckboxProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId

  return (
    <label htmlFor={inputId} className={styles.row}>
      <input
        id={inputId}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles.box} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </label>
  )
}
