import { getOperatorSession } from '@/lib/operator-dal'
import OperatorShellClient from './_components/OperatorShellClient'
import styles from './layout.module.css'

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const session = await getOperatorSession()
  return (
    <div className={styles.shell}>
      <OperatorShellClient email={session.email} />
      <main className={styles.main}>{children}</main>
    </div>
  )
}
