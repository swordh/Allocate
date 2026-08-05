'use client'

import Button from './Button'
import Modal from './Modal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'neutral'
  /** Disables both actions while the confirm handler is in flight. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Destructive actions and unsaved-changes prompts. */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'CONFIRM',
  cancelLabel = 'CANCEL',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger-solid' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  )
}
