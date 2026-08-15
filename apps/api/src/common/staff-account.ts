import { createHash } from 'node:crypto';
import { DEMO_IDS } from '@conference/contracts';

const STAFF_ACCOUNT_EMAIL_SUFFIX = '@staff.tokems.invalid';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function configuredSuperAdministratorId(value = process.env.ADMIN_USER_ID) {
  const userId = (value ?? DEMO_IDS.adminUser).trim().toLowerCase();
  if (!UUID_PATTERN.test(userId)) throw new Error('ADMIN_USER_ID must be a valid UUID');
  return userId;
}

export function normalizeStaffAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

export function staffAccountEmail(username: string) {
  return `${normalizeStaffAccountEmail(username)}${STAFF_ACCOUNT_EMAIL_SUFFIX}`;
}

export function staffAccountUsername(email: string) {
  const normalized = normalizeStaffAccountEmail(email);
  return normalized.endsWith(STAFF_ACCOUNT_EMAIL_SUFFIX)
    ? normalized.slice(0, -STAFF_ACCOUNT_EMAIL_SUFFIX.length)
    : null;
}

export function staffAccountPublicEmail(email: string) {
  return staffAccountUsername(email) ? null : email;
}

export function staffCredentialRevision(preferences: unknown) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return null;
  const security = (preferences as Record<string, unknown>).security;
  if (!security || typeof security !== 'object' || Array.isArray(security)) return null;
  const revision = (security as Record<string, unknown>).staffCredentialVersion;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

export function staffCredentialVersion(
  account: { email: string; passwordHash: string | null },
  revision: string | null = null,
) {
  return createHash('sha256')
    .update(account.email)
    .update('\0')
    .update(account.passwordHash ?? '')
    .update('\0')
    .update(revision ?? '')
    .digest('base64url');
}
