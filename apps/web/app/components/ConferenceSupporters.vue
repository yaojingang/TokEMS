<script setup lang="ts">
import { publicEventScopedPath } from '@conference/contracts';
import { CONFERENCE_SUPPORTERS as supporters, SUPPORTERS_EVENT_SLUG } from '~/utils/conference-supporters';

withDefaults(defineProps<{ context?: 'page' | 'home' }>(), { context: 'page' });
</script>

<template>
  <section id="supporters" class="conference-supporters" :class="{ 'conference-supporters--home': context === 'home' }" aria-labelledby="supporters-title">
    <header class="conference-supporters__head">
      <div>
        <p class="flow-eyebrow">WITH SUPPORT FROM</p>
        <component :is="context === 'home' ? 'h2' : 'h1'" id="supporters-title" :class="{ 'sec-title': context === 'home' }">支持，让相聚发生</component>
      </div>
      <span class="conference-supporters__label">支持单位与公司</span>
    </header>
    <p class="conference-supporters__lead">
      感谢每一份专业与热忱，共同支持这场关于 AI 与增长的交流。
    </p>

    <ul class="conference-supporters__list">
      <li v-for="item in supporters" :key="item.id">
        <NuxtLink
          :id="`supporter-${item.id}`"
          class="supporter"
          :to="publicEventScopedPath(`/supporters/${item.id}`, SUPPORTERS_EVENT_SLUG)"
          :aria-label="`了解${item.name}`"
        >
          <span class="supporter__logo" :class="`supporter__logo--${item.id}`">
            <img :src="item.logo" alt="" width="180" height="80" decoding="async" />
            <span v-if="item.id === 'hiapi'" class="supporter__wordmark" aria-hidden="true">hiapi</span>
          </span>
          <span class="supporter__name">{{ item.name }}</span>
          <span class="supporter__category">{{ item.category }}</span>
          <span class="supporter__summary">{{ item.summary }}</span>
          <span class="supporter__action">
            了解更多
            <span aria-hidden="true">→</span>
          </span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.conference-supporters {
  scroll-margin-top: 148px;
  margin-bottom: 48px;
  padding: 0 0 32px;
  border-bottom: 1px solid var(--line);
}

.conference-supporters.conference-supporters--home {
  margin-bottom: 0;
  padding: clamp(36px, 5vw, 55px) 0;
  border-bottom: 0;
}

.conference-supporters--home .conference-supporters__head h2 {
  margin: 0;
}

.conference-supporters__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
}

.conference-supporters__head .flow-eyebrow {
  margin-bottom: 8px;
}
.conference-supporters__head h1 {
  margin: 0;
  font-size: clamp(28px, 2.8vw, 36px);
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.022em;
}
.conference-supporters__label,
.conference-supporters__lead {
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
}
.conference-supporters__label {
  flex: none;
}
.conference-supporters__lead {
  margin: 14px 0 0;
}
.conference-supporters__list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 32px;
  margin: 28px 0 0;
  padding: 0;
  list-style: none;
}
.conference-supporters__list > li {
  display: flex;
  min-width: 0;
}
.supporter {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  padding: 18px 0 0;
  border-top: 1px solid var(--line);
  color: var(--ink);
  text-align: left;
  touch-action: manipulation;
  transition: transform 120ms ease;
}
.supporter__logo {
  display: flex;
  min-width: 0;
  height: 88px;
  flex: none;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  line-height: 1;
}
.supporter__logo img {
  display: block;
  width: auto;
  max-width: 100%;
  height: 56px;
  object-fit: contain;
  object-position: left center;
}
.supporter__logo--aidso img {
  width: 100%;
  max-width: 260px;
  height: 36px;
}
.supporter__logo--27geo img {
  max-width: min(100%, 232px);
}
.supporter__logo--hiapi img {
  width: 64px;
  height: 64px;
  flex: none;
}
.supporter__wordmark {
  font-size: 44px;
  font-weight: 750;
  line-height: 1;
  letter-spacing: -2px;
}
.supporter__logo--liekan img {
  max-width: min(100%, 198px);
}
.supporter__logo--zhiyuan-geo img {
  height: 68px;
}
.supporter__logo--up-to-her img {
  height: 88px;
}
.supporter__name {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.5;
}
.supporter__category {
  margin-top: 4px;
  color: var(--ink-muted);
  font-size: 11px;
  line-height: 1.75;
}
.supporter__summary {
  margin: 14px 0 8px;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
}
.supporter__action {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 12px;
  margin-top: auto;
  color: var(--accent);
  font-size: 12px;
}
.supporter__action > span {
  font-size: 19px;
}

.supporter:active {
  transform: scale(0.98);
}
.supporter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 5px;
  border-radius: 2px;
}
@media (hover: hover) {
  .supporter:hover .supporter__name {
    color: var(--accent);
  }
}
@media (max-width: 1000px) {
  .conference-supporters__list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 24px 32px;
  }
}
@media (max-width: 760px) {
  .conference-supporters {
    margin-bottom: 32px;
    padding-bottom: 24px;
  }
  .conference-supporters__head {
    display: block;
  }
  .conference-supporters__label {
    display: block;
    margin-top: 10px;
    font-size: 12px;
  }
  .conference-supporters__list {
    gap: 20px;
    margin-top: 22px;
  }
  .supporter__logo {
    height: 76px;
    gap: 8px;
    margin-bottom: 10px;
  }
  .supporter__logo--hiapi img {
    width: clamp(36px, 11vw, 56px);
    height: clamp(36px, 11vw, 56px);
  }
  .supporter__wordmark {
    font-size: clamp(28px, 8vw, 36px);
    letter-spacing: -1.5px;
  }
  .supporter__logo--up-to-her img {
    height: 76px;
  }
  .supporter__logo--zhiyuan-geo img {
    height: 60px;
  }
  .supporter__name {
    font-size: 16px;
  }
  .supporter__summary {
    font-size: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .supporter {
    transition: none;
  }
}
</style>
