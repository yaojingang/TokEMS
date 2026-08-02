<script setup lang="ts">
import { DEMO_EVENT } from '@conference/contracts';
import { resolveEventExperience } from '~/composables/useEventExperience';

const api = useConferenceApi();
const event = api.eventState;
const query = ref('');
const activeCategory = ref('全部');
const openKeys = ref<string[]>([]);
const faq = computed(() => resolveEventExperience(event.value).faq);
const enabledItems = computed(() => faq.value.items.filter((item) => item.enabled));
const categories = computed(() => [
  '全部',
  ...new Set(enabledItems.value.map((item) => item.category)),
]);
const filteredItems = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase('zh-CN');
  return enabledItems.value.filter((item) => {
    const categoryMatches =
      activeCategory.value === '全部' || item.category === activeCategory.value;
    const keywordMatches =
      !keyword ||
      `${item.question} ${item.answer} ${item.category}`
        .toLocaleLowerCase('zh-CN')
        .includes(keyword);
    return categoryMatches && keywordMatches;
  });
});
const homeHref = computed(() => `/?event=${encodeURIComponent(event.value.slug)}`);
const registrationHref = computed(() => `/register?event=${encodeURIComponent(event.value.slug)}`);
const contactHref = computed(() => {
  const value = faq.value.contactUrl.trim();
  return /^(https?:|mailto:|tel:)/i.test(value) ? value : '';
});

useHead(() => ({
  title: `${faq.value.title} · ${event.value.name}`,
  meta: [
    {
      name: 'description',
      content: faq.value.introduction || `${event.value.name}报名、支付与参会常见问题`,
    },
  ],
}));

onMounted(async () => {
  const eventSlug = new URL(window.location.href).searchParams.get('event') ?? DEMO_EVENT.slug;
  event.value = await api.getEvent(eventSlug);
  openKeys.value = enabledItems.value.slice(0, 1).map((item) => item.nodeKey);
});

function toggle(nodeKey: string) {
  openKeys.value = openKeys.value.includes(nodeKey)
    ? openKeys.value.filter((item) => item !== nodeKey)
    : [...openKeys.value, nodeKey];
}
</script>

<template>
  <div class="flow-page faq-page">
    <FlowHeader />
    <main id="main-content" class="faq-page__shell">
      <header class="faq-page__head">
        <NuxtLink class="faq-page__back" :to="homeHref">← 返回大会首页</NuxtLink>
        <p class="flow-eyebrow">HELP CENTER</p>
        <h1>{{ faq.title }}</h1>
        <p>{{ faq.introduction || '关于报名、支付、发票与参会安排的常见说明。' }}</p>
        <label v-if="faq.searchEnabled" class="faq-search">
          <span aria-hidden="true">⌕</span>
          <input
            v-model="query"
            type="search"
            placeholder="搜索问题或关键词"
            aria-label="搜索常见问题"
          />
        </label>
      </header>

      <div class="faq-page__layout">
        <aside class="faq-categories" aria-label="FAQ 分类">
          <button
            v-for="category in categories"
            :key="category"
            type="button"
            :class="{ 'is-active': activeCategory === category }"
            @click="activeCategory = category"
          >
            {{ category }}
            <span>{{
              category === '全部'
                ? enabledItems.length
                : enabledItems.filter((item) => item.category === category).length
            }}</span>
          </button>
        </aside>

        <section class="faq-page__content" aria-live="polite">
          <article
            v-for="item in filteredItems"
            :id="item.nodeKey"
            :key="item.nodeKey"
            class="faq-page__item"
            :class="{ 'is-open': openKeys.includes(item.nodeKey) }"
          >
            <button
              type="button"
              :aria-expanded="openKeys.includes(item.nodeKey)"
              :aria-controls="`${item.nodeKey}-answer`"
              @click="toggle(item.nodeKey)"
            >
              <span>
                <small>{{ item.category }}</small>
                {{ item.question }}
              </span>
              <b aria-hidden="true">{{ openKeys.includes(item.nodeKey) ? '−' : '+' }}</b>
            </button>
            <div
              v-show="openKeys.includes(item.nodeKey)"
              :id="`${item.nodeKey}-answer`"
              class="faq-page__answer"
            >
              <p>{{ item.answer }}</p>
            </div>
          </article>
          <div v-if="!filteredItems.length" class="faq-page__empty">
            <strong>没有找到相关问题</strong>
            <p>尝试缩短关键词，或切换到“全部”分类。</p>
          </div>
        </section>
      </div>

      <section class="faq-contact">
        <div>
          <small>NEED MORE HELP?</small>
          <h2>还有其他问题？</h2>
          <p>大会运营团队会协助处理报名、订单、发票与参会安排。</p>
        </div>
        <a v-if="contactHref" class="flow-action" :href="contactHref">
          {{ faq.contactLabel }}
        </a>
        <NuxtLink v-else class="flow-action" :to="registrationHref">前往报名</NuxtLink>
      </section>
    </main>
  </div>
</template>
