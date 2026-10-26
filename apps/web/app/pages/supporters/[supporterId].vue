<script setup lang="ts">
import { publicEventScopedPath, type PublicEvent } from '@conference/contracts';
import { createError, definePageMeta, useAsyncData } from '#imports';
import { CONFERENCE_SUPPORTERS, SUPPORTERS_EVENT_SLUG } from '~/utils/conference-supporters';

definePageMeta({ key: (route) => route.fullPath });

const route = useRoute();
const eventSlug = route.query.event ?? SUPPORTERS_EVENT_SLUG;
const supporter = CONFERENCE_SUPPORTERS.find((item) => item.id === route.params.supporterId);
if (!supporter || eventSlug !== SUPPORTERS_EVENT_SLUG) {
  throw createError({ statusCode: 404, statusMessage: '支持单位资料不存在' });
}

const api = useConferenceApi();
const { data: event, error } = await useAsyncData<PublicEvent>(
  `supporter-event:${eventSlug}`,
  () => api.getEvent(eventSlug),
  { deep: false },
);
if (error.value || !event.value) {
  const failure = error.value as { statusCode?: number; status?: number } | null;
  throw createError({
    statusCode: failure?.statusCode ?? failure?.status ?? 503,
    statusMessage: '大会支持单位资料暂时不可用',
  });
}

const detailLogo = 'detailLogo' in supporter ? supporter.detailLogo : supporter.logo;
const cooperationPath = `${publicEventScopedPath('/apply/cooperation', eventSlug)}#supporters`;
const websiteLabel = supporter.website ? new URL(supporter.website).hostname : '';

useHead({
  title: `${supporter.name} · ${event.value.name}支持单位`,
  meta: [{ name: 'description', content: supporter.intro }],
});
</script>

