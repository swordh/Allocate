import type { Metadata } from 'next'
import Link from 'next/link'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Privacy Policy — Allocate',
}

export default function PrivacyPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.wordmark}>Allocate</Link>
      </header>

      <main className={styles.main}>
        <p className={styles.label}>Legal</p>
        <h1 className={styles.title}>Privacy Policy</h1>
        <p className={styles.updated}>Last updated: 27 April 2026</p>

        <div className={styles.section}>
          <h2>Data Controller</h2>
          <p>
            Allocate is operated by Joakim Svärdh (enskild firma), Sweden.
            For any privacy-related questions, contact{' '}
            <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>.
          </p>
        </div>

        <div className={styles.section}>
          <h2>What We Collect</h2>
          <ul>
            <li><strong>Account data:</strong> name and email address, provided at sign-up.</li>
            <li><strong>Company data:</strong> company name and team member roles.</li>
            <li><strong>Booking data:</strong> project names, dates, and equipment selections you create within the service.</li>
            <li><strong>Subscription data:</strong> your current plan and billing period. Payment details are handled exclusively by Stripe — we never see or store card numbers.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Why We Process It</h2>
          <ul>
            <li><strong>To provide the service</strong> (legal basis: contract) — your account, booking, and subscription data are necessary to operate Allocate.</li>
            <li><strong>To comply with legal obligations</strong> (legal basis: legal obligation) — e.g. retaining anonymized booking records for operational purposes.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Third-Party Processors</h2>
          <p>We share data only with processors necessary to run the service, all operating under GDPR-compliant Data Processing Agreements:</p>
          <ul>
            <li><strong>Google Firebase</strong> — authentication, database, and cloud functions (EU region: europe-west1).</li>
            <li><strong>Stripe</strong> — subscription billing and payment processing.</li>
            <li><strong>Vercel</strong> — application hosting.</li>
          </ul>
          <p>We do not sell your data or share it with advertisers.</p>
          <p>
            Some processors operate outside the European Economic Area. All such transfers
            are governed by Standard Contractual Clauses (SCCs) as approved by the
            European Commission, ensuring an equivalent level of data protection.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Data Retention</h2>
          <ul>
            <li><strong>Account data</strong> (name, email): retained until you delete your account.</li>
            <li><strong>Booking records:</strong> retained in anonymized form for the duration of the company&apos;s subscription. Records cannot be traced back to you after account deletion.</li>
            <li><strong>Invoice and payment records:</strong> retained for 7 years in accordance with Swedish accounting law (Bokföringslagen).</li>
            <li><strong>Server logs:</strong> retained for 30 days, then automatically deleted.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Your Rights</h2>
          <p>Under GDPR you have the right to:</p>
          <ul>
            <li><strong>Access</strong> your personal data — contact us at <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a> and we will provide a copy.</li>
            <li><strong>Erasure</strong> — delete your account directly from Settings. Deletion is immediate and permanent.</li>
            <li><strong>Correction</strong> — update your name and email from your profile settings.</li>
            <li><strong>Portability</strong> — download your data directly from your{' '}<Link href="/settings/account">Account Settings</Link>.</li>
            <li><strong>Complaint</strong> — you may lodge a complaint with the Swedish supervisory authority, <a href="https://www.imy.se" target="_blank" rel="noopener noreferrer">IMY (Integritetsskyddsmyndigheten)</a>.</li>
          </ul>
        </div>

        <div className={styles.section}>
          <h2>Cookies</h2>
          <p>
            Allocate uses a single session cookie to keep you signed in. No
            tracking or advertising cookies are used.
          </p>
        </div>

        <div className={styles.section}>
          <h2>Changes to This Policy</h2>
          <p>
            We may update this policy from time to time. Material changes will be
            communicated via email or an in-app notice. Continued use of the
            service after changes constitutes acceptance.
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
