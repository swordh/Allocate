import type { ReactNode } from 'react'
import styles from './LegalCards.module.css'

export interface LegalCard {
  title: string
  description: ReactNode
}

interface LegalCardsProps {
  cards: LegalCard[]
}

/** 2-up card grid — used for the third-party processors list. */
export default function LegalCards({ cards }: LegalCardsProps) {
  return (
    <div className={styles.grid}>
      {cards.map((card, i) => (
        <div key={i} className={styles.card}>
          <span className={styles.cardTitle}>{card.title}</span>
          <span className={styles.cardDesc}>{card.description}</span>
        </div>
      ))}
    </div>
  )
}
