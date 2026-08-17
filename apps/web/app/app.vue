<script setup lang="ts">
import { useAsyncData, useRuntimeConfig } from '#app';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  analyticsNavigationContext,
  isPublicAnalyticsPath,
  localAnalyticsBoundaryTarget,
  publicAnalyticsHeadEntries,
  requiresAnalyticsDocumentBoundary,
  sendAnalyticsPageView,
  shouldSendAnalyticsPageView,
  type AnalyticsNavigationContext,
} from '~/utils/public-analytics';

const api = useConferenceApi();
const customer = useCustomerSession();
const route = useRoute();
const router = useRouter();
const runtimeConfig = useRuntimeConfig();
const publicEventHome = computed(() => route.meta.publicEventHome === true);
const { data: siteConfiguration, refresh: refreshSiteConfiguration } = await useAsyncData(
  'public-site-configuration',
  () => api.getSiteConfiguration(),
  { deep: false },
);

useHead(() => {
  const website = siteConfiguration.value?.website;
  const analytics = siteConfiguration.value?.analytics;
  const analyticsAllowed = isPublicAnalyticsPath(
    route.path,
    Boolean(runtimeConfig.public.paymentSurface),
  );
  return {
    titleTemplate: website?.seoTitle ? `%s · ${website.seoTitle}` : undefined,
    meta: website?.seoDescription ? [{ name: 'description', content: website.seoDescription }] : [],
    link: website?.faviconUrl ? [{ rel: 'icon', href: website.faviconUrl }] : [],
    script: analyticsAllowed ? publicAnalyticsHeadEntries(analytics) : [],
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

let stopAnalyticsNavigation: (() => void) | undefined;
let removeAnalyticsBoundaryGuard: (() => void) | undefined;
let analyticsWasActiveInDocument = Boolean(
  analyticsNavigationContext(
    siteConfiguration.value?.analytics,
    route.fullPath,
    Boolean(runtimeConfig.public.paymentSurface),
  ).identity,
);

onMounted(() => {
  void customer.refresh().catch(() => undefined);
  removeAnalyticsBoundaryGuard = router.beforeEach((to, from) => {
    if (
      !requiresAnalyticsDocumentBoundary(
        siteConfiguration.value?.analytics,
        from.fullPath,
        to.fullPath,
        {
          paymentSurface: Boolean(runtimeConfig.public.paymentSurface),
          analyticsWasActiveInDocument,
        },
      )
    ) {
      return true;
    }
    window.location.assign(localAnalyticsBoundaryTarget(to.fullPath));
    return false;
  });
  let previous: AnalyticsNavigationContext | null = null;
  stopAnalyticsNavigation = watch(
    () =>
      analyticsNavigationContext(
        siteConfiguration.value?.analytics,
        route.fullPath,
        Boolean(runtimeConfig.public.paymentSurface),
      ),
    (next) => {
      if (next.identity) analyticsWasActiveInDocument = true;
      if (shouldSendAnalyticsPageView(previous, next) && next.provider) {
        sendAnalyticsPageView(next.provider, next.path);
      }
      previous = next;
    },
    { immediate: true, flush: 'post' },
  );
  document.addEventListener('visibilitychange', refreshPublicConfiguration);
});

onBeforeUnmount(() => {
  removeAnalyticsBoundaryGuard?.();
  stopAnalyticsNavigation?.();
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
