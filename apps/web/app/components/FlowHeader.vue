<script setup lang="ts">
import { useNuxtData } from '#app';
import { publicEventHomePath, type PublicSiteConfiguration } from '@conference/contracts';

const route = useRoute();
const api = useConferenceApi();
const { data: siteConfiguration } = useNuxtData<PublicSiteConfiguration>(
  'public-site-configuration',
);
const eventSlug = computed(() => String(route.query.event ?? ''));
const paymentSurface = computed(() => api.isPaymentSurface());

/**
 * Builds the header home destination.
 * On the payment surface this returns an absolute conference URL.
 *
 * @returns Home href for the brand link
 */
const homeHref = computed(() => {
  const path = eventSlug.value ? publicEventHomePath(eventSlug.value) : '/';
  return api.resolveConferenceUrl(path);
});
</script>

<template>
  <header class="flow-header">
    <div class="flow-header__inner">
      <a v-if="paymentSurface" class="flow-brand" :href="homeHref">
        <span class="flow-brand__mark">G</span>
        <span>{{ siteConfiguration?.website.siteName ?? '大会报名中心' }}</span>
      </a>
      <NuxtLink v-else class="flow-brand" :to="homeHref">
        <span class="flow-brand__mark">G</span>
        <span>{{ siteConfiguration?.website.siteName ?? '大会报名中心' }}</span>
      </NuxtLink>
      <div class="flow-header__actions">
        <span class="flow-header__meta">
          {{ paymentSurface ? '安全支付通道 · 信息加密传输' : '安全报名通道 · 信息加密传输' }}
        </span>
        <CustomerAccountAction v-if="!paymentSurface" />
      </div>
    </div>
  </header>
</template>

<style scoped>
.flow-header__actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
@media (max-width: 640px) {
  .flow-header__meta {
    display: none;
  }
  .flow-header__inner {
    width: min(100% - 28px, 1160px);
  }
}
</style>
