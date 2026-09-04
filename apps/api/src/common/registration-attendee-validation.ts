import { HttpStatus } from '@nestjs/common';
import { API_ERROR_CODES, RegistrationFieldSchema } from '@conference/contracts';
import { registrationForms, registrations, type ConferenceDatabase } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DomainError } from './domain-error.js';

/** Validate a cleared name against the registration's historical form, before writing edits. */
export async function validateRegistrationAttendeeName(
  database: Pick<ConferenceDatabase, 'select'>,
  registration: Pick<
    typeof registrations.$inferSelect,
    'attendee' | 'eventId' | 'formVersion' | 'consentSnapshot'
  >,
  nextName: string | undefined,
) {
  if (nextName === undefined || nextName.trim() || !registration.attendee.name.trim()) return;
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
  const required = fields
    ? fields.some((field) => field.key === 'name' && field.enabled !== false && field.required)
    : true;
  if (required) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '该报名的姓名为必填项，请填写参会人姓名',
      HttpStatus.BAD_REQUEST,
    );
  }
}
