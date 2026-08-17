<script setup lang="ts">
import { useAsyncData, useRequestURL } from '#imports';
import {
  publicEventHomePath,
  publicEventScopedPath,
  speakerAvatarText,
} from '@conference/contracts';

const route = useRoute();
const requestUrl = useRequestURL();
const api = useConferenceApi();
const eventSlug = computed(() => String(route.query.event ?? ''));
const speakerId = computed(() => String(route.params.speakerId ?? ''));

const { data: speaker, error } = await useAsyncData(
  () => `event-speaker:${eventSlug.value}:${speakerId.value}`,
  () => api.getEventSpeaker(eventSlug.value, speakerId.value),
  { watch: [eventSlug, speakerId] },
);

const avatarInitial = computed(() =>
  speakerAvatarText(speaker.value?.name ?? '', speaker.value?.initials),
);
const eventDate = computed(() => {
  if (!speaker.value) return '';
  const startsAt = new Date(speaker.value.eventStartsAt);
  const endsAt = new Date(speaker.value.eventEndsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return '';
  const format = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: speaker.value.eventTimezone,
  });
  const startText = format.format(startsAt);
  const endText = format.format(endsAt);
  return startText === endText ? startText : `${startText} 至 ${endText}`;
});
const homePath = computed(() => {
  try {
    return publicEventHomePath(eventSlug.value);
  } catch {
    return '/';
  }
});
const registrationPath = computed(() => {
  try {
    return publicEventScopedPath('/register', eventSlug.value);
  } catch {
    return '/register';
  }
});
const canonicalUrl = computed(() => new URL(route.fullPath, requestUrl.origin).toString());
const socialImageUrl = computed(() =>
  speaker.value?.avatarUrl
    ? new URL(speaker.value.avatarUrl, requestUrl.origin).toString()
    : undefined,
);

useHead(() => {
  const title = speaker.value ? `${speaker.value.name} · ${speaker.value.eventName}` : '嘉宾详情';
  const description = speaker.value
    ? speaker.value.bio?.slice(0, 150) ||
      `${speaker.value.name}，${speaker.value.role}，分享“${speaker.value.topic}”。`
    : '大会嘉宾职业档案与演讲信息';
  return {
    title,
    link: [{ rel: 'canonical', href: canonicalUrl.value }],
    meta: [
      { name: 'description', content: description },
      { name: 'robots', content: 'index,follow' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:type', content: 'profile' },
      { property: 'og:url', content: canonicalUrl.value },
      ...(socialImageUrl.value ? [{ property: 'og:image', content: socialImageUrl.value }] : []),
    ],
  };
});
</script>

<template>
  <div class="speaker-page">
    <FlowHeader />
    <main id="main-content" class="speaker-shell">
      <template v-if="error">
        <section class="speaker-state">
          <p class="speaker-state-code">SPEAKER PROFILE</p>
          <h1>这位嘉宾的公开资料已失效</h1>
          <p>嘉宾可能已退出当前阵容，或大会尚未公开。</p>
          <NuxtLink :to="homePath">返回大会主页</NuxtLink>
        </section>
      </template>

      <template v-else-if="speaker">
        <NuxtLink class="speaker-back" :to="publicEventHomePath(speaker.eventSlug)">
          ← 返回大会主页
        </NuxtLink>

        <div class="speaker-profile-layout">
          <article class="speaker-profile">
            <header class="speaker-hero">
              <div class="speaker-portrait" :style="{ '--speaker-accent': speaker.accentFrom }">
                <img
                  v-if="speaker.avatarUrl"
                  :src="speaker.avatarUrl"
                  :alt="`${speaker.name}的头像`"
                  width="176"
                  height="176"
                />
                <span v-else aria-hidden="true">{{ avatarInitial }}</span>
              </div>
              <div class="speaker-intro">
                <div class="speaker-kicker"><span>SPEAKER</span><span>GUEST PROFILE</span></div>
                <h1>{{ speaker.name }}</h1>
                <p>{{ speaker.role }}</p>
                <div v-if="speaker.tags.length" class="speaker-tags">
                  <span v-for="tag in speaker.tags" :key="tag">{{ tag }}</span>
                </div>
              </div>
            </header>

            <section class="speaker-topic-section">
              <div class="speaker-section-heading">
                <span>TALK</span>
                <h2>大会分享</h2>
              </div>
              <div>
                <h2>{{ speaker.topic }}</h2>
                <p v-if="speaker.topicAbstract">{{ speaker.topicAbstract }}</p>
              </div>
            </section>

            <section v-if="speaker.bio" class="speaker-content-section">
              <div class="speaker-section-heading">
                <span>ABOUT</span>
                <h2>嘉宾简介</h2>
              </div>
              <p>{{ speaker.bio }}</p>
            </section>

            <section
              v-if="speaker.websiteUrl || speaker.socialLinks.length"
              class="speaker-content-section"
            >
              <div class="speaker-section-heading">
                <span>LINKS</span>
                <h2>公开链接</h2>
              </div>
              <div class="speaker-links">
                <a
                  v-if="speaker.websiteUrl"
                  :href="speaker.websiteUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>官方网站</span><strong>访问 ↗</strong>
                </a>
                <a
                  v-for="link in speaker.socialLinks"
                  :key="`${link.label}:${link.url}`"
                  :href="link.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>{{ link.label }}</span><strong>访问 ↗</strong>
                </a>
              </div>
            </section>
          </article>

          <aside class="speaker-event-card">
            <p>MEET AT THE EVENT</p>
            <h2>{{ speaker.eventName }}</h2>
            <dl class="speaker-event-facts">
              <div v-if="eventDate">
                <dt>时间</dt>
                <dd>{{ eventDate }}</dd>
              </div>
              <div>
                <dt>城市</dt>
                <dd>{{ speaker.eventCity }}</dd>
              </div>
            </dl>
            <span>在大会现场听见完整分享，与行业同行者继续交流。</span>
            <div class="speaker-event-actions">
              <NuxtLink class="primary" :to="registrationPath">立即报名</NuxtLink>
              <NuxtLink :to="publicEventHomePath(speaker.eventSlug)">查看大会详情</NuxtLink>
            </div>
          </aside>
        </div>
      </template>

      <p v-else class="speaker-loading">正在读取嘉宾资料…</p>
    </main>
  </div>
</template>

<style scoped>
.speaker-page {
  min-height: 100vh;
  background: #f4f6f9;
}

.speaker-shell {
  width: min(100% - 40px, 1080px);
  margin-inline: auto;
  padding: 28px 0 70px;
}

.speaker-back {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  margin-bottom: 10px;
  color: #657186;
  font-size: 13px;
}

.speaker-back:focus-visible,
.speaker-event-actions a:focus-visible,
.speaker-state a:focus-visible,
.speaker-links a:focus-visible {
  border-radius: 6px;
  outline: 3px solid rgb(31 95 232 / 18%);
  outline-offset: 2px;
}

.speaker-profile-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  align-items: start;
  gap: 16px;
}

