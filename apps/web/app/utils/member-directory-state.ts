export type MemberDirectoryState = {
  visible: boolean;
  empty: boolean;
};

export function isMemberDirectoryInitialLoading(pending: boolean, hasSnapshot: boolean) {
  return pending && !hasSnapshot;
}

export function resolveMemberDirectoryState(
  blockEnabled: boolean,
  pending: boolean,
  total: number,
): MemberDirectoryState {
  return {
    visible: blockEnabled,
    empty: blockEnabled && !pending && total === 0,
  };
}
