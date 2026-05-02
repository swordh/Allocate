'use server'

import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { TIME_SLOT_OPTIONS } from '@/constants/company'
import type { CompanyPreferences, CategoryFieldTemplate } from '@/types'

export async function updateCompanyName(_name: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }
  console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'update_company_name_stub' })
  return { error: 'Not implemented — Phase 6' }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function updatePreferences(prefs: CompanyPreferences): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  if (!(TIME_SLOT_OPTIONS as readonly number[]).includes(prefs.bookingTimeSlotMinutes)) {
    return { error: 'Invalid time slot value.' }
  }

  if (typeof prefs.timezone !== 'string' || !isValidTimezone(prefs.timezone)) {
    return { error: 'Invalid timezone.' }
  }

  try {
    await adminDb
      .collection('companies')
      .doc(session.activeCompanyId)
      .update({ preferences: prefs })

    revalidatePath('/settings/preferences')
    console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'preferences_updated' })
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/company]', { error: message, action: 'update_preferences_failed' })
    return { error: 'Failed to save preferences' }
  }
}

export async function updateCompanySettings(data: {
  name: string
  categoryTemplates: { categoryId: string; templates: CategoryFieldTemplate[] }[]
}): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  try {
    const batch = adminDb.batch()

    // ALLOWED from Server Actions: name, preferences.*, displayLogoUrl
    // FORBIDDEN from Server Actions: subscription.*, stripeCustomerId, hadTrial
    // Subscription fields are written ONLY by Cloud Functions/webhooks — never from here.

    // Update company name
    const companyRef = adminDb.collection('companies').doc(session.activeCompanyId)
    batch.update(companyRef, { name: data.name.trim() })

    // Update each category's customFieldTemplates
    for (const { categoryId, templates } of data.categoryTemplates) {
      const categoryRef = companyRef.collection('categories').doc(categoryId)
      batch.update(categoryRef, { customFieldTemplates: templates })
    }

    await batch.commit()

    revalidatePath('/settings/company')
    console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'company_settings_updated' })
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/company]', { error: message, action: 'update_company_settings_failed' })
    return { error: 'Failed to save settings' }
  }
}

export async function addCategory(name: string): Promise<{ error?: string; id?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  try {
    const ref = await adminDb
      .collection('companies')
      .doc(session.activeCompanyId)
      .collection('categories')
      .add({
        name: name.trim(),
        isDefault: false,
        createdAt: new Date(),
        customFieldTemplates: [],
      })

    revalidatePath('/settings/company')
    console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'category_added', id: ref.id })
    return { id: ref.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/company]', { error: message, action: 'add_category_failed' })
    return { error: 'Failed to add category' }
  }
}

export async function removeCategory(categoryId: string): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  try {
    await adminDb
      .collection('companies')
      .doc(session.activeCompanyId)
      .collection('categories')
      .doc(categoryId)
      .delete()

    revalidatePath('/settings/company')
    console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'category_removed', id: categoryId })
    return {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[actions/company]', { error: message, action: 'remove_category_failed' })
    return { error: 'Failed to remove category' }
  }
}
