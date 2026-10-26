<script setup lang="ts">
import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  resolveNavigationLinks,
  publicEventHomePath,
  type PublicEvent,
} from '@conference/contracts';
import { createError, onBeforeUnmount, useAsyncData, useRequestURL } from '#imports';
import { resolveEventExperience } from '~/composables/useEventExperience';
import { copyPlainText } from '~/utils/copy-text';

const organizerContact = {
  wechatId: 'laoyaoke',
  qrSrc: '/images/contacts/yao-jingang-wechat.jpg',
} as const;
const copyStatus = ref('');
let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;

async function copyWechatId() {
  const copied = await copyPlainText(organizerContact.wechatId);
  copyStatus.value = copied ? '微信号已复制' : '复制失败，请长按微信号复制';
  if (copyStatusTimer) clearTimeout(copyStatusTimer);
  copyStatusTimer = setTimeout(() => {
    copyStatus.value = '';
  }, 3000);
}

onBeforeUnmount(() => {
  if (copyStatusTimer) clearTimeout(copyStatusTimer);
});

const cooperationDirections = [
  {
    no: '01',
    title: '品牌赞助',
    body: '联合权益、品牌露出与大会主题共建',
  },
  {
    no: '02',
    title: '展位展示',
    body: '产品体验、现场演示与供需连接',
  },
  {
    no: '03',
    title: '媒体合作',
    body: '内容报道、嘉宾访谈与传播联动',
  },
  {
    no: '04',
    title: '内容共创',
    body: '主题演讲、案例发布与白皮书合作',
  },
  {
    no: '05',
    title: '社群渠道',
    body: '定向邀约、联合招募与社群传播',
  },
  {
    no: '06',
    title: '团队购票',
    body: '企业组团、席位安排与专属服务',
  },
] as const;

const api = useConferenceApi();
const route = useRoute();
const eventSlug = computed(() => {
  const value = Array.isArray(route.query.event) ? route.query.event[0] : route.query.event;
  return typeof value === 'string' ? value.trim() : '';
});
const { data: event, error: eventError } = await useAsyncData<PublicEvent>(
  () => `cooperation-event-${eventSlug.value || 'homepage'}`,
  () => (eventSlug.value ? api.getEvent(eventSlug.value) : api.getHomepageEvent()),
  { deep: false, watch: [eventSlug] },
);
if (eventError.value || !event.value) {
  const failure = eventError.value as { statusCode?: number; status?: number } | null;
  throw createError({
    statusCode: failure?.statusCode ?? failure?.status ?? 503,
    statusMessage:
      (failure?.statusCode ?? failure?.status) === 404
        ? '大会不存在或尚未公开'
        : '大会合作页面暂时不可用',
  });
}

useHead(() => ({ title: `合作联系 · ${event.value?.name ?? '大会'}` }));

const resolvedEventSlug = computed(() => event.value?.slug ?? '');
const hasSupporters = computed(() => resolvedEventSlug.value === 'tokems26');
const {
  data: partnerDirectory,
  error: partnerError,
  status: partnerStatus,
} = await useAsyncData(
  () => `cooperation-partners-${resolvedEventSlug.value}`,
  async () => {
    const slug = resolvedEventSlug.value;
    const result = await api.getEventPartners(slug, 100, 'directory');
    return { eventSlug: slug, items: result.items };
  },
  { deep: false },
);
const partners = computed(() => {
  if (
    partnerError.value ||
    partnerStatus.value !== 'success' ||
    partnerDirectory.value?.eventSlug !== resolvedEventSlug.value ||
    (eventSlug.value && eventSlug.value !== resolvedEventSlug.value)
  )
    return [];
  return partnerDirectory.value.items;
});

const homeHref = computed(() => publicEventHomePath(event.value!.slug));
const experience = computed(() => resolveEventExperience(event.value!));
const defaultHomeBlocks =
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind === 'structured'
    ? DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home.blocks
    : [];
const homeBlock = (nodeKey: string) =>
  experience.value.home.blocks.find((block) => block.nodeKey === nodeKey) ??
  defaultHomeBlocks.find((block) => block.nodeKey === nodeKey);
const navigationCopy = (key: string, fallback: string) => {
  const value = homeBlock('home.navigation')?.content[key];
  if (typeof value === 'string') return value;
  const defaultValue = defaultHomeBlocks.find((block) => block.nodeKey === 'home.navigation')
    ?.content[key];
  return typeof defaultValue === 'string' ? defaultValue : fallback;
};
const navigationOrigin = useRequestURL().origin;
const navigationLinks = computed(() => resolveNavigationLinks(event.value!, experience.value.home, experience.value.faq.mode, { origin: navigationOrigin }));
</script>

