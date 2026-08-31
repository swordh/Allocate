import type { ReactNode } from 'react'
import styles from './LegalList.module.css'

interface LegalListProps {
  items: ReactNode[]
}

/** The em-dash list used for account responsibilities / acceptable-use items. */
export default function LegalList({ items }: LegalListProps) {
  return (
    <ul className={styles.list}>
      {items.map((item, i) => (
        <li key={i} className={styles.item}>
          {item}
        </li>
      ))}
    </ul>
  )
}
