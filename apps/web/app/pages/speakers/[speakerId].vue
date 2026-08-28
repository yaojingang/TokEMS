<script setup lang="ts">
import {
  definePageMeta,
  navigateTo,
  setResponseStatus,
  useAsyncData,
  useRequestURL,
} from '#imports';
import {
  publicEventHomePath,
  publicSpeakerPath,
  speakerAvatarText,
  SpeakerRouteCodeSchema,
} from '@conference/contracts';
import QRCode from 'qrcode.vue';

definePageMeta({ alias: ['/s/:speakerId'] });

const route = useRoute();
const requestUrl = useRequestURL();
const api = useConferenceApi();
const eventSlug = computed(() => String(route.query.event ?? ''));
const speakerId = computed(() => String(route.params.speakerId ?? ''));
const isLegacyShortRoute = computed(() => route.path.startsWith('/s/'));
const isPublicCodeRoute = computed(
  () => isLegacyShortRoute.value || SpeakerRouteCodeSchema.safeParse(speakerId.value).success,
);
const copied = ref(false);

const { data: speaker, error } = await useAsyncData(
  () =>
    isPublicCodeRoute.value
      ? `public-speaker:${speakerId.value}`
      : `event-speaker:${eventSlug.value}:${speakerId.value}`,
  () =>
    isPublicCodeRoute.value
      ? api.getSpeakerByCode(speakerId.value)
      : api.getEventSpeaker(eventSlug.value, speakerId.value),
  { watch: [eventSlug, speakerId, isPublicCodeRoute] },
);

if (speaker.value?.publicCode) {
  const canonicalPath = publicSpeakerPath(speaker.value.publicCode);
  if (route.path !== canonicalPath || Object.keys(route.query).length) {
    await navigateTo(canonicalPath, { redirectCode: 308 });
  }
}
if (import.meta.server && error.value) {
  setResponseStatus(404);
}

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
    return publicEventHomePath(speaker.value?.eventSlug ?? eventSlug.value);
  } catch {
    return '/';
  }
});
const canonicalUrl = computed(() =>
  new URL(
    speaker.value?.publicCode ? publicSpeakerPath(speaker.value.publicCode) : route.fullPath,
    requestUrl.origin,
  ).toString(),
);
const socialImageUrl = computed(() =>
  speaker.value?.avatarUrl
    ? new URL(speaker.value.avatarUrl, requestUrl.origin).toString()
    : undefined,
);

async function shareSpeaker() {
  if (!import.meta.client || !speaker.value) return;
  if (navigator.share) {
    await navigator.share({
      title: `${speaker.value.name}的嘉宾资料`,
      text: `${speaker.value.name}将在${speaker.value.eventName}分享“${speaker.value.topic}”。`,
      url: canonicalUrl.value,
    });
    return;
  }
  await navigator.clipboard.writeText(canonicalUrl.value);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1800);
}

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
      { name: 'robots', content: error.value ? 'noindex,follow' : 'index,follow' },
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

            <section v-if="speaker.bio" class="speaker-content-section">
              <div class="speaker-section-heading">
                <span>ABOUT</span>
                <h2>嘉宾简介</h2>
              </div>
              <p>{{ speaker.bio }}</p>
            </section>

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
                  <span>{{ link.label }}</span>
                  <strong>访问 ↗</strong>
                </a>
              </div>
            </section>
          </article>

          <aside class="speaker-event-card">
            <div class="speaker-event">
              <p>MEET AT THE EVENT</p>
              <h2>{{ speaker.eventName }}</h2>
              <span>{{ [eventDate, speaker.eventCity].filter(Boolean).join(' · ') }}</span>
            </div>
            <div class="speaker-qr" role="img" aria-label="嘉宾资料二维码">
              <QRCode :value="canonicalUrl" :size="160" level="M" render-as="svg" />
            </div>
            <div class="speaker-event-actions">
              <button type="button" @click="shareSpeaker">
                {{ copied ? '链接已复制' : '分享嘉宾资料' }}
              </button>
              <NuxtLink :to="publicEventHomePath(speaker.eventSlug)"> 查看大会详情与报名 </NuxtLink>
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
  width: min(100% - 40px, 1060px);
  margin-inline: auto;
  padding: 28px 0 64px;
}

.speaker-back {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  margin-bottom: 12px;
  color: #657186;
  font-size: 13px;
}

.speaker-back:focus-visible,
.speaker-event-actions a:focus-visible,
.speaker-event-actions button:focus-visible,
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

.speaker-hero {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  align-items: center;
  gap: 30px;
  padding: 34px 36px 32px;
}

