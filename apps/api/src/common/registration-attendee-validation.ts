import { HttpStatus } from '@nestjs/common';
import { API_ERROR_CODES, RegistrationFieldSchema } from '@conference/contracts';
import { registrationForms, registrations, type ConferenceDatabase } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DomainError } from './domain-error.js';

type RegistrationFormContext = Pick<
  typeof registrations.$inferSelect,
  'attendee' | 'eventId' | 'formVersion' | 'consentSnapshot'
>;

export async function registrationSnapshotFields(
  database: Pick<ConferenceDatabase, 'select'>,
  registration: RegistrationFormContext,
) {
  const snapshot = RegistrationFieldSchema.array().safeParse(
    registration.consentSnapshot.fieldDefinitions,
  );
  let fields = snapshot.success ? snapshot.data : undefined;
  if (!fields) {
    const [historicalForm] = await database
      .select({ fields: registrationForms.fields })
      .from(registrationForms)
      .where(
        and(
          eq(registrationForms.eventId, registration.eventId),
          eq(registrationForms.version, registration.formVersion),
        ),
      )
      .limit(1);
    fields = historicalForm?.fields;
  }
  // Registrations predating form snapshots required a name at creation.
  return fields ?? [{ key: 'name', label: '姓名', type: 'text' as const, required: true }];
}

export async function registrationEditableAttendeeFields(
  database: Pick<ConferenceDatabase, 'select'>,
  registration: RegistrationFormContext,
) {
  return (await registrationSnapshotFields(database, registration)).filter(
    (field) =>
      ['name', 'company', 'email', 'title', 'city'].includes(field.key) && field.enabled !== false,
  );
}

/** Apply the original form's constraints only to changed attendee fields. */
export async function validateRegistrationAttendeeFields(
  database: Pick<ConferenceDatabase, 'select'>,
  registration: RegistrationFormContext,
  patch: Partial<Record<'name' | 'company' | 'email' | 'title' | 'city', string | undefined>>,
) {
  const labels = { name: '姓名', company: '公司', email: '邮箱', title: '职位', city: '城市' };
  const changed = (Object.keys(labels) as (keyof typeof labels)[]).filter(
    (key) => patch[key] !== undefined && patch[key]!.trim() !== registration.attendee[key],
  );
  if (!changed.length) return;
  const fields = await registrationEditableAttendeeFields(database, registration);
  for (const key of changed) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const value = patch[key]!.trim();
    if (!value && field.required) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `该报名的${labels[key]}为必填项，请填写参会人${labels[key]}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (value && field.type === 'select' && !field.options?.includes(value)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `请从该报名的${labels[key]}选项中选择`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `请填写有效的${labels[key]}邮箱地址`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (value && field.type === 'tel' && (value.length < 7 || value.length > 32)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        `请填写有效的${labels[key]}电话号码`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}

export async function validateRegistrationAttendeeName(
  database: Pick<ConferenceDatabase, 'select'>,
  registration: RegistrationFormContext,
  nextName: string | undefined,
) {
  await validateRegistrationAttendeeFields(database, registration, { name: nextName });
}
