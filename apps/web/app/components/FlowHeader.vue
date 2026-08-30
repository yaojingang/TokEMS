<script setup lang="ts">
import { useNuxtData } from '#app';
import type { PublicSiteConfiguration } from '@conference/contracts';

const api = useConferenceApi();
const { data: siteConfiguration } = useNuxtData<PublicSiteConfiguration>(
  'public-site-configuration',
);
const paymentSurface = computed(() => api.isPaymentSurface());

/**
 * Builds the header home destination.
 * On the payment surface this returns an absolute conference URL.
 *
 * @returns Home href for the brand link
 */
const homeHref = computed(() => {
  return api.resolveConferenceUrl('/');
});
</script>

<template>
  <header class="flow-header">
    <div class="flow-header__inner">
      <a class="flow-brand" :href="homeHref">
        <span class="flow-brand__mark">G</span>
        <span>{{ siteConfiguration?.website.siteName ?? '大会报名中心' }}</span>
      </a>
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
  .flow-header {
    height: calc(64px + env(safe-area-inset-top));
    box-sizing: border-box;
    padding-top: env(safe-area-inset-top);
  }
  .flow-header__meta {
    display: none;
  }
  .flow-header__inner {
    width: min(100% - 28px, 1160px);
    gap: 12px;
  }
  .flow-brand {
    min-width: 0;
    min-height: 44px;
    font-size: 14px;
  }
  .flow-brand > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flow-header__actions {
    flex: 0 0 auto;
  }
}
</style>
