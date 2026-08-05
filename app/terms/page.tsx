import type { Metadata } from 'next'
import Link from 'next/link'
import DataRows from '@/components/ui/DataRows'
import LegalLayout from '@/components/legal/LegalLayout'
import LegalSection from '@/components/legal/LegalSection'
import LegalList from '@/components/legal/LegalList'
import LegalContact from '@/components/legal/LegalContact'

export const metadata: Metadata = {
  title: 'Terms of Service — Allocate',
}

const SECTIONS = [
  { id: 'service', label: 'The service' },
  { id: 'account', label: 'Account responsibilities' },
  { id: 'use', label: 'Acceptable use' },
  { id: 'billing', label: 'Subscription & billing' },
  { id: 'data', label: 'Data and privacy' },
  { id: 'availability', label: 'Service availability' },
  { id: 'liability', label: 'Limitation of liability' },
  { id: 'termination', label: 'Termination' },
  { id: 'law', label: 'Governing law' },
  { id: 'contact', label: 'Contact' },
]

export default function TermsPage() {
  return (
    <LegalLayout
      page="terms"
      eyebrow="LAST UPDATED 25 APRIL 2026"
      title="Terms of Service"
      lede="These terms govern your use of Allocate. By creating an account you agree to them."
      sections={SECTIONS}
    >
      <LegalSection id="service" title="The Service">
        <p>
          Allocate is a cloud-based equipment booking and management service operated by
          Joakim Svärdh (enskild firma), Sweden. By creating an account you agree to these
          terms.
        </p>
      </LegalSection>

      <LegalSection id="account" title="Account Responsibilities">
        <LegalList
          items={[
            'You are responsible for keeping your login credentials secure.',
            'You must be at least 18 years old to use the service.',
            'Each company account must have at least one administrator responsible for managing team access.',
            'You are responsible for all activity that occurs under your account.',
          ]}
        />
      </LegalSection>

      <LegalSection id="use" title="Acceptable Use">
        <p>You agree not to:</p>
        <LegalList
          items={[
            'Use the service for any unlawful purpose.',
            'Attempt to gain unauthorized access to other accounts or company data.',
            'Interfere with or disrupt the service or its infrastructure.',
            'Reverse-engineer or attempt to extract the source code of the service.',
          ]}
        />
      </LegalSection>

      <LegalSection id="billing" title="Subscription and Billing">
        <DataRows
          variant="boxed"
          rows={[
            { term: 'BILLING', value: 'Paid plans are billed in advance on a monthly or annual basis via Stripe.' },
            {
              term: 'RENEWAL',
              value: 'Subscriptions renew automatically unless cancelled before the renewal date.',
            },
            {
              term: 'CANCELLATION',
              value:
                'You may cancel at any time from Settings → Subscription. Access continues until the end of the paid period.',
            },
            {
              term: 'REFUNDS',
              value: 'We do not offer refunds for partial billing periods, except where required by applicable law.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="data" title="Data and Privacy">
        <p>
          Your use of Allocate is also governed by our{' '}
          <Link href="/privacy">Privacy Policy</Link>, which is incorporated into these
          terms by reference.
        </p>
        <p>
          Booking records created within a company account belong to that company. When
          you delete your personal account, your data is anonymized but the
          company&apos;s operational records are preserved.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="Service Availability">
        <p>
          We aim for high availability but do not guarantee uninterrupted access. We may
          perform maintenance that temporarily limits access, and will endeavour to give
          advance notice for planned downtime.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Limitation of Liability">
        <p>
          To the maximum extent permitted by law, Joakim Svärdh is not liable for any
          indirect, incidental, or consequential damages arising from your use of the
          service. Our total liability for any claim is limited to the amount you paid in
          the three months preceding the claim.
        </p>
      </LegalSection>

      <LegalSection id="termination" title="Termination">
        <p>
          You may stop using the service and delete your account at any time from
          Settings. We reserve the right to suspend or terminate accounts that violate
          these terms, with or without prior notice.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Governing Law">
        <p>These terms are governed by Swedish law. Any disputes shall be resolved in Swedish courts.</p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>Questions about these terms?</p>
        <LegalContact
          columns={[
            {
              label: 'EMAIL',
              value: <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>,
            },
          ]}
        />
      </LegalSection>
    </LegalLayout>
  )
}