<template>
  <div class="conference-page cooperation-page">
    <nav id="nav" class="scrolled cooperation-nav" aria-label="合作联系页导航">
      <div class="nav-inner">
        <NuxtLink :to="homeHref" class="logo" aria-label="返回大会首页">
          <span class="logo-mark">{{ navigationCopy('logoMark', 'G') }}</span>
          <span class="logo-name">{{ navigationCopy('brandLabel', 'GEO大会') }}</span>
          <span class="logo-sub">{{ navigationCopy('brandMeta', '2026 · 第二届') }}</span>
        </NuxtLink>
        <ConferenceNavigationLinks :links="navigationLinks" />
        <div class="nav-cta">
          <NuxtLink class="btn btn-outline cooperation-home-link" :to="homeHref">
            <span class="cooperation-home-link__desktop">返回大会首页</span>
            <span class="cooperation-home-link__mobile">首页</span>
          </NuxtLink>
          <CustomerAccountAction />
        </div>
      </div>
    </nav>

    <main id="main-content" class="cooperation-shell" tabindex="-1">
      <ConferenceSupporters v-if="hasSupporters" :key="resolvedEventSlug" />
      <ConferencePartners
        v-if="partners.length"
        :items="partners"
        :event-slug="resolvedEventSlug"
        :heading-level="hasSupporters ? 'h2' : 'h1'"
      />
      <p v-else-if="partnerError" class="cooperation-partners__error" role="status">
        伙伴资料暂时无法加载，请稍后刷新。你仍可通过下方合作方向与我们联系。
      </p>

      <section class="cooperation-layout" aria-label="合作方向与联系方式">
        <div class="cooperation-scope">
          <div class="cooperation-section-head">
            <p class="flow-eyebrow">WHAT WE CAN BUILD</p>
            <component :is="hasSupporters || partners.length ? 'h2' : 'h1'">可以一起做什么</component>
            <p>选择一个最接近的方向开启沟通，具体形式可以根据双方资源继续展开。</p>
          </div>

          <ol class="cooperation-scope__list">
            <li v-for="direction in cooperationDirections" :key="direction.no">
              <span>{{ direction.no }}</span>
              <div>
                <h3>{{ direction.title }}</h3>
                <p>{{ direction.body }}</p>
              </div>
            </li>
          </ol>

          <p class="cooperation-scope__other">
            有其他合作想法，也欢迎直接沟通。我们会结合大会内容和现场安排一起判断可行方式。
          </p>
        </div>

        <aside id="cooperation-contact" class="direct-contact" aria-label="合作联系" tabindex="-1">
          <p class="flow-eyebrow">LET'S TALK</p>
          <p class="direct-contact__lead">添加大会发起人微信，聊聊你的合作方向与资源。</p>
          <figure class="direct-contact__qr">
            <img
              :src="organizerContact.qrSrc"
              width="888"
              height="1128"
              alt="姚金刚微信二维码"
              decoding="async"
            />
          </figure>

          <div class="direct-contact__wechat">
            <span>微信号</span>
            <code>{{ organizerContact.wechatId }}</code>
            <button type="button" @click="copyWechatId">
              {{ copyStatus === '微信号已复制' ? '已复制' : '复制' }}
            </button>
          </div>

          <p class="direct-contact__note">添加好友请备注「大会合作＋公司名＋姓名」</p>
          <p class="direct-contact__copy-status" role="status" aria-live="polite">
            {{ copyStatus }}
          </p>
        </aside>
      </section>
    </main>
  </div>
</template>

<style scoped>
.cooperation-page {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
}

.cooperation-nav {
  box-shadow: 0 1px 0 rgb(23 23 23 / 2%);
}

.cooperation-home-link__mobile {
  display: none;
}

.cooperation-nav .nav-links a {
  white-space: nowrap;
}

.cooperation-nav .nav-links a[aria-current='page'] {
  color: var(--accent);
}

.cooperation-shell {
  --cooperation-column-gap: 32px;
  width: 100%;
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 132px var(--pad) 84px;
}

.cooperation-layout {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: stretch;
  gap: var(--cooperation-column-gap);
  padding: 0 0 56px;
}

.cooperation-scope {
  display: flex;
  flex-direction: column;
  grid-column: span 2;
  min-width: 0;
}

.cooperation-section-head {
  max-width: 620px;
  margin-bottom: 25px;
}

.cooperation-section-head :is(h1, h2) {
  margin: 0;
  font-size: clamp(26px, 2.5vw, 32px);
  font-weight: 700;
  line-height: 1.18;
  text-wrap: balance;
}

.cooperation-section-head > p:last-child {
  margin: 12px 0 0;
  color: var(--ink-soft);
  font-size: 14px;
  line-height: 1.75;
  text-wrap: pretty;
}

