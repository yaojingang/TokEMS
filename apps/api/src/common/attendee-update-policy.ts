export interface MutableAttendee {
  name: string;
  mobile: string;
  email: string;
  company: string;
  title: string;
  city: string;
}

const ATTENDEE_FIELDS = ['name', 'mobile', 'email', 'company', 'title', 'city'] as const;

export function attendeeUpdateDiff(current: MutableAttendee, patch: Partial<MutableAttendee>) {
  const attendee = { ...current, ...patch };
  const changedFields = ATTENDEE_FIELDS.filter((field) => attendee[field] !== current[field]);
  return {
    attendee,
    changedFields,
    contactChanged: changedFields.includes('mobile') || changedFields.includes('email'),
  };
}
