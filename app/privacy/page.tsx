import type { Metadata } from 'next'
import Link from 'next/link'
import DataRows from '@/components/ui/DataRows'
import LegalLayout from '@/components/legal/LegalLayout'
import LegalSection from '@/components/legal/LegalSection'
import LegalCards from '@/components/legal/LegalCards'
import LegalContact from '@/components/legal/LegalContact'

export const metadata: Metadata = {
  title: 'Privacy Policy — Allocate',
}

const SECTIONS = [
  { id: 'controller', label: 'Data controller' },
  { id: 'collected', label: 'What we collect' },
  { id: 'why', label: 'Why we process it' },
  { id: 'processors', label: 'Third-party processors' },
  { id: 'retention', label: 'Data retention' },
  { id: 'rights', label: 'Your rights' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'changes', label: 'Changes to this policy' },
  { id: 'contact', label: 'Contact' },
]

export default function PrivacyPage() {
  return (
    <LegalLayout
      page="privacy"
      eyebrow="LAST UPDATED 27 APRIL 2026"
      title="Privacy Policy"
      lede="This policy explains what personal data Allocate collects when you use the service, why we collect it, who processes it on our behalf, and the rights you have over it."
      sections={SECTIONS}
    >
      <LegalSection id="controller" title="Data Controller">
        <p>
          Allocate is operated by Joakim Svärdh (enskild firma), Sweden. For any
          privacy-related questions, contact{' '}
          <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>.
        </p>
      </LegalSection>

      <LegalSection id="collected" title="What We Collect">
        <DataRows
          variant="boxed"
          rows={[
            { term: 'ACCOUNT DATA', value: 'Name and email address, provided at sign-up.' },
            { term: 'COMPANY DATA', value: 'Company name and team member roles.' },
            {
              term: 'BOOKING DATA',
              value: 'Project names, dates, and equipment selections you create within the service.',
            },
            {
              term: 'SUBSCRIPTION DATA',
              value:
                'Your current plan and billing period. Payment details are handled exclusively by Stripe — we never see or store card numbers.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="why" title="Why We Process It">
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'TO PROVIDE THE SERVICE',
              value:
                'Legal basis: contract. Your account, booking, and subscription data are necessary to operate Allocate.',
            },
            {
              term: 'TO COMPLY WITH LEGAL OBLIGATIONS',
              value:
                'Legal basis: legal obligation. E.g. retaining anonymized booking records for operational purposes.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="processors" title="Third-Party Processors">
        <p>
          We share data only with processors necessary to run the service, all operating
          under GDPR-compliant Data Processing Agreements:
        </p>
        <LegalCards
          cards={[
            {
              title: 'Google Firebase',
              description: 'Authentication, database, and cloud functions (EU region: europe-west1).',
            },
            { title: 'Stripe', description: 'Subscription billing and payment processing.' },
            { title: 'Vercel', description: 'Application hosting.' },
          ]}
        />
        <p>We do not sell your data or share it with advertisers.</p>
        <p>
          Some processors operate outside the European Economic Area. All such transfers
          are governed by Standard Contractual Clauses (SCCs) as approved by the European
          Commission, ensuring an equivalent level of data protection.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="Data Retention">
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'ACCOUNT DATA',
              value: 'Name, email — retained until you delete your account.',
            },
            {
              term: 'BOOKING RECORDS',
              value:
                "Retained in anonymized form for the duration of the company's subscription. Records cannot be traced back to you after account deletion.",
            },
            {
              term: 'INVOICE & PAYMENT RECORDS',
              value: 'Retained for 7 years in accordance with Swedish accounting law (Bokföringslagen).',
            },
            { term: 'SERVER LOGS', value: 'Retained for 30 days, then automatically deleted.' },
          ]}
        />
      </LegalSection>

      <LegalSection id="rights" title="Your Rights">
        <p>Under GDPR you have the right to:</p>
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'ACCESS',
              value: (
                <>
                  Your personal data — contact us at{' '}
                  <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a> and we will provide a
                  copy.
                </>
              ),
            },
            {
              term: 'ERASURE',
              value: 'Delete your account directly from Settings. Deletion is immediate and permanent.',
            },
            { term: 'CORRECTION', value: 'Update your name and email from your profile settings.' },
            {
              term: 'PORTABILITY',
              value: (
                <>
                  Download your data directly from your{' '}
                  <Link href="/settings/account">Account Settings</Link>.
                </>
              ),
            },
            {
              term: 'COMPLAINT',
              value: (
                <>
                  You may lodge a complaint with the Swedish supervisory authority,{' '}
                  <a href="https://www.imy.se" target="_blank" rel="noopener noreferrer">
                    IMY (Integritetsskyddsmyndigheten)
                  </a>
                  .
                </>
              ),
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>
          Allocate uses a single session cookie to keep you signed in. No tracking or
          advertising cookies are used.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to This Policy">
        <p>
          We may update this policy from time to time. Material changes will be
          communicated via email or an in-app notice. Continued use of the service after
          changes constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <LegalContact
          columns={[
            {
              label: 'EMAIL',
              value: <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>,
            },
            { label: 'ENTITY', value: 'Joakim Svärdh (enskild firma), Sweden' },
          ]}
        />
      </LegalSection>
    </LegalLayout>
  )
}
