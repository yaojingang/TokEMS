import { describe, expect, it } from 'vitest';
import {
  isMemberDirectoryInitialLoading,
  resolveMemberDirectoryState,
} from './member-directory-state';

describe('member directory display state', () => {
  it('keeps an enabled member block visible while no profiles have been published', () => {
    expect(resolveMemberDirectoryState(true, false, 0)).toEqual({
      visible: true,
      empty: true,
    });
  });

  it('shows loading and populated states without an empty message', () => {
    expect(resolveMemberDirectoryState(true, true, 0)).toEqual({
      visible: true,
      empty: false,
    });
    expect(resolveMemberDirectoryState(true, false, 12)).toEqual({
      visible: true,
      empty: false,
    });
  });

  it('keeps a disabled member block out of the page', () => {
    expect(resolveMemberDirectoryState(false, false, 0)).toEqual({
      visible: false,
      empty: false,
    });
  });

  it('only replaces the directory with a loader before the first snapshot arrives', () => {
    expect(isMemberDirectoryInitialLoading(true, false)).toBe(true);
    expect(isMemberDirectoryInitialLoading(true, true)).toBe(false);
    expect(isMemberDirectoryInitialLoading(false, false)).toBe(false);
  });
});