.cooperation-scope__list {
  display: grid;
  flex: 1;
  grid-template-columns: 1fr 1fr;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cooperation-scope__list li {
  display: grid;
  align-content: center;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 21px 0;
}

.cooperation-scope__list li:nth-child(odd) {
  padding-right: 24px;
}

.cooperation-scope__list li:nth-child(even) {
  padding-left: 24px;
}

.cooperation-scope__list li > span {
  padding-top: 3px;
  color: var(--accent);
  font-family: var(--conference-font-mono);
  font-size: 11px;
}

.cooperation-scope__list h3 {
  margin: 0 0 4px;
  font-size: 15px;
  line-height: 1.5;
}

.cooperation-scope__list p {
  margin: 0;
  color: var(--ink-muted);
  font-size: 12px;
  line-height: 1.65;
}

.cooperation-scope__other {
  margin: 22px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.75;
  text-wrap: pretty;
}

.direct-contact {
  display: grid;
  align-content: start;
  scroll-margin-top: 132px;
  padding: 28px;
  border-radius: 0 0 18px 18px;
  background: #1d4ed8;
  color: #eff6ff;
}

.direct-contact__qr {
  width: min(100%, 180px);
  margin: 20px auto;
  overflow: hidden;
  border-radius: 8px;
  outline: 1px solid rgb(23 23 23 / 10%);
  outline-offset: -1px;
  background: #f8fafc;
}

.direct-contact__qr img {
  display: block;
  width: 100%;
  height: auto;
  background: #fff;
}

.direct-contact__wechat {
  display: grid;
  min-height: 52px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.direct-contact__wechat > span {
  color: #dbeafe;
  font-size: 11px;
  letter-spacing: 0.05em;
}

.direct-contact__wechat code {
  color: #f8fafc;
  font-family: var(--conference-font-mono);
  font-size: 14px;
  font-weight: 750;
  user-select: all;
}

.direct-contact__wechat button {
  min-height: 40px;
  padding: 0 10px;
  border: 1px solid rgb(239 246 255 / 36%);
  border-radius: 5px;
  color: #f8fafc;
  font-size: 10px;
  font-weight: 700;
  transition:
    background-color 120ms ease,
    transform 120ms ease;
}

.direct-contact__wechat button:hover {
  background: rgb(239 246 255 / 12%);
}

.direct-contact__wechat button:active {
  transform: scale(0.96);
}

.direct-contact__note {
  margin: 16px 0 0;
  color: #dbeafe;
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}

.direct-contact__copy-status {
  min-height: 18px;
  margin: 7px 0 -8px;
  color: #dbeafe;
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
}

.direct-contact > .flow-eyebrow {
  color: #dbeafe;
  font-size: 10px;
}

.direct-contact__lead {
  margin: 10px 0 0;
  color: #dbeafe;
  font-size: 12px;
  line-height: 1.85;
}

.cooperation-partners__error {
  margin: 0 0 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.85;
}

.direct-contact button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 4px;
}

@media (max-width: 1200px) {
  .cooperation-nav .nav-inner {
    flex-wrap: wrap;
    gap: 8px 12px;
  }

  .cooperation-nav .nav-links {
    display: flex;
    order: 3;
    flex-basis: 100%;
    min-width: 0;
    overflow-x: auto;
  }

  .cooperation-nav .nav-links a {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    min-height: 44px;
  }

  .cooperation-shell {
    padding-top: 172px;
  }
}

@media (max-width: 1000px) {
  .cooperation-layout {
    grid-template-columns: minmax(0, 1fr) 270px;
  }

  .cooperation-scope {
    grid-column: auto;
  }

  .direct-contact {
    padding-inline: 22px;
  }
}

@media (max-width: 760px) {
  .cooperation-shell {
    padding: 148px 20px 56px;
  }

  .cooperation-layout {
    grid-template-columns: 1fr;
    gap: 32px;
    padding: 0 0 46px;
  }

  .direct-contact {
    padding: 26px 22px 24px;
  }

  .direct-contact__qr {
    width: min(100%, 210px);
  }

  .direct-contact__wechat button {
    min-height: 44px;
    font-size: 12px;
  }

  .cooperation-section-head {
    margin-bottom: 20px;
  }

  .cooperation-scope__list {
    grid-template-columns: 1fr;
  }

  .cooperation-scope__list li:nth-child(odd),
  .cooperation-scope__list li:nth-child(even) {
    padding: 18px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .direct-contact__wechat button {
    transition: none;
    transform: none;
  }
}

@media (max-width: 420px) {
  .cooperation-home-link__desktop {
    display: none;
  }

  .cooperation-home-link__mobile {
    display: inline;
  }
}
</style>