.speaker-profile,
.speaker-event-card {
  background: #fff;
  border: 1px solid #dfe5ee;
  border-radius: 14px;
  box-shadow: 0 12px 34px rgb(28 45 74 / 6%);
}

.speaker-profile {
  overflow: hidden;
}

.speaker-event-facts {
  display: grid;
  gap: 11px;
  margin: 22px 0;
  padding: 17px 0;
  border-block: 1px solid #e3e8ef;
}

.speaker-event-facts div {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  gap: 8px;
}

.speaker-event-facts dt {
  color: #8a94a4;
  font-size: 12px;
}

.speaker-event-facts dd {
  margin: 0;
  color: #26354a;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.55;
}

.speaker-hero {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  align-items: center;
  gap: 36px;
  padding: 40px;
}

.speaker-portrait {
  display: grid;
  width: 176px;
  height: 176px;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: color-mix(in srgb, var(--speaker-accent, #1f5fe8) 12%, white);
  box-shadow: 0 0 0 7px #f4f7fc;
  color: var(--speaker-accent, #1f5fe8);
  font-size: 56px;
  font-weight: 760;
  outline: 1px solid rgb(18 35 61 / 10%);
  outline-offset: -1px;
}

.speaker-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.speaker-intro {
  min-width: 0;
}

.speaker-kicker {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #1f5fe8;
  font: 720 10px var(--conference-font-mono);
  letter-spacing: 0.09em;
}

.speaker-kicker span + span {
  padding-left: 9px;
  border-left: 1px solid #cbd5e5;
}

.speaker-intro h1 {
  margin: 12px 0 8px;
  color: #172033;
  font-size: clamp(40px, 5vw, 58px);
  line-height: 1.05;
  overflow-wrap: anywhere;
}

.speaker-intro > p {
  max-width: 42ch;
  margin: 0;
  color: #4e5a6d;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.65;
  text-wrap: pretty;
}

.speaker-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 16px;
}

.speaker-tags span {
  padding: 6px 10px;
  border-radius: 6px;
  background: #eef3fb;
  color: #43536c;
  font-size: 12px;
}

.speaker-topic-section,
.speaker-content-section {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 26px;
  padding: 30px 40px;
  border-top: 1px solid #e8edf4;
}

.speaker-topic-section {
  background: #f8faff;
}

.speaker-section-heading > span,
.speaker-event-card > p {
  color: #1f5fe8;
  font: 720 10px var(--conference-font-mono);
  letter-spacing: 0.09em;
}

.speaker-section-heading h2 {
  margin: 6px 0 0;
  color: #172033;
  font-size: 15px;
}

.speaker-topic-section > div:last-child h2 {
  margin: 0;
  color: #172033;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.35;
  text-wrap: balance;
}

.speaker-topic-section > div:last-child p,
.speaker-content-section > p {
  margin: 15px 0 0;
  color: #404c60;
  font-size: 15px;
  line-height: 1.85;
  white-space: pre-wrap;
  text-wrap: pretty;
}

.speaker-content-section > p {
  margin-top: 0;
}

.speaker-links {
  display: grid;
  gap: 0;
}

.speaker-links a {
  display: flex;
  min-height: 46px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 8px 0;
  border-bottom: 1px solid #edf0f5;
  color: #253149;
  text-decoration: none;
}

.speaker-links a:last-child {
  border-bottom: 0;
}

.speaker-links strong {
  color: #1f5fe8;
  font-size: 12px;
}

.speaker-event-card {
  position: sticky;
  top: 20px;
  padding: 24px;
}

.speaker-event-card > p {
  margin: 0;
}

.speaker-event-card h2 {
  margin: 9px 0 10px;
  color: #172033;
  font-size: 20px;
  line-height: 1.4;
  text-wrap: balance;
}

.speaker-event-card > span {
  display: block;
  color: #7a8597;
  font-size: 12px;
  line-height: 1.7;
}

.speaker-event-actions {
  display: grid;
  gap: 8px;
  margin-top: 24px;
}

.speaker-event-actions a,
.speaker-state a {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  border: 1px solid #d6deea;
  border-radius: 8px;
  color: #29364d;
  font-size: 13px;
  font-weight: 750;
  text-decoration: none;
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    transform 110ms ease;
}

.speaker-event-actions a.primary,
.speaker-state a {
  border-color: #1f5fe8;
  background: #1f5fe8;
  color: #fff;
}

.speaker-event-actions a:active,
.speaker-state a:active,
.speaker-links a:active {
  transform: scale(0.98);
}

.speaker-state {
  display: grid;
  justify-items: start;
  max-width: 700px;
  padding: 100px 0;
}

.speaker-state-code {
  margin: 0;
  color: #1f5fe8;
  font: 720 10px var(--conference-font-mono);
  letter-spacing: 0.1em;
}

.speaker-state h1 {
  margin: 14px 0 10px;
  color: #172033;
  font-size: clamp(34px, 6vw, 54px);
  line-height: 1.1;
}

.speaker-state > p:not(.speaker-state-code) {
  margin: 0 0 24px;
  color: #657186;
}

.speaker-state a {
  width: auto;
  padding-inline: 20px;
}

.speaker-loading {
  padding: 100px 0;
  color: #6d788a;
  text-align: center;
}

@media (hover: hover) {
  .speaker-back:hover,
  .speaker-links a:hover {
    color: #1f5fe8;
  }

  .speaker-event-actions a:hover {
    border-color: #b9c5d7;
    background: #f7f9fc;
  }

  .speaker-event-actions a.primary:hover,
  .speaker-state a:hover {
    border-color: #174fc7;
    background: #174fc7;
  }
}

@media (max-width: 820px) {
  .speaker-profile-layout {
    grid-template-columns: 1fr;
  }

  .speaker-event-card {
    position: static;
  }
}

@media (max-width: 600px) {
  .speaker-shell {
    width: min(100% - 24px, 680px);
    padding: 16px 0 44px;
  }

  .speaker-profile,
  .speaker-event-card {
    border-radius: 12px;
  }

  .speaker-hero {
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 20px;
    padding: 26px 20px;
  }

  .speaker-portrait {
    width: 96px;
    height: 96px;
    box-shadow: 0 0 0 4px #f4f7fc;
    font-size: 32px;
  }

  .speaker-kicker span:last-child {
    display: none;
  }

  .speaker-intro h1 {
    margin-top: 8px;
    font-size: 34px;
  }

  .speaker-intro > p {
    font-size: 14px;
  }

  .speaker-tags {
    margin-top: 11px;
  }

  .speaker-topic-section,
  .speaker-content-section {
    grid-template-columns: 1fr;
    gap: 15px;
    padding: 24px 20px 28px;
  }

  .speaker-topic-section > div:last-child h2 {
    font-size: 24px;
  }

  .speaker-topic-section > div:last-child p,
  .speaker-content-section > p {
    font-size: 14px;
    line-height: 1.8;
  }
}

@media (max-width: 360px) {
  .speaker-hero {
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 15px;
  }

  .speaker-portrait {
    width: 76px;
    height: 76px;
    font-size: 27px;
  }

  .speaker-intro h1 {
    font-size: 29px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .speaker-event-actions a,
  .speaker-state a {
    transition: none;
  }
}
</style>
