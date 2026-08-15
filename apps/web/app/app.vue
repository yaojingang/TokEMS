<script setup lang="ts">
import { useAsyncData } from '#app';
import { useCustomerSession } from '~/composables/useCustomerSession';

const api = useConferenceApi();
const customer = useCustomerSession();
const route = useRoute();
const publicEventHome = computed(() => route.meta.publicEventHome === true);
const { data: siteConfiguration, refresh: refreshSiteConfiguration } = await useAsyncData(
  'public-site-configuration',
  () => api.getSiteConfiguration(),
  { deep: false },
);

useHead(() => {
  const website = siteConfiguration.value?.website;
  return {
    titleTemplate: website?.seoTitle ? `%s · ${website.seoTitle}` : undefined,
    meta: website?.seoDescription ? [{ name: 'description', content: website.seoDescription }] : [],
    link: website?.faviconUrl ? [{ rel: 'icon', href: website.faviconUrl }] : [],
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
