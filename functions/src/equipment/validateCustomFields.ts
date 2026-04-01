import { HttpsError } from 'firebase-functions/v2/https';

const MAX_CUSTOM_FIELDS = 20;
const MAX_LABEL_LENGTH = 100;
const VALID_TYPES = ['text', 'number', 'range'] as const;
type FieldType = typeof VALID_TYPES[number];

interface CustomFieldText { id: string; label: string; type: 'text'; value: string }
interface CustomFieldNumber { id: string; label: string; type: 'number'; value: number }
interface CustomFieldRange { id: string; label: string; type: 'range'; value: { min: number; max: number | null } }
type CustomField = CustomFieldText | CustomFieldNumber | CustomFieldRange;

export function validateCustomFields(raw: unknown): CustomField[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HttpsError('invalid-argument', 'customFields must be an array.');
  }
  if (raw.length > MAX_CUSTOM_FIELDS) {
    throw new HttpsError('invalid-argument', `Maximum ${MAX_CUSTOM_FIELDS} custom fields allowed.`);
  }

  return raw.map((field, i): CustomField => {
    if (typeof field !== 'object' || field === null) {
      throw new HttpsError('invalid-argument', `customFields[${i}] must be an object.`);
    }
    const { id, label, type, value } = field as Record<string, unknown>;

    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HttpsError('invalid-argument', `customFields[${i}].id must be a non-empty string.`);
    }
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new HttpsError('invalid-argument', `customFields[${i}].label is required.`);
    }
    if (label.trim().length > MAX_LABEL_LENGTH) {
      throw new HttpsError('invalid-argument', `customFields[${i}].label must be ${MAX_LABEL_LENGTH} characters or fewer.`);
    }
    if (!VALID_TYPES.includes(type as FieldType)) {
      throw new HttpsError('invalid-argument', `customFields[${i}].type must be one of: ${VALID_TYPES.join(', ')}.`);
    }

    if (type === 'text') {
      if (typeof value !== 'string') {
        throw new HttpsError('invalid-argument', `customFields[${i}].value must be a string for type "text".`);
      }
      return { id: id.trim(), label: label.trim(), type: 'text', value };
    }

    if (type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) {
        throw new HttpsError('invalid-argument', `customFields[${i}].value must be a finite number for type "number".`);
      }
      return { id: id.trim(), label: label.trim(), type: 'number', value };
    }

    // range
    if (typeof value !== 'object' || value === null) {
      throw new HttpsError('invalid-argument', `customFields[${i}].value must be an object {min, max} for type "range".`);
    }
    const { min, max } = value as Record<string, unknown>;
    if (typeof min !== 'number' || !isFinite(min)) {
      throw new HttpsError('invalid-argument', `customFields[${i}].value.min must be a finite number.`);
    }
    if (max !== null && (typeof max !== 'number' || !isFinite(max))) {
      throw new HttpsError('invalid-argument', `customFields[${i}].value.max must be a finite number or null.`);
    }
    return { id: id.trim(), label: label.trim(), type: 'range', value: { min, max: max ?? null } };
  });
}
