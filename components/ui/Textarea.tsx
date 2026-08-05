import type { TextareaHTMLAttributes } from 'react'
import styles from './Textarea.module.css'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export default function Textarea({ invalid = false, className, ...rest }: TextareaProps) {
  const classes = [styles.textarea, invalid ? styles.invalid : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return <textarea className={classes} aria-invalid={invalid || undefined} {...rest} />
}
