export const AUTHORIZATION_PROFILES = Object.freeze({
  read: ['tokems:read'],
  content: ['tokems:read', 'tokems:write'],
  full: ['tokems:read', 'tokems:pii', 'tokems:write', 'tokems:finance',
    'tokems:communications', 'tokems:export', 'tokems:security', 'tokems:dangerous'],
});

export function authorizationScope(profile, scope) {
  if (profile && scope) throw new Error('Choose --profile or --scope, not both');
  if (scope) return scope;
  const key = profile || 'content';
  const selected = Object.hasOwn(AUTHORIZATION_PROFILES, key) ? AUTHORIZATION_PROFILES[key] : undefined;
  if (!selected) throw new Error('Authorization profile must be read, content, or full');
  return selected.join(' ');
}
