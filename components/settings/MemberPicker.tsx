'use client'

import styles from './MemberPicker.module.css'

export interface PromotableMember {
  uid: string
  name: string
  email: string
}

interface MemberPickerProps {
  members: PromotableMember[]
  selected: string | null
  onSelect: (uid: string) => void
  name: string
}

/** Radio list of members a sole admin can promote before leaving — issue #352's blocked-leave flow. */
export default function MemberPicker({ members, selected, onSelect, name }: MemberPickerProps) {
  return (
    <div className={styles.list} role="radiogroup">
      {members.map((member) => (
        <label key={member.uid} className={styles.row}>
          <input
            type="radio"
            name={name}
            className={styles.input}
            checked={selected === member.uid}
            onChange={() => onSelect(member.uid)}
          />
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.info}>
            <span className={styles.name}>{member.name}</span>
            <span className={styles.email}>{member.email}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
