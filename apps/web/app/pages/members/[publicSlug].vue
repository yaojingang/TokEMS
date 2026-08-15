<script setup lang="ts">
import { useAsyncData, useRequestURL } from '#imports';
import { publicEventHomePath } from '@conference/contracts';
import QRCode from 'qrcode.vue';
import { attendeeAvatarInitial } from '~/utils/attendee-poster';

const route = useRoute();
const requestUrl = useRequestURL();
const api = useConferenceApi();
const eventSlug = computed(() => String(route.query.event ?? ''));
const publicSlug = computed(() => String(route.params.publicSlug ?? ''));
const copied = ref(false);

const { data: member, error } = await useAsyncData(
  () => `event-member:${eventSlug.value}:${publicSlug.value}`,
  () => api.getEventMember(eventSlug.value, publicSlug.value),
  { watch: [eventSlug, publicSlug] },
);

const memberName = computed(
  () =>
    member.value?.displayName ??
    `报名会员 NO.${String(member.value?.sequence ?? 1).padStart(3, '0')}`,
);
const identity = computed(() =>
  [member.value?.company, member.value?.title].filter(Boolean).join(' · '),
);
const avatarInitial = computed(() =>
  attendeeAvatarInitial(member.value?.displayName ?? member.value?.initials),
);
const formattedSequence = computed(() => String(member.value?.sequence ?? 1).padStart(3, '0'));
const hasContacts = computed(
  () =>
    Boolean(member.value?.businessUrl) ||
    Boolean(member.value?.contactPhone) ||
    Boolean(member.value?.contactEmail) ||
    Boolean(member.value?.wechatId),
);
const currentUrl = computed(() => {
  return new URL(route.fullPath, requestUrl.origin).toString();
});

async function shareMember() {
  if (!import.meta.client || !member.value) return;
  if (navigator.share) {
    await navigator.share({
      title: `${memberName.value}的参会名片`,
      text: `我将在${member.value.eventName}现场，期待与你见面。`,
      url: window.location.href,
    });
    return;
  }
  await navigator.clipboard.writeText(window.location.href);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1800);
}

useHead(() => ({
  title: member.value ? `${memberName.value} · ${member.value.eventName}` : '参会名片',
  meta: [
    { name: 'robots', content: 'noindex,nofollow' },
    {
      name: 'description',
      content: member.value
        ? `${memberName.value}已报名参加${member.value.eventName}`
        : '大会报名会员参会名片',
    },
  ],
}));
</script>

<template>
  <div class="member-page">
    <FlowHeader />
    <main id="main-content" class="member-shell">
      <p v-if="error" class="member-state">这张参会名片已停止公开，或链接已经失效。</p>
      <template v-else-if="member">
        <NuxtLink class="profile-back" :to="publicEventHomePath(member.eventSlug)">
          ← 返回大会主页
        </NuxtLink>
        <section class="profile-layout">
          <article class="profile-card">
            <header class="profile-hero">
              <div class="profile-avatar">
                <img v-if="member.avatarUrl" :src="member.avatarUrl" :alt="`${memberName}的头像`" />
                <span v-else aria-hidden="true">{{ avatarInitial }}</span>
              </div>
              <div class="profile-summary">
                <div class="profile-meta">
                  <span>ATTENDEE</span>
                  <span>NO.{{ formattedSequence }}</span>
                </div>
                <h1>{{ memberName }}</h1>
                <p v-if="identity" class="profile-role">{{ identity }}</p>
                <div v-if="member.industryLabel" class="profile-tags">
                  <span>{{ member.industryLabel }}</span>
                </div>
              </div>
            </header>

            <section v-if="member.businessIntro" class="profile-section profile-about">
              <div class="profile-section-heading">
                <span>ABOUT</span>
                <h2>我的业务与合作</h2>
              </div>
              <p>{{ member.businessIntro }}</p>
            </section>

            <section v-if="hasContacts" class="profile-section profile-contact">
              <div class="profile-section-heading">
                <span>CONNECT</span>
                <h2>公开联系信息</h2>
              </div>
              <dl class="profile-contact-list">
                <div v-if="member.businessUrl">
                  <dt>项目网址</dt>
                  <dd>
                    <a
                      :href="member.businessUrl"
                      target="_blank"
                      rel="nofollow ugc noopener noreferrer"
                    >
                      {{ member.businessUrl }}
                    </a>
                  </dd>
                </div>
                <div v-if="member.contactPhone">
                  <dt>联系电话</dt>
                  <dd>{{ member.contactPhone }}</dd>
                </div>
                <div v-if="member.contactEmail">
                  <dt>联系邮箱</dt>
                  <dd>{{ member.contactEmail }}</dd>
                </div>
                <div v-if="member.wechatId">
                  <dt>微信号</dt>
                  <dd>{{ member.wechatId }}</dd>
                </div>
              </dl>
            </section>
          </article>

          <aside class="profile-share">
            <div class="profile-event">
              <p>MEET AT THE EVENT</p>
              <h2>{{ member.eventName }}</h2>
              <span>扫描二维码，在大会现场继续交流</span>
            </div>
            <div class="profile-qr" role="img" aria-label="参会名片二维码">
              <QRCode :value="currentUrl" :size="160" level="M" render-as="svg" />
            </div>
            <div class="profile-actions">
              <button type="button" @click="shareMember">
                {{ copied ? '链接已复制' : '分享参会名片' }}
              </button>
              <NuxtLink :to="publicEventHomePath(member.eventSlug)">查看大会详情与报名</NuxtLink>
            </div>
          </aside>
        </section>
      </template>
      <p v-else class="member-state">正在读取参会名片…</p>
    </main>
  </div>
