import styles from './PageHeader.module.css'

interface PageHeaderProps {
  title: string
  actions?: React.ReactNode
}

export function PageHeader({ title, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.top}>
        <h1 className={styles.title}>{title}</h1>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={styles.rule} />
    </header>
  )
}
