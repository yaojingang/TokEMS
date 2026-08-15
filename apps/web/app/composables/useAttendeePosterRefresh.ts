import { nextTick, watch, type Ref, type WatchSource } from 'vue';

type AttendeePosterRefreshOptions = {
  loading: Ref<boolean>;
  profileVersion: WatchSource<number | null | undefined>;
  avatarUrl: Ref<string | null>;
  showcaseUrl: WatchSource<string>;
  hasProfile: () => boolean;
  render: () => Promise<void>;
};

export function useAttendeePosterRefresh(options: AttendeePosterRefreshOptions) {
  return watch(
    [options.loading, options.profileVersion, options.avatarUrl, options.showcaseUrl],
    async ([isLoading]) => {
      if (isLoading || !options.hasProfile()) return;
      await nextTick();
      await options.render();
    },
    { flush: 'post' },
  );
}
