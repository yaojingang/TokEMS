<script setup lang="ts">
import { publicEventHomePath, publicEventScopedPath, resolveNavigationLinks } from '@conference/contracts';
import { useAsyncData, useRequestURL } from '#imports';
import { resolveEventExperience } from '~/composables/useEventExperience';

const props = withDefaults(
  defineProps<{
    eventSlug: string;
    eventName?: string;
  }>(),
  { eventName: '' },
);

const api = useConferenceApi();
const navigationOrigin = useRequestURL().origin;
const { data: navigationEvent } = await useAsyncData(
  () => `navigation-event:${props.eventSlug}`,
  () => props.eventSlug ? api.getEvent(props.eventSlug) : Promise.resolve(null),
  { watch: [() => props.eventSlug] },
);
const experience = computed(() => navigationEvent.value ? resolveEventExperience(navigationEvent.value) : null);
const links = computed(() => navigationEvent.value && experience.value
  ? resolveNavigationLinks(navigationEvent.value, experience.value.home, experience.value.faq.mode, { origin: navigationOrigin }) : []);
const brandCopy = (key: string, fallback: string) => {
  const value = experience.value?.home.blocks.find((block) => block.nodeKey === 'home.navigation')?.content[key];
  return typeof value === 'string' ? value : fallback;
};
const homePath = computed(() => {
  try {
    return publicEventHomePath(props.eventSlug);
  } catch {
    return '/';
  }
});
const registrationPath = computed(() => {
  try {
    return publicEventScopedPath('/register', props.eventSlug);
  } catch {
    return '/register';
  }
});
</script>

<template>
  <nav id="nav" class="event-public-nav scrolled" aria-label="大会主导航">
    <div class="nav-inner">
      <a :href="`${homePath}#hero`" class="logo" aria-label="返回大会首页">
        <span class="logo-mark">{{ brandCopy('logoMark', 'G') }}</span>
        <span class="event-public-nav__brand logo-name">{{ brandCopy('brandLabel', '大会') }}</span>
        <span v-if="eventName" class="logo-sub">{{ eventName }}</span>
      </a>
      <ConferenceNavigationLinks :links="links" />
      <div class="nav-cta">
        <a :href="registrationPath" class="btn btn-primary">立即报名</a>
        <CustomerAccountAction />
      </div>
    </div>
  </nav>
  <div class="event-public-nav__spacer" aria-hidden="true"></div>
</template>

<style scoped>
.event-public-nav {
  box-sizing: border-box;
}
.event-public-nav__brand {
  flex: 0 0 auto;
}
.event-public-nav .logo-sub {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-public-nav__spacer {
  height: 69px;
}
@media (max-width: 640px) {
  .event-public-nav__spacer {
    height: 64px;
  }
}
</style>
