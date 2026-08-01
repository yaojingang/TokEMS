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
      organizationSlug: process.env.NUXT_PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo',
      eventSlug: process.env.NUXT_PUBLIC_EVENT_SLUG ?? 'tokems-demo-2026',
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'TokEMS Demo Conference 2026 · 深圳',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'TokEMS 示例大会，2026 年 11 月 21 至 22 日，深圳。展示大会官网、报名、票务、通知、发票和现场核销的完整流程。',
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
    '/order/**': { ssr: false },
    '/invoice/**': { ssr: false },
    '/ticket/**': { ssr: false },
    '/account/**': { ssr: false },
  },
});
