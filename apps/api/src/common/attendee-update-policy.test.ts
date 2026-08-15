import { describe, expect, it } from 'vitest';
import { attendeeUpdateDiff } from './attendee-update-policy.js';

const current = {
  name: '参会人',
  mobile: '+8613900000001',
  email: 'attendee@example.com',
  company: '公司',
  title: '负责人',
  city: '深圳',
};

describe('attendee update policy', () => {
  it('treats an identical patch as a no-op', () => {
    expect(attendeeUpdateDiff(current, { name: '参会人' })).toEqual({
      attendee: current,
      changedFields: [],
      contactChanged: false,
    });
  });

  it('rotates an invitation only when mobile or email changes', () => {
    expect(attendeeUpdateDiff(current, { company: '新公司' })).toMatchObject({
      changedFields: ['company'],
      contactChanged: false,
    });
    expect(attendeeUpdateDiff(current, { email: 'new@example.com' })).toMatchObject({
      changedFields: ['email'],
      contactChanged: true,
    });
  });
});
