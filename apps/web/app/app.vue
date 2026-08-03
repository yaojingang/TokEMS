<script setup lang="ts">
import { useAsyncData, useRuntimeConfig } from '#app';
import { useCustomerSession } from '~/composables/useCustomerSession';

const api = useConferenceApi();
const customer = useCustomerSession();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const publicEventHome = computed(() => route.meta.publicEventHome === true);
const { data: siteConfiguration, refresh: refreshSiteConfiguration } = await useAsyncData(
  'public-site-configuration',
  () => api.getSiteConfiguration(),
  { deep: false },
);

const analyticsAllowed = computed(
  () =>
    runtimeConfig.public.paymentSurface !== true &&
    !['/account', '/register', '/order', '/invoice', '/ticket', '/payment'].some(
      (prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`),
    ),
);

const analyticsScripts = computed(() => {
  const analytics = siteConfiguration.value?.analytics;
  if (!analyticsAllowed.value || !analytics?.enabled) return [];
  if (analytics.provider === 'baidu' && analytics.trackingId) {
    return [
      {
        key: 'analytics-baidu',
        src: `https://hm.baidu.com/hm.js?${encodeURIComponent(analytics.trackingId)}`,
        async: true,
      },
    ];
  }
  if (analytics.provider === 'google' && analytics.trackingId) {
    const id = JSON.stringify(analytics.trackingId);
    return [
      {
        key: 'analytics-google-loader',
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analytics.trackingId)}`,
        async: true,
      },
      {
        key: 'analytics-google-config',
        innerHTML: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${id});`,
      },
    ];
  }
  if (analytics.provider === 'umami' && analytics.scriptUrl) {
    return [
      {
        key: 'analytics-umami',
        src: analytics.scriptUrl,
        async: true,
        defer: true,
        ...(analytics.siteId ? { 'data-website-id': analytics.siteId } : {}),
      },
    ];
  }
  return [];
});

useHead(() => {
  const website = siteConfiguration.value?.website;
  return {
    titleTemplate: website?.seoTitle ? `%s · ${website.seoTitle}` : undefined,
    meta: website?.seoDescription ? [{ name: 'description', content: website.seoDescription }] : [],
    link: website?.faviconUrl ? [{ rel: 'icon', href: website.faviconUrl }] : [],
    script: analyticsScripts.value,
  };
});

const showSiteFooter = computed(() => {
  const website = siteConfiguration.value?.website;
  return Boolean(
    !publicEventHome.value &&
    website &&
    (website.footerText || website.icpNumber || website.supportEmail),
  );
});

function refreshPublicConfiguration() {
  if (document.visibilityState !== 'visible') return;
  void Promise.all([refreshSiteConfiguration(), api.getEvent(api.eventState.value.slug)]).catch(
    () => undefined,
  );
}

onMounted(() => {
  void customer.refresh().catch(() => undefined);
  document.addEventListener('visibilitychange', refreshPublicConfiguration);
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', refreshPublicConfiguration);
});
</script>

<template>
  <a class="skip-to-content" href="#main-content">跳到主要内容</a>
  <NuxtPage />
  <CustomerAuthDialog />
  <footer
    v-if="
      showSiteFooter ||
        siteConfiguration?.customerAccounts.termsUrl ||
        siteConfiguration?.customerAccounts.privacyUrl
    "
    class="global-site-footer"
  >
    <span v-if="siteConfiguration?.website.footerText">
      {{ siteConfiguration.website.footerText }}
    </span>
    <span v-if="siteConfiguration?.website.icpNumber">
      {{ siteConfiguration.website.icpNumber }}
    </span>
    <a
      v-if="siteConfiguration?.website.supportEmail"
      :href="`mailto:${siteConfiguration.website.supportEmail}`"
    >
      {{ siteConfiguration.website.supportEmail }}
    </a>
    <a
      v-if="siteConfiguration?.customerAccounts.termsUrl"
      :href="siteConfiguration.customerAccounts.termsUrl"
    >
      用户协议
    </a>
    <a
      v-if="siteConfiguration?.customerAccounts.privacyUrl"
      :href="siteConfiguration.customerAccounts.privacyUrl"
    >
      隐私政策
    </a>
  </footer>
</template>
