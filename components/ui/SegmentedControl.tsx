import styles from './SegmentedControl.module.css'

export interface Segment<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  className?: string
}

/** Single-select control for mutually exclusive views (LIST / WEEK / MONTH …). */
export default function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={className ? `${styles.track} ${className}` : styles.track}
    >
      {segments.map((segment) => {
        const selected = segment.value === value
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`${styles.segment} ${selected ? styles.selected : ''}`}
            onClick={() => onChange(segment.value)}
          >
            {segment.label}
          </button>
        )
      })}
    </div>
  )
}
