import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useAttendeePosterRefresh } from './useAttendeePosterRefresh';

describe('attendee poster refresh', () => {
  it('waits for the saved profile canvas to mount before rendering the poster', async () => {
    const loading = ref(true);
    const profileVersion = ref<number | null>(null);
    const avatarUrl = ref<string | null>(null);
    const showcaseUrl = ref('/geo-conference-2026');
    const render = vi.fn(async () => undefined);
    let hasProfile = false;

    const stop = useAttendeePosterRefresh({
      loading,
      profileVersion,
      avatarUrl,
      showcaseUrl,
      hasProfile: () => hasProfile,
      render,
    });

    hasProfile = true;
    profileVersion.value = 3;
    await nextTick();
    expect(render).not.toHaveBeenCalled();

    loading.value = false;
    await nextTick();
    await nextTick();
    expect(render).toHaveBeenCalledTimes(1);

    stop();
  });
});
