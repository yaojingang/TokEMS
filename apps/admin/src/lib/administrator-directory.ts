import type { OrganizationInvitation, OrganizationMember } from '@conference/contracts';

export function administratorDirectoryMembers(members: OrganizationMember[]) {
  return members.filter(
    (member) => member.role === 'organization_admin' && member.grants.includes('*'),
  );
}

export function administratorDirectoryInvitations(invitations: OrganizationInvitation[]) {
  return invitations.filter(
    (invitation) => invitation.role === 'organization_admin' && invitation.grants.includes('*'),
  );
}
