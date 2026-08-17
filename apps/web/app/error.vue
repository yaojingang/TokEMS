<script setup lang="ts">
import { useAsyncData, useRuntimeConfig } from '#app';
import { onMounted } from 'vue';
import {
  analyticsNavigationContext,
  isPublicAnalyticsErrorPath,
  publicAnalyticsHeadEntries,
  sendAnalyticsPageView,
  shouldSendAnalyticsPageView,
} from '~/utils/public-analytics';

defineProps<{ error: { statusCode?: number; message?: string } }>();

const api = useConferenceApi();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const { data: siteConfiguration } = await useAsyncData('public-site-configuration', () =>
  api.getSiteConfiguration(),
);

useHead(() => {
  const analytics = siteConfiguration.value?.analytics;
  const analyticsAllowed = isPublicAnalyticsErrorPath(
    route.path,
    Boolean(runtimeConfig.public.paymentSurface),
  );
  return {
    script: analyticsAllowed ? publicAnalyticsHeadEntries(analytics) : [],
  };
});

onMounted(() => {
  const context = analyticsNavigationContext(
    siteConfiguration.value?.analytics,
    route.fullPath,
    Boolean(runtimeConfig.public.paymentSurface),
    true,
  );
  if (shouldSendAnalyticsPageView(null, context) && context.provider) {
    sendAnalyticsPageView(context.provider, context.path);
  }
});
</script>

<template>
  <main class="error-page" id="main-content">
    <NuxtLink class="brand-inline" to="/">GEO大会 · 2026</NuxtLink>
    <p class="eyebrow">PAGE NOT FOUND</p>
    <h1>这条路线暂时没有安排</h1>
    <p>页面可能已移动，返回大会首页可以继续查看议程、嘉宾和门票。</p>
    <NuxtLink class="action-button" to="/">返回大会首页</NuxtLink>
  </main>
</template>
