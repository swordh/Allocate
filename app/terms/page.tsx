import type { Metadata } from 'next'
import Link from 'next/link'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Terms of Service — Allocate',
}

export default function TermsPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.wordmark}>Allocate</Link>
      </header>

      <main className={styles.main}>
        <p className={styles.label}>Legal</p>
        <h1 className={styles.title}>Terms of Service</h1>
        <p className={styles.updated}>Last updated: 25 April 2026</p>

        <div className={styles.section}>
          <h2>The Service</h2>
          <p>
            Allocate is a cloud-based equipment booking and management service
            operated by Joakim Svärdh (enskild firma), Sweden. By creating an
            account you agree to these terms.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Account Responsibilities</h2>
          <ul>
            <li>You are responsible for keeping your login credentials secure.</li>
            <li>You must be at least 18 years old to use the service.</li>
            <li>Each company account must have at least one administrator responsible for managing team access.</li>
            <li>You are responsible for all activity that occurs under your account.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Use the service for any unlawful purpose.</li>
            <li>Attempt to gain unauthorized access to other accounts or company data.</li>
            <li>Interfere with or disrupt the service or its infrastructure.</li>
            <li>Reverse-engineer or attempt to extract the source code of the service.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Subscription and Billing</h2>
          <ul>
            <li>Paid plans are billed in advance on a monthly or annual basis via Stripe.</li>
            <li>Subscriptions renew automatically unless cancelled before the renewal date.</li>
            <li>You may cancel at any time from Settings → Subscription. Access continues until the end of the paid period.</li>
            <li>We do not offer refunds for partial billing periods, except where required by applicable law.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Data and Privacy</h2>
          <p>
            Your use of Allocate is also governed by our{' '}
            <Link href="/privacy">Privacy Policy</Link>, which is incorporated
            into these terms by reference.
          </p>
          <p>
            Booking records created within a company account belong to that
            company. When you delete your personal account, your data is
            anonymized but the company&apos;s operational records are preserved.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Service Availability</h2>
          <p>
            We aim for high availability but do not guarantee uninterrupted
            access. We may perform maintenance that temporarily limits access,
            and will endeavour to give advance notice for planned downtime.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, Joakim Svärdh is not liable
            for any indirect, incidental, or consequential damages arising from
            your use of the service. Our total liability for any claim is limited
            to the amount you paid in the three months preceding the claim.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Termination</h2>
          <p>
            You may stop using the service and delete your account at any time
            from Settings. We reserve the right to suspend or terminate accounts
            that violate these terms, with or without prior notice.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Governing Law</h2>
          <p>
            These terms are governed by Swedish law. Any disputes shall be
            resolved in Swedish courts.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Contact</h2>
          <p>
            Questions about these terms?{' '}
            <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>
          </p>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>© 2026 Allocate. All rights reserved.</p>
        <div className={styles.footerLinks}>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </div>
      </footer>
    </div>
  )
}
