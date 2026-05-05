import { getOperatorSession } from '@/lib/operator-dal'
import OperatorShellClient from './_components/OperatorShellClient'
import styles from './layout.module.css'

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  await getOperatorSession()
  return (
    <div className={styles.shell}>
      <OperatorShellClient />
      <main className={styles.main}>{children}</main>
    </div>
  )
}
