import styles from './PageHeader.module.css'

interface PageHeaderProps {
  title: string
  actions?: React.ReactNode
  nav?: React.ReactNode
}

export function PageHeader({ title, actions, nav }: PageHeaderProps) {
  return (
    <header className={`${styles.header} ${nav ? styles.headerWithNav : ''}`}>
      <div className={styles.top}>
        <h1 className={styles.title}>{title}</h1>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {nav ?? <div className={styles.rule} />}
    </header>
  )
}
