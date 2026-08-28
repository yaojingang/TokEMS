import tailwindcss from '@tailwindcss/vite';

export default defineNuxtConfig({
  compatibilityDate: '2026-07-17',
  devtools: { enabled: false },
  css: ['@conference/ui/tokens.css', '~/assets/css/main.css', '~/assets/css/conference.css'],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['qrcode.vue'],
    },
    ssr: {
      external: ['zod'],
    },
  },
  nitro: {
    externals: {
      external: ['zod'],
    },
  },
  runtimeConfig: {
    apiInternalBase: process.env.NUXT_API_INTERNAL_BASE ?? 'http://localhost:4100/api/v1',
    public: {
      apiBase:
        process.env.NUXT_PUBLIC_API_BASE ??
        (process.env.NODE_ENV === 'production' ? '/api/v1' : 'http://localhost:4100/api/v1'),
      organizationSlug: process.env.NUXT_PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference',
      paymentOrigin: process.env.NUXT_PUBLIC_PAYMENT_ORIGIN ?? '',
      paymentBasePath: process.env.NUXT_PUBLIC_PAYMENT_BASE_PATH ?? '/pay/hui',
      conferenceOrigin: process.env.NUXT_PUBLIC_CONFERENCE_ORIGIN ?? '',
      paymentSurface: process.env.NUXT_PUBLIC_PAYMENT_SURFACE === 'true',
    },
  },
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'TokEMS 大会报名中心',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: 'TokEMS 大会报名中心，集中提供大会信息、报名、票务与参会服务。',
        },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Noto+Sans+SC:wght@300;400;500;700&display=swap',
        },
      ],
    },
  },
  routeRules: {
    '/register': { ssr: true },
    '/order/**': {
      ssr: false,
      headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    },
    '/invoice/**': { ssr: false },
    '/ticket/**': { ssr: false },
    '/account/**': { ssr: false },
    '/members/**': { headers: { 'cache-control': 'no-cache, must-revalidate' } },
    '/speakers/**': { headers: { 'cache-control': 'no-cache, must-revalidate' } },
    '/s/**': { headers: { 'cache-control': 'no-cache, must-revalidate' } },
  },
});