.speaker-portrait {
  display: grid;
  width: 132px;
  height: 132px;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  background: color-mix(in srgb, var(--speaker-accent, #1f5fe8) 12%, white);
  box-shadow: 0 0 0 6px #f4f7fc;
  color: var(--speaker-accent, #1f5fe8);
  font-size: 42px;
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
  margin: 10px 0 7px;
  color: #172033;
  font-size: clamp(38px, 5vw, 50px);
  line-height: 1.08;
  letter-spacing: -0.04em;
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
  gap: 6px;
  margin-top: 14px;
}

.speaker-tags span {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  padding: 6px 10px;
  border-radius: 6px;
  background: #eef3fb;
  color: #43536c;
  font-size: 12px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.speaker-topic-section,
.speaker-content-section {
  display: grid;
  grid-template-columns: 158px minmax(0, 1fr);
  gap: 24px;
  padding: 26px 36px;
  border-top: 1px solid #e8edf4;
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
  font-size: 16px;
  line-height: 1.5;
}

.speaker-topic-section > div:last-child h2 {
  margin: 0;
  color: #172033;
  font-size: clamp(21px, 2.4vw, 27px);
  line-height: 1.45;
  text-wrap: balance;
}

.speaker-topic-section > div:last-child p,
.speaker-content-section > p {
  margin: 12px 0 0;
  color: #404c60;
  font-size: 15px;
  line-height: 1.8;
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
  padding: 22px;
}

.speaker-event {
  text-align: left;
}

.speaker-event > p {
  margin: 0;
  color: #1f5fe8;
  font: 720 10px var(--conference-font-mono);
  letter-spacing: 0.09em;
}

.speaker-event h2 {
  margin: 7px 0;
  color: #172033;
  font-size: 18px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.speaker-event > span {
  color: #7a8597;
  font-size: 12px;
  line-height: 1.6;
}

.speaker-qr {
  display: grid;
  width: 184px;
  height: 184px;
  place-items: center;
  margin: 18px auto;
  border: 1px solid #e3e8f0;
  background: #fff;
}

.speaker-qr :deep(svg) {
  width: 160px;
  height: 160px;
}

.speaker-event-actions {
  display: grid;
  gap: 8px;
}

.speaker-event-actions a,
.speaker-event-actions button,
.speaker-state a {
  display: flex;
  width: 100%;
  min-height: 42px;
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
    transform 100ms ease;
}

.speaker-event-actions button,
.speaker-state a {
  border-color: #1f5fe8;
  background: #1f5fe8;
  color: #fff;
  cursor: pointer;
}

.speaker-event-actions a:active,
.speaker-event-actions button:active,
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

  .speaker-event-actions button:hover,
  .speaker-state a:hover {
    border-color: #174fc7;
    background: #174fc7;
  }
}

@media (max-width: 800px) {
  .speaker-shell {
    width: min(100% - 32px, 680px);
  }

  .speaker-profile-layout {
    grid-template-columns: 1fr;
  }

  .speaker-event-card {
    position: static;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 136px;
    align-items: center;
    gap: 18px 22px;
  }

  .speaker-qr {
    grid-column: 2;
    grid-row: 1 / span 2;
    width: 136px;
    height: 136px;
    margin: 0;
  }

  .speaker-qr :deep(svg) {
    width: 116px;
    height: 116px;
  }

  .speaker-event-actions {
    grid-column: 1;
  }
}

@media (max-width: 560px) {
  .speaker-shell {
    width: min(100% - 24px, 680px);
    padding: 16px 0 40px;
  }

  .speaker-back {
    margin-bottom: 8px;
  }

  .speaker-profile-layout {
    gap: 12px;
  }

  .speaker-profile,
  .speaker-event-card {
    border-radius: 12px;
  }

  .speaker-hero {
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 18px;
    padding: 24px 20px;
  }

  .speaker-portrait {
    width: 84px;
    height: 84px;
    box-shadow: 0 0 0 4px #f4f7fc;
    font-size: 28px;
  }

  .speaker-kicker span:last-child {
    display: none;
  }

  .speaker-intro h1 {
    margin-top: 8px;
    font-size: 32px;
  }

  .speaker-intro > p {
    font-size: 14px;
  }

  .speaker-tags {
    margin-top: 10px;
  }

  .speaker-topic-section,
  .speaker-content-section {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 22px 20px;
  }

  .speaker-topic-section > div:last-child h2 {
    font-size: 22px;
  }

  .speaker-topic-section > div:last-child p,
  .speaker-content-section > p {
    font-size: 14px;
    line-height: 1.75;
  }

  .speaker-event-card {
    grid-template-columns: minmax(0, 1fr) 112px;
    gap: 16px;
    padding: 20px;
  }

  .speaker-event h2 {
    font-size: 17px;
  }

  .speaker-event > span {
    display: none;
  }

  .speaker-qr {
    width: 112px;
    height: 112px;
  }

  .speaker-qr :deep(svg) {
    width: 94px;
    height: 94px;
  }

  .speaker-event-actions {
    grid-column: 1 / -1;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .speaker-event-actions a,
  .speaker-event-actions button {
    padding-inline: 8px;
    font-size: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .speaker-event-actions a,
  .speaker-event-actions button,
  .speaker-state a {
    transition: none;
  }
}
</style>