<template>
  <div class="conference-page supporter-page">
    <EventPublicNav :event-slug="eventSlug" :event-name="event?.shortName" />
    <main id="main-content" class="supporter-shell" tabindex="-1">
      <NuxtLink class="supporter-back" :to="cooperationPath">
        <span aria-hidden="true">←</span> 返回合作页
      </NuxtLink>

      <header class="supporter-hero">
        <div class="supporter-hero__copy">
          <p class="flow-eyebrow">SUPPORTING ORGANIZATION</p>
          <p class="supporter-hero__category">{{ supporter.category }}</p>
          <h1>{{ supporter.name }}</h1>
          <p class="supporter-hero__summary">{{ supporter.summary }}</p>
        </div>
        <div class="supporter-brand" :class="`supporter-brand--${supporter.id}`">
          <img :src="detailLogo" :alt="`${supporter.name}标识`" width="220" :height="supporter.id === 'hiapi' ? 220 : 110" />
        </div>
      </header>

      <div class="supporter-layout">
        <article class="supporter-content" aria-label="支持单位详细介绍">
          <section class="supporter-section" aria-labelledby="supporter-about-title">
            <h2 id="supporter-about-title">关于{{ supporter.name }}</h2>
            <p>{{ supporter.intro }}</p>
            <p v-for="paragraph in supporter.overview" :key="paragraph">{{ paragraph }}</p>
          </section>

          <section class="supporter-section" aria-labelledby="supporter-highlights-title">
            <h2 id="supporter-highlights-title">
              核心亮点
            </h2>
            <ol class="supporter-highlights">
              <li v-for="(highlight, index) in supporter.highlights" :key="highlight.title">
                <span class="supporter-highlights__number" aria-hidden="true">{{
                  String(index + 1).padStart(2, '0')
                }}</span>
                <div>
                  <h3>{{ highlight.title }}</h3>
                  <p>{{ highlight.body }}</p>
                </div>
              </li>
            </ol>
          </section>

          <section class="supporter-section" aria-labelledby="supporter-focus-title">
            <h2 id="supporter-focus-title">{{ supporter.focusTitle }}</h2>
            <p v-for="paragraph in supporter.focus" :key="paragraph">{{ paragraph }}</p>
          </section>
        </article>

        <aside class="supporter-resource" aria-labelledby="supporter-resource-title">
          <div>
            <p class="flow-eyebrow">{{ supporter.website ? 'EXPLORE MORE' : 'BRAND PROFILE' }}</p>
            <h2 id="supporter-resource-title">
              {{ supporter.website ? '进一步了解' : '品牌资料' }}
            </h2>
            <template v-if="supporter.website">
              <p class="supporter-resource__lead">前往官方网站，了解更多产品与服务信息。</p>
              <a
                class="supporter-website"
                :href="supporter.website"
                target="_blank"
                rel="noopener noreferrer"
              >
                访问官网 <span aria-hidden="true">↗</span>
              </a>
              <span class="supporter-resource__domain">{{ websiteLabel }}</span>
            </template>
            <div class="supporter-resource__source">
              <span>资料来源</span>
              <a
                v-if="supporter.website"
                :href="supporter.website"
                target="_blank"
                rel="noopener noreferrer"
              >{{ supporter.source }} <span aria-hidden="true">↗</span></a>
              <p v-else>{{ supporter.source }}</p>
            </div>
          </div>
        </aside>
      </div>

      <footer class="supporter-footer">
        <p>感谢支持，让每一次连接都有新的可能。</p>
        <NuxtLink :to="cooperationPath">
          查看全部支持单位 <span aria-hidden="true">→</span>
        </NuxtLink>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.supporter-page {
  background: var(--bg);
  color: var(--ink);
}
.supporter-shell {
  width: 100%;
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 40px var(--pad) 80px;
}
.supporter-back,
.supporter-footer a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  color: var(--accent);
  font-size: 13px;
  transition: transform 120ms ease;
}
.supporter-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  align-items: center;
  gap: 48px;
  padding: 36px 0 40px;
  border-bottom: 1px solid var(--line);
}
.supporter-hero__category {
  margin: 24px 0 8px;
  color: var(--ink-soft);
  font-size: 12px;
}
.supporter-hero h1 {
  margin: 0;
  font-size: clamp(30px, 3.6vw, 44px);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.022em;
}
.supporter-hero__summary {
  max-width: 700px;
  margin: 20px 0 0;
  color: var(--ink-soft);
  font-size: 16px;
  line-height: 1.9;
}
.supporter-brand {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  min-height: 120px;
}
.supporter-brand img {
  width: auto;
  max-width: 100%;
  height: auto;
  max-height: 110px;
  object-fit: contain;
}
.supporter-brand--hiapi img {
  width: 220px;
  max-height: 220px;
}
.supporter-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 64px;
  padding-top: 44px;
}
.supporter-section {
  padding: 0 0 36px;
}
.supporter-section + .supporter-section {
  padding-top: 32px;
  border-top: 1px solid var(--line);
}
.supporter-section h2 {
  margin: 0 0 20px;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.5;
  letter-spacing: -0.012em;
}
.supporter-section p {
  margin: 0;
  color: var(--ink-soft);
  font-size: 15px;
  line-height: 1.95;
}
.supporter-section p + p {
  margin-top: 16px;
}
.supporter-highlights {
  margin: 0;
  padding: 0;
  list-style: none;
}
.supporter-highlights li {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 16px;
  padding: 16px 0;
}
.supporter-highlights li:first-child {
  padding-top: 0;
}
.supporter-highlights li:last-child {
  padding-bottom: 0;
}
.supporter-highlights__number {
  padding-top: 4px;
  color: var(--accent);
  font: 12px/1.5 var(--conference-font-mono);
}
.supporter-highlights h3 {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.5;
}
.supporter-resource {
  min-width: 0;
}
.supporter-resource > div {
  position: sticky;
  top: 104px;
  padding: 24px;
  border-radius: var(--radius);
  background: var(--accent-light);
}
.supporter-resource .flow-eyebrow {
  font-size: 10px;
}
.supporter-resource h2 {
  margin: 12px 0 0;
  font-size: 20px;
  font-weight: 700;
}
.supporter-resource__lead {
  margin: 12px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
}
.supporter-website {
  display: flex;
  min-height: 44px;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding: 0 16px;
  border-radius: 5px;
  background: var(--accent-dark);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  transition:
    transform 120ms ease,
    background-color 120ms ease;
}
.supporter-resource__domain {
  display: block;
  margin-top: 10px;
  color: var(--ink-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.supporter-resource__source {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid #dbeafe;
  font-size: 12px;
  line-height: 1.8;
}
.supporter-resource__source > span {
  color: var(--ink-muted);
  font-size: 11px;
}
.supporter-resource__source a {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 4px;
  color: var(--accent-dark);
  transition: transform 120ms ease;
}
.supporter-resource__source p {
  margin: 8px 0 0;
  color: var(--ink-soft);
}
.supporter-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}
.supporter-footer p {
  color: var(--ink-muted);
  font-size: 12px;
}
.supporter-back:focus-visible,
.supporter-website:focus-visible,
.supporter-resource__source a:focus-visible,
.supporter-footer a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 5px;
}
.supporter-back:active,
.supporter-website:active,
.supporter-resource__source a:active,
.supporter-footer a:active {
  transform: scale(0.98);
}
@media (hover: hover) {
  .supporter-website:hover {
    background: #1e40af;
  }
  .supporter-back:hover,
  .supporter-resource__source a:hover,
  .supporter-footer a:hover {
    text-decoration: underline;
    text-underline-offset: 4px;
  }
}
@media (max-width: 1000px) {
  .supporter-hero {
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 32px;
  }
  .supporter-layout {
    grid-template-columns: minmax(0, 1fr) 230px;
    gap: 32px;
  }
}
@media (max-width: 760px) {
  .supporter-shell {
    padding: 24px 20px 56px;
  }
  .supporter-hero {
    grid-template-columns: 1fr;
    gap: 24px;
    padding: 24px 0 28px;
  }
  .supporter-hero__copy {
    order: 2;
  }
  .supporter-hero__category {
    margin-top: 20px;
  }
  .supporter-hero h1 {
    font-size: 30px;
  }
  .supporter-hero__summary {
    margin-top: 16px;
    font-size: 15px;
  }
  .supporter-brand {
    min-height: 72px;
    justify-content: start;
  }
  .supporter-brand img {
    max-width: 210px;
    max-height: 80px;
  }
  .supporter-brand--hiapi img {
    width: 160px;
    max-height: 160px;
  }
  .supporter-layout {
    grid-template-columns: 1fr;
    gap: 28px;
    padding-top: 28px;
  }
  .supporter-resource {
    grid-row: 1;
  }
  .supporter-resource > div {
    position: static;
    padding: 22px;
  }
  .supporter-section {
    padding-bottom: 28px;
  }
  .supporter-section + .supporter-section {
    padding-top: 28px;
  }
  .supporter-section h2 {
    font-size: 21px;
  }
  .supporter-highlights li {
    gap: 12px;
  }
  .supporter-footer {
    flex-direction: column;
    align-items: start;
    gap: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .supporter-back,
  .supporter-website,
  .supporter-resource__source a,
  .supporter-footer a {
    transition: none;
  }
}
</style>
