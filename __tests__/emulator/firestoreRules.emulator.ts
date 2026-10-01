/**
 * First real coverage of firestore.rules. Nothing here changes the rules —
 * PR A is the emulator groundwork, not a rules PR — it only proves the
 * existing file behaves the way its own comments claim, using
 * @firebase/rules-unit-testing against the real rules engine instead of
 * trusting the prose. That matters for issue #252 steg 5: the purge that
 * lands in a later PR is the first genuinely destructive code in the repo,
 * and it must not ship without something that actually exercises the rules
 * a client could otherwise use to read (or worse, write) another company's
 * data.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'fs'
import path from 'path'
import { setDoc, getDoc, getDocs, collection, doc } from 'firebase/firestore'
import { EMULATOR_PROJECT_ID, FIRESTORE_EMULATOR_HOST } from './constants'

const [host, portStr] = FIRESTORE_EMULATOR_HOST.split(':')
const port = Number(portStr)

let testEnv: RulesTestEnvironment

const COMPANY_ID = 'company-1'
const OUTSIDER_COMPANY_ID = 'company-2'

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID,
    firestore: {
      rules: readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host,
      port,
    },
  })
})

afterEach(async () => {
  await testEnv.clearFirestore()
})

afterAll(async () => {
  await testEnv.cleanup()
})

describe('firestore.rules — companies/{companyId}', () => {
  it('a member can read their own company document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'companies', COMPANY_ID), { name: 'Acme' })
    })

    const member = testEnv.authenticatedContext('member-uid', {
      activeCompanyId: COMPANY_ID,
    })
    await assertSucceeds(getDoc(doc(member.firestore(), 'companies', COMPANY_ID)))
  })

  it('an outsider cannot read a company document', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'companies', COMPANY_ID), { name: 'Acme' })
    })

    // Authenticated, but their active company claim points elsewhere.
    const outsider = testEnv.authenticatedContext('outsider-uid', {
      activeCompanyId: OUTSIDER_COMPANY_ID,
    })
    await assertFails(getDoc(doc(outsider.firestore(), 'companies', COMPANY_ID)))

    const anonymous = testEnv.unauthenticatedContext()
    await assertFails(getDoc(doc(anonymous.firestore(), 'companies', COMPANY_ID)))
  })

  it('no client can write to a company document, member or not', async () => {
    const member = testEnv.authenticatedContext('member-uid', {
      activeCompanyId: COMPANY_ID,
    })
    await assertFails(setDoc(doc(member.firestore(), 'companies', COMPANY_ID), { name: 'x' }))
    await assertFails(
      setDoc(doc(member.firestore(), 'companies', COMPANY_ID), { name: 'y' }, { merge: true }),
    )
  })
})

describe('firestore.rules — invitations/{token}', () => {
  const TOKEN = 'unguessable-token-123'

  it('anyone can get a single invitation by its bearer token', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'invitations', TOKEN), { companyId: COMPANY_ID })
    })

    const anonymous = testEnv.unauthenticatedContext()
    await assertSucceeds(getDoc(doc(anonymous.firestore(), 'invitations', TOKEN)))
  })

  it('listing the invitations collection is denied — no enumeration', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'invitations', TOKEN), { companyId: COMPANY_ID })
    })

    const anonymous = testEnv.unauthenticatedContext()
    await assertFails(getDocs(collection(anonymous.firestore(), 'invitations')))
  })

  it('writing an invitation mirror is denied to clients', async () => {
    const anonymous = testEnv.unauthenticatedContext()
    await assertFails(
      setDoc(doc(anonymous.firestore(), 'invitations', TOKEN), { companyId: COMPANY_ID }),
    )
  })
})
