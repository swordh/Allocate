/**
 * lib/invite-recipients.ts — parseRecipients.
 *
 * `parseRecipients` is a character scanner, not `String.split` — that's
 * what lets `"Garp, Olle" <o@x.se>` (a comma inside a quoted display name)
 * survive. Table-driven so the format zoo (Outlook paste, bare addresses,
 * mixed separators, nbsp, overflow) stays easy to extend.
 */

import { describe, it, expect } from 'vitest'
import { parseRecipients, MAX_RECIPIENTS } from '@/lib/invite-recipients'

describe('parseRecipients', () => {
  it.each<{ name: string; input: string; emails: string[] }>([
    {
      name: 'full Outlook-style string with display names',
      input: 'Nozhan Radnahad <nozhan.radnahad@otw.se>; Olle Garp <Olle.Garp@otw.se>',
      emails: ['nozhan.radnahad@otw.se', 'olle.garp@otw.se'],
    },
    {
      name: 'quoted display name containing a comma',
      input: '"Garp, Olle" <o@x.se>',
      emails: ['o@x.se'],
    },
    {
      name: 'bare angle-bracket address',
      input: '<a@x.se>',
      emails: ['a@x.se'],
    },
    {
      name: 'naked address with no display name',
      input: 'a@x.se',
      emails: ['a@x.se'],
    },
    {
      name: 'trailing and doubled separators',
      input: 'a@x.se,,;b@x.se;;',
      emails: ['a@x.se', 'b@x.se'],
    },
    {
      name: 'newline and CRLF separated',
      input: 'a@x.se\nb@x.se\r\nc@x.se',
      emails: ['a@x.se', 'b@x.se', 'c@x.se'],
    },
    {
      name: 'mailto: prefix',
      input: 'mailto:a@x.se',
      emails: ['a@x.se'],
    },
    {
      name: 'surrounded by nbsp',
      input: ' a@x.se ',
      emails: ['a@x.se'],
    },
  ])('$name', ({ input, emails }) => {
    expect(parseRecipients(input).emails).toEqual(emails)
  })

  it('deduplicates case-insensitively, first occurrence wins', () => {
    const result = parseRecipients('A@X.se, a@x.SE')
    expect(result.emails).toEqual(['a@x.se'])
    expect(result.duplicates).toEqual(['a@x.se'])
  })

  it('caps at MAX_RECIPIENTS and reports the rest as overflow', () => {
    const addresses = Array.from({ length: 30 }, (_, i) => `person${i}@example.com`)
    const result = parseRecipients(addresses.join(', '))

    expect(result.emails).toHaveLength(MAX_RECIPIENTS)
    expect(result.emails).toEqual(addresses.slice(0, MAX_RECIPIENTS))
    expect(result.overflow).toBe(5)
  })

  it('routes garbage fragments to invalid', () => {
    const result = parseRecipients('not-an-email, also not one')
    expect(result.emails).toEqual([])
    expect(result.invalid.length).toBeGreaterThan(0)
  })

  it('documented limitation: an unquoted comma in a display name splits the fragment', () => {
    // Outlook always quotes names containing a comma — this is the
    // acceptable failure mode for input that doesn't. The valid half must
    // still come through, and the invalid half must surface, not vanish.
    const result = parseRecipients('Garp, Olle <o@x.se>')
    expect(result.emails).toEqual(['o@x.se'])
    expect(result.invalid).toContain('Garp')
  })

  it('does not let invalid fragments consume accepted slots before the cap', () => {
    const input = ['garbage', ...Array.from({ length: 26 }, (_, i) => `p${i}@example.com`)].join(',')
    const result = parseRecipients(input)
    expect(result.emails).toHaveLength(MAX_RECIPIENTS)
    expect(result.overflow).toBe(1)
    expect(result.invalid).toEqual(['garbage'])
  })
})
