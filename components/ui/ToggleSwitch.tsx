import styles from './ToggleSwitch.module.css'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  /** Secondary line under the label. */
  hint?: string
  disabled?: boolean
  id?: string
  className?: string
}

export default function ToggleSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
  className,
}: ToggleSwitchProps) {
  const control = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : 'Toggle'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${styles.track} ${checked ? styles.on : ''}`}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  )

  if (!label) {
    return className ? <span className={className}>{control}</span> : control
  }

  return (
    <label className={className ? `${styles.row} ${className}` : styles.row}>
      {control}
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </label>
  )
}
