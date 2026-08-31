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
      lede="Lorem ipsum dolor sit amet, consectetur adipiscing elit. This placeholder text stands in for the real policy while the page is being tested."
      sections={SECTIONS}
    >
      <LegalSection id="controller" title="Lorem Ipsum Dolor">
        <p>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. For any
          placeholder-related questions, contact{' '}
          <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>.
        </p>
      </LegalSection>

      <LegalSection id="collected" title="Consectetur Adipiscing">
        <DataRows
          variant="boxed"
          rows={[
            { term: 'LOREM', value: 'Ipsum dolor sit amet, consectetur adipiscing elit.' },
            { term: 'IPSUM', value: 'Sed do eiusmod tempor incididunt ut labore.' },
            {
              term: 'DOLOR',
              value: 'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.',
            },
            {
              term: 'AMET',
              value:
                'Duis aute irure dolor in reprehenderit — sed do eiusmod tempor incididunt ut labore et dolore magna.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="why" title="Sed Do Eiusmod">
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'LOREM IPSUM DOLOR SIT',
              value:
                'Consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
            },
            {
              term: 'UT ENIM AD MINIM VENIAM',
              value:
                'Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
            },
          ]}
        />
      </LegalSection>

      <LegalSection id="processors" title="Tempor Incididunt">
        <p>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor
          incididunt ut labore et dolore magna aliqua:
        </p>
        <LegalCards
          cards={[
            {
              title: 'Lorem Ipsum',
              description: 'Dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor.',
            },
            { title: 'Dolor Sit', description: 'Incididunt ut labore et dolore magna aliqua.' },
            { title: 'Amet Consectetur', description: 'Ut enim ad minim veniam quis nostrud.' },
          ]}
        />
        <p>Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.</p>
        <p>
          Nam eget dui. Etiam rhoncus, maecenas tempus tellus eget condimentum rhoncus,
          sem quam semper libero, sit amet adipiscing sem neque sed ipsum. Nam quam nunc,
          blandit vel, luctus pulvinar, hendrerit id, lorem.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="Labore Et Dolore">
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'LOREM',
              value: 'Ipsum dolor sit amet — retained until further placeholder notice.',
            },
            {
              term: 'IPSUM DOLOR',
              value:
                "Consectetur adipiscing elit, sed do eiusmod tempor incididunt. Cannot be traced back after deletion.",
            },
            {
              term: 'SIT AMET & CONSECTETUR',
              value: 'Retained for 7 lorem units in accordance with placeholder regulation.',
            },
            { term: 'ADIPISCING ELIT', value: 'Retained for 30 days, then automatically deleted.' },
          ]}
        />
      </LegalSection>

      <LegalSection id="rights" title="Magna Aliqua Enim">
        <p>Under lorem ipsum you have the right to:</p>
        <DataRows
          variant="boxed"
          rows={[
            {
              term: 'LOREM',
              value: (
                <>
                  Ipsum dolor sit amet — contact us at{' '}
                  <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a> and we will provide a
                  copy.
                </>
              ),
            },
            {
              term: 'IPSUM',
              value: 'Delete your placeholder directly from Settings. Deletion is immediate and permanent.',
            },
            { term: 'DOLOR', value: 'Update your name and email from your profile settings.' },
            {
              term: 'SIT AMET',
              value: (
                <>
                  Download your data directly from your{' '}
                  <Link href="/settings/account">Account Settings</Link>.
                </>
              ),
            },
            {
              term: 'CONSECTETUR',
              value: (
                <>
                  You may lodge a complaint with the placeholder supervisory authority,{' '}
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

      <LegalSection id="cookies" title="Quis Nostrud">
        <p>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
          incididunt ut labore et dolore magna aliqua.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Exercitation Ullamco">
        <p>
          Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu
          fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in
          culpa qui officia deserunt mollit anim id est laborum.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <LegalContact
          columns={[
            {
              label: 'EMAIL',
              value: <a href="mailto:jocke@joakimsvardh.se">jocke@joakimsvardh.se</a>,
            },
            { label: 'ENTITY', value: 'Lorem Ipsum Placeholder Entity, Sweden' },
          ]}
        />
      </LegalSection>
    </LegalLayout>
  )
}