</template>

<style scoped>
.member-page {
  min-height: 100vh;
  background: #f4f6f9;
}
.member-shell {
  width: min(100% - 40px, 1060px);
  margin-inline: auto;
  padding: 28px 0 64px;
}
.profile-back {
  display: inline-flex;
  min-height: 36px;
  align-items: center;
  margin-bottom: 12px;
  color: #657186;
  font-size: 13px;
}
.profile-back:hover {
  color: #1f5fe8;
}
.profile-back:focus-visible {
  border-radius: 4px;
  outline: 3px solid rgb(31 95 232 / 18%);
  outline-offset: 2px;
}
.profile-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
  align-items: start;
  gap: 16px;
  padding: 0;
}
.profile-card,
.profile-share {
  border: 1px solid #dfe5ee;
  background: #fff;
  box-shadow: 0 12px 34px rgb(28 45 74 / 6%);
}
.profile-card {
  border-radius: 14px;
  overflow: hidden;
}
.profile-hero {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  align-items: center;
  gap: 30px;
  padding: 34px 36px 32px;
}
.profile-avatar {
  display: grid;
  width: 132px;
  height: 132px;
  place-items: center;
  overflow: hidden;
  border: 1px solid #d8e1f0;
  border-radius: 50%;
  background: #e8efff;
  box-shadow: 0 0 0 6px #f4f7fc;
  color: #1f5fe8;
  font-size: 42px;
  font-weight: 760;
  line-height: 1;
}
.profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.profile-summary {
  min-width: 0;
}
.profile-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-meta span,
.profile-event > p,
.profile-section-heading > span {
  margin: 0;
  color: #1f5fe8;
  font: 720 10px var(--conference-font-mono);
  letter-spacing: 0.1em;
}
.profile-meta span + span {
  padding-left: 8px;
  border-left: 1px solid #cbd5e5;
}
.profile-summary h1 {
  margin: 10px 0 7px;
  color: #172033;
  font-size: clamp(38px, 5vw, 50px);
  line-height: 1.08;
  letter-spacing: -0.04em;
  overflow-wrap: anywhere;
}
.profile-role {
  margin: 0;
  color: #4e5a6d;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}
.profile-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}
.profile-tags span {
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
.profile-section {
  display: grid;
  grid-template-columns: 158px minmax(0, 1fr);
  gap: 24px;
  padding: 26px 36px;
  border-top: 1px solid #e8edf4;
}
.profile-section-heading h2 {
  margin: 6px 0 0;
  color: #172033;
  font-size: 16px;
  line-height: 1.5;
}
.profile-section > p {
  margin: 0;
  color: #404c60;
  font-size: 15px;
  line-height: 1.8;
  white-space: pre-wrap;
}
.profile-contact-list {
  display: grid;
  gap: 0;
  margin: 0;
}
.profile-contact-list > div {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid #edf0f5;
}
.profile-contact-list > div:first-child {
  padding-top: 0;
}
.profile-contact-list > div:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.profile-contact-list dt {
  color: #7a8597;
  font-size: 12px;
}
.profile-contact-list dd {
  margin: 0;
  color: #253149;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.profile-contact-list a {
  color: #1f5fe8;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.profile-share {
  position: sticky;
  top: 20px;
  border-radius: 14px;
  padding: 22px;
}
.profile-event {
  text-align: left;
}
.profile-event h2 {
  margin: 7px 0;
  color: #172033;
  font-size: 18px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.profile-event > span {
  color: #7a8597;
  font-size: 12px;
  line-height: 1.6;
}
.profile-qr {
  display: grid;
  width: 184px;
  height: 184px;
  place-items: center;
  margin: 18px auto;
  border: 1px solid #e3e8f0;
  background: #fff;
}
.profile-qr :deep(svg) {
  width: 160px;
  height: 160px;
}
.profile-actions {
  display: grid;
  gap: 8px;
}
.profile-actions button,
.profile-actions a {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  width: 100%;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 750;
}
.profile-actions button {
  border: 1px solid #1f5fe8;
  background: #1f5fe8;
  color: #fff;
  cursor: pointer;
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    transform 100ms ease;
}
.profile-actions button:hover {
  border-color: #174fc7;
  background: #174fc7;
}
.profile-actions button:active,
.profile-actions a:active {
  transform: scale(0.98);
}
.profile-actions button:focus-visible,
.profile-actions a:focus-visible {
  outline: 3px solid rgb(31 95 232 / 18%);
  outline-offset: 2px;
}
.profile-actions a {
  border: 1px solid #d6deea;
  color: #29364d;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    transform 100ms ease;
}
.profile-actions a:hover {
  border-color: #b9c5d7;
  background: #f7f9fc;
}
.member-state {
  padding: 100px 0;
  color: #6d788a;
  text-align: center;
}
@media (max-width: 800px) {
  .member-shell {
    width: min(100% - 32px, 680px);
  }
  .profile-layout {
    grid-template-columns: 1fr;
  }
  .profile-share {
    position: static;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 136px;
    align-items: center;
    gap: 18px 22px;
  }
  .profile-qr {
    grid-column: 2;
    grid-row: 1 / span 2;
    width: 136px;
    height: 136px;
    margin: 0;
  }
  .profile-qr :deep(svg) {
    width: 116px;
    height: 116px;
  }
  .profile-actions {
    grid-column: 1;
  }
}
@media (max-width: 560px) {
  .member-shell {
    width: min(100% - 24px, 680px);
    padding: 16px 0 40px;
  }
  .profile-back {
    margin-bottom: 8px;
  }
  .profile-layout {
    gap: 12px;
  }
  .profile-card,
  .profile-share {
    border-radius: 12px;
  }
  .profile-hero {
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 18px;
    padding: 24px 20px;
  }
  .profile-avatar {
    width: 84px;
    height: 84px;
    box-shadow: 0 0 0 4px #f4f7fc;
    font-size: 28px;
  }
  .profile-summary h1 {
    margin-top: 8px;
    font-size: 32px;
  }
  .profile-role {
    font-size: 14px;
  }
  .profile-tags {
    margin-top: 10px;
  }
  .profile-section {
    grid-template-columns: 1fr;
    gap: 14px;
    padding: 22px 20px;
  }
  .profile-section-heading h2 {
    margin-top: 4px;
  }
  .profile-section > p {
    font-size: 14px;
    line-height: 1.75;
  }
  .profile-contact-list > div {
    grid-template-columns: 1fr;
    gap: 3px;
    padding: 10px 0;
  }
  .profile-share {
    grid-template-columns: minmax(0, 1fr) 112px;
    gap: 16px;
    padding: 20px;
  }
  .profile-event h2 {
    font-size: 17px;
  }
  .profile-event > span {
    display: none;
  }
  .profile-qr {
    width: 112px;
    height: 112px;
  }
  .profile-qr :deep(svg) {
    width: 94px;
    height: 94px;
  }
  .profile-actions {
    grid-column: 1 / -1;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .profile-actions button,
  .profile-actions a {
    padding-inline: 8px;
    font-size: 12px;
  }
}
</style>
