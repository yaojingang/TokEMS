<script setup lang="ts">
import { publicEventHomePath, type PublicEvent } from '@conference/contracts';
import { createError, onBeforeUnmount, useAsyncData } from '#imports';
import { copyPlainText } from '~/utils/copy-text';

const organizerContact = {
  name: '姚金刚',
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

const conversationGuide = [
  { no: '01', label: '所在机构', detail: '简单介绍公司和业务' },
  { no: '02', label: '合作方向', detail: '说明希望参与的方式' },
  { no: '03', label: '可用资源', detail: '分享双方可以投入的资源' },
  { no: '04', label: '合作目标', detail: '说清希望共同达成的结果' },
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

const homeHref = computed(() => publicEventHomePath(event.value!.slug));
</script>

<template>
  <div class="conference-page cooperation-page">
    <nav id="nav" class="scrolled cooperation-nav" aria-label="合作联系页导航">
      <div class="nav-inner">
        <NuxtLink :to="homeHref" class="logo" aria-label="返回大会首页">
          <span class="logo-mark">G</span>
          <span>{{ event?.shortName || event?.name || '大会官网' }}</span>
          <span class="logo-sub">合作联系</span>
        </NuxtLink>
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
      <header class="cooperation-intro">
        <div class="cooperation-intro__copy">
          <p class="flow-eyebrow">PARTNERSHIP</p>
          <h1 class="flow-title">一起把好内容带到现场</h1>
          <p class="flow-lead">
            围绕品牌、产品、媒体、内容、社群和团队参会，与
            {{ event?.name }}
            一起创造更有价值的现场连接。
          </p>
        </div>
        <div class="cooperation-intro__aside">
          <span>PARTNER WITH US</span>
          <strong>合作从一次清晰的对话开始。</strong>
          <p>添加大会发起人微信，直接说明你的想法与资源。</p>
        </div>
      </header>

      <section class="cooperation-layout" aria-label="合作方向与联系方式">
        <div class="cooperation-scope">
          <div class="cooperation-section-head">
            <p class="flow-eyebrow">WHAT WE CAN BUILD</p>
            <h2>可以一起做什么</h2>
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

        <aside class="direct-contact" aria-labelledby="direct-contact-title">
          <p class="direct-contact__eyebrow">DIRECT CONTACT</p>
          <h2 id="direct-contact-title">加微信，聊合作</h2>
          <p class="direct-contact__lead">微信沟通更直接，也方便后续发送合作资料。</p>

          <figure class="direct-contact__qr">
            <img
              :src="organizerContact.qrSrc"
              width="888"
              height="1128"
              alt="姚金刚微信二维码"
              decoding="async"
            />
            <figcaption>长按保存图片，或截图后在微信中识别</figcaption>
          </figure>

          <dl class="direct-contact__details">
            <div>
              <dt>微信联系人</dt>
              <dd>{{ organizerContact.name }}</dd>
            </div>
            <div>
              <dt>微信号</dt>
              <dd class="direct-contact__wechat-id">
                <code>{{ organizerContact.wechatId }}</code>
                <button type="button" @click="copyWechatId">
                  {{ copyStatus === '微信号已复制' ? '已复制' : '复制' }}
                </button>
              </dd>
            </div>
          </dl>

          <p class="direct-contact__note">
            添加好友后，请备注「大会合作＋公司名＋姓名」，方便快速确认来意。
          </p>
          <p class="direct-contact__copy-status" role="status" aria-live="polite">
            {{ copyStatus }}
          </p>
        </aside>
      </section>

      <section class="conversation-guide" aria-labelledby="conversation-guide-title">
        <div class="conversation-guide__head">
          <p class="flow-eyebrow">LET'S TALK</p>
          <h2 id="conversation-guide-title">沟通时带上这些信息</h2>
        </div>
        <ol>
          <li v-for="item in conversationGuide" :key="item.no">
            <span>{{ item.no }}</span>
            <strong>{{ item.label }}</strong>
            <p>{{ item.detail }}</p>
          </li>
        </ol>
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

.cooperation-shell {
  width: 100%;
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 132px var(--pad) 84px;
}

.cooperation-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: end;
  gap: clamp(48px, 6vw, 82px);
  padding-bottom: 46px;
  border-bottom: 1px solid var(--line);
}

.cooperation-intro .flow-title {
  max-width: 720px;
  font-size: clamp(36px, 4.2vw, 52px);
  line-height: 1.06;
}

.cooperation-intro .flow-lead {
  max-width: 720px;
  margin-top: 20px;
  font-size: 16px;
  line-height: 1.8;
  text-wrap: pretty;
}

.cooperation-intro__aside {
  display: grid;
  gap: 9px;
  padding-top: 20px;
  border-top: 2px solid var(--accent);
}

.cooperation-intro__aside > span {
  color: var(--accent);
  font-family: var(--conference-font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.cooperation-intro__aside strong {
  font-size: 17px;
  line-height: 1.5;
}

.cooperation-intro__aside p {
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
  line-height: 1.7;
}

.cooperation-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  align-items: start;
  gap: clamp(40px, 5vw, 64px);
  padding: 52px 0 56px;
}

.cooperation-section-head {
  max-width: 620px;
  margin-bottom: 25px;
}

.cooperation-section-head h2,
.conversation-guide__head h2 {
  margin: 0;
  font-size: clamp(26px, 3vw, 36px);
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
  grid-template-columns: 1fr 1fr;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
  list-style: none;
}

.cooperation-scope__list li {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 21px 0;
  border-bottom: 1px solid var(--line);
}

.cooperation-scope__list li:nth-child(odd) {
  padding-right: 24px;
  border-right: 1px solid var(--line);
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
  padding: 34px 32px 32px;
  border-radius: 0 0 18px 18px;
  background: #1d4ed8;
  color: #eff6ff;
}

.direct-contact__eyebrow {
  margin: 0 0 9px;
  color: #bfdbfe;
  font-family: var(--conference-font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.13em;
}

.direct-contact h2 {
  margin: 0;
  color: #f8fafc;
  font-size: 28px;
  line-height: 1.2;
  text-wrap: balance;
}

.direct-contact__lead {
  margin: 10px 0 24px;
  color: rgb(239 246 255 / 76%);
  font-size: 13px;
  line-height: 1.7;
}

.direct-contact__qr {
  width: min(100%, 248px);
  margin: 0 auto 25px;
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

.direct-contact__qr figcaption {
  padding: 10px 12px 11px;
  color: #64748b;
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
}

.direct-contact__details {
  margin: 0;
  border-top: 1px solid rgb(239 246 255 / 24%);
  border-bottom: 1px solid rgb(239 246 255 / 24%);
}

.direct-contact__details > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 0;
}

.direct-contact__details > div + div {
  border-top: 1px solid rgb(239 246 255 / 18%);
}

.direct-contact__details dt {
  color: rgb(239 246 255 / 58%);
  font-size: 11px;
  letter-spacing: 0.05em;
}

.direct-contact__details dd {
  margin: 0;
  color: #f8fafc;
  font-size: 15px;
  font-weight: 750;
}

.direct-contact__wechat-id {
  display: flex;
  align-items: center;
  gap: 10px;
}

.direct-contact__wechat-id code {
  color: inherit;
  font-family: var(--conference-font-mono);
  font-size: 14px;
  user-select: all;
}

.direct-contact__wechat-id button {
  min-height: 32px;
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

.direct-contact__wechat-id button:hover {
  background: rgb(239 246 255 / 12%);
}

.direct-contact__wechat-id button:active {
  transform: scale(0.96);
}

.direct-contact__note {
  margin: 18px 0 0;
  color: rgb(239 246 255 / 72%);
  font-size: 12px;
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

.conversation-guide {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(0, 2.2fr);
  gap: clamp(40px, 6vw, 76px);
  padding: 42px 0 0;
  border-top: 1px solid var(--line);
}

.conversation-guide ol {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  list-style: none;
}

.conversation-guide li {
  min-width: 0;
  padding: 0 18px;
}

.conversation-guide li:first-child {
  padding-left: 0;
}

.conversation-guide li + li {
  border-left: 1px solid var(--line);
}

.conversation-guide li > span {
  display: block;
  margin-bottom: 12px;
  color: var(--accent);
  font-family: var(--conference-font-mono);
  font-size: 11px;
}

.conversation-guide li strong {
  font-size: 14px;
}

.conversation-guide li p {
  margin: 5px 0 0;
  color: var(--ink-muted);
  font-size: 11px;
  line-height: 1.65;
}

@media (max-width: 900px) {
  .cooperation-intro {
    grid-template-columns: 1fr;
    align-items: start;
    gap: 30px;
  }

  .cooperation-layout {
    grid-template-columns: minmax(0, 1fr) 310px;
    gap: 32px;
  }

  .direct-contact {
    padding-inline: 26px;
  }

  .conversation-guide {
    grid-template-columns: 1fr;
    gap: 28px;
  }
}

@media (max-width: 700px) {
  .cooperation-shell {
    padding: 104px 20px 56px;
  }

  .cooperation-intro {
    gap: 25px;
    padding-bottom: 32px;
  }

  .cooperation-intro .flow-title {
    font-size: clamp(28px, 8.5vw, 36px);
    line-height: 1.08;
    white-space: nowrap;
  }

  .cooperation-intro .flow-lead {
    margin-top: 16px;
    font-size: 15px;
    line-height: 1.75;
  }

  .cooperation-layout {
    grid-template-columns: 1fr;
    gap: 40px;
    padding: 32px 0 46px;
  }

  .direct-contact {
    order: -1;
    padding: 30px 22px 27px;
  }

  .direct-contact h2 {
    font-size: 27px;
  }

  .direct-contact__qr {
    width: min(100%, 236px);
  }

  .direct-contact__wechat-id button {
    min-height: 44px;
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
    border-right: 0;
  }

  .conversation-guide {
    padding-top: 34px;
  }

  .conversation-guide ol {
    grid-template-columns: 1fr 1fr;
  }

  .conversation-guide li,
  .conversation-guide li:first-child {
    padding: 17px 16px;
    border-top: 1px solid var(--line);
  }

  .conversation-guide li:nth-child(odd) {
    padding-left: 0;
    border-left: 0;
  }

  .conversation-guide li:nth-child(even) {
    padding-right: 0;
    border-left: 1px solid var(--line);
  }

  .conversation-guide li > span {
    margin-bottom: 8px;
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
