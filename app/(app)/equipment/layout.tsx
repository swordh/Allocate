import { PageHeader } from '@/components/nav/PageHeader'
import styles from './equipment-layout.module.css'

export default function EquipmentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.contentWidth}>
      <PageHeader title="EQUIPMENT" />
      {children}
    </div>
  )
}
