'use server'

import { revalidatePath } from 'next/cache'
import { adminDb } from '@/lib/firebase-admin'
import { getVerifiedSession } from '@/lib/dal'
import { TIME_SLOT_OPTIONS } from '@/constants/company'
import type { CompanyPreferences, CategoryFieldTemplate } from '@/types'

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function updatePreferences(prefs: Partial<CompanyPreferences>): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  const updates: Record<string, unknown> = {}

  if (prefs.bookingTimeSlotMinutes !== undefined) {
    if (!(TIME_SLOT_OPTIONS as readonly number[]).includes(prefs.bookingTimeSlotMinutes)) {
      return { error: 'Invalid time slot value.' }
    }
    updates['preferences.bookingTimeSlotMinutes'] = prefs.bookingTimeSlotMinutes
  }

  if (prefs.timezone !== undefined) {
    if (typeof prefs.timezone !== 'string' || !isValidTimezone(prefs.timezone)) {
      return { error: 'Invalid timezone.' }
    }
    updates['preferences.timezone'] = prefs.timezone
  }

  if (prefs.autoCheckout !== undefined) {
    updates['preferences.autoCheckout'] = prefs.autoCheckout
  }

  if (prefs.autoCheckin !== undefined) {
    updates['preferences.autoCheckin'] = prefs.autoCheckin
  }

  if (Object.keys(updates).length === 0) {
    return {}
  }

  try {
    // Dot-path merge — only the supplied keys are written, so a partial save
    // from one settings screen can never clobber fields owned by another.
    await adminDb
      .collection('companies')
      .doc(session.activeCompanyId)
      .update(updates)

    revalidatePath('/settings/preferences')
    console.log('[actions/company]', { uid: session.uid.slice(0, 8) + '...', action: 'preferences_updated', keys: Object.keys(updates) })
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
  timezone?: string
}): Promise<{ error?: string }> {
  const session = await getVerifiedSession()
  if (session.role !== 'admin') return { error: 'Unauthorized' }

  if (data.timezone !== undefined && !isValidTimezone(data.timezone)) {
    return { error: 'Invalid timezone.' }
  }

  try {
    const batch = adminDb.batch()

    // ALLOWED from Server Actions: name, preferences.*, displayLogoUrl
    // FORBIDDEN from Server Actions: subscription.*, stripeCustomerId, hadTrial
    // Subscription fields are written ONLY by Cloud Functions/webhooks — never from here.

    // Update company name (+ timezone via dot-path merge, so this never
    // touches preferences.bookingTimeSlotMinutes/autoCheckout/autoCheckin —
    // those are owned by the Preferences screen).
    const companyRef = adminDb.collection('companies').doc(session.activeCompanyId)
    const companyUpdate: Record<string, unknown> = { name: data.name.trim() }
    if (data.timezone !== undefined) {
      companyUpdate['preferences.timezone'] = data.timezone
    }
    batch.update(companyRef, companyUpdate)

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
