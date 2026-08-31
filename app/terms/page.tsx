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
      lede="Lorem ipsum dolor sit amet, consectetur adipiscing elit. This placeholder text stands in for the real terms while the page is being tested."
      sections={SECTIONS}
    >
      <LegalSection id="service" title="Lorem Ipsum Dolor">
        <p>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
          incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
          nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
        </p>
      </LegalSection>

      <LegalSection id="account" title="Consectetur Adipiscing">
        <LegalList
          items={[
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
            'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
            'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
            'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.',
          ]}
        />
      </LegalSection>

      <LegalSection id="use" title="Sed Do Eiusmod">
        <p>Lorem ipsum dolor sit amet:</p>
        <LegalList
          items={[
            'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.',
            'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
            'Curabitur pretium tincidunt lacus, ut interdum tellus elit sed risus.',
            'Nam eget dui. Etiam rhoncus, maecenas tempus tellus eget condimentum rhoncus.',
          ]}
        />
      </LegalSection>

      <LegalSection id="billing" title="Ut Labore Et Dolore">
        <DataRows
          variant="boxed"
          rows={[
            { term: 'LOREM', value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod.' },
            {
              term: 'IPSUM',
              value: 'Tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam.',
            },
            {
              term: 'DOLOR',
              value:
                'Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure.',
            },
            {
              term: 'AMET',
              value: 'Dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="data" title="Magna Aliqua Enim">
        <p>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit, incorporated into our{' '}
          <Link href="/privacy">Lorem Ipsum Policy</Link>, sed do eiusmod tempor
          incididunt ut labore.
        </p>
        <p>
          Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia
          deserunt mollit anim id est laborum. Curabitur pretium tincidunt lacus, ut
          interdum tellus elit sed risus.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="Ad Minim Veniam">
        <p>
          Nam eget dui. Etiam rhoncus, maecenas tempus tellus eget condimentum rhoncus,
          sem quam semper libero, sit amet adipiscing sem neque sed ipsum. Nam quam nunc,
          blandit vel, luctus pulvinar, hendrerit id, lorem.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Quis Nostrud Exercitation">
        <p>
          Maecenas nec odio et ante tincidunt tempus. Donec vitae sapien ut libero
          venenatis faucibus. Nullam quis ante etiam sit amet orci eget eros faucibus
          tincidunt. Duis leo, sed fringilla mauris sit amet nibh.
        </p>
      </LegalSection>

      <LegalSection id="termination" title="Ullamco Laboris Nisi">
        <p>
          Donec sodales sagittis magna. Sed consequat, leo eget bibendum sodales, augue
          velit cursus nunc, quis gravida magna mi a libero. Fusce vulputate eleifend
          sapien.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Aliquip Ex Ea">
        <p>Vestibulum purus quam, scelerisque ut, mollis sed, nonummy id, metus. Nullam accumsan lorem in dui.</p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>Lorem ipsum dolor sit amet?</p>
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
