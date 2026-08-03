<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { createError, definePageMeta, useAsyncData, useRuntimeConfig } from '#imports';
import {
  publicEventHomePath,
  publicEventScopedPath,
  type PublicEvent,
  type Session,
} from '@conference/contracts';
import { resolveEventExperience } from '~/composables/useEventExperience';

definePageMeta({ publicEventHome: true });

let countdown: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
let scrollHandler: (() => void) | undefined;
let accentClickHandler: ((event: MouseEvent) => void) | undefined;
const api = useConferenceApi();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const event = api.eventState;
const requestedEventSlug = computed(() => {
  const value = Array.isArray(route.params.eventSlug)
    ? route.params.eventSlug[0]
    : route.params.eventSlug;
  return typeof value === 'string' && value ? value : '';
});
const eventRouteKey = computed(() => requestedEventSlug.value || 'homepage');
const { data: loadedEvent, error: eventLoadError } = await useAsyncData<PublicEvent>(
  `conference-public-event-${eventRouteKey.value}`,
  () =>
    requestedEventSlug.value
      ? api.getEvent(requestedEventSlug.value)
      : api.getHomepageEvent(),
  { deep: false, watch: [eventRouteKey] },
);
if (eventLoadError.value) {
  const failure = eventLoadError.value as { statusCode?: number; status?: number };
  throw createError({
    statusCode: failure.statusCode ?? failure.status ?? 503,
    statusMessage:
      (failure.statusCode ?? failure.status) === 404 ? '大会不存在或尚未发布' : '大会页面暂时不可用',
  });
}
if (loadedEvent.value) event.value = loadedEvent.value;
const activeDay = ref(1);
const openFaq = ref<number | null>(null);
const experience = computed(() => resolveEventExperience(event.value));
const homeBlocks = computed(() => experience.value.home.blocks);
const enabledFaqs = computed(() => experience.value.faq.items.filter((item) => item.enabled));
const primaryTicket = computed(
  () => event.value.tickets.find((ticket) => ticket.recommended) ?? event.value.tickets[0]!,
);
const days = computed(() =>
  [...new Set(event.value.sessions.map((session) => session.day))].sort((a, b) => a - b),
);
const activeSessions = computed(() =>
  event.value.sessions.filter((session) => session.day === activeDay.value),
);
const money = (amount: number) => `¥${(amount / 100).toLocaleString('zh-CN')}`;
const dateParts = (value: string) => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: event.value.timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    weekday: read('weekday'),
  };
};
const dayLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: event.value.timezone,
    month: 'long',
    day: 'numeric',
  }).format(new Date(value));
const eventDate = computed(() => {
  const start = dateParts(event.value.startsAt);
  const end = dateParts(event.value.endsAt);
  const sameMonth = start.year === end.year && start.month === end.month;
  return {
    full: sameMonth
      ? `${start.year}年${start.month}月${start.day}–${end.day}日`
      : `${dayLabel(event.value.startsAt)}–${dayLabel(event.value.endsAt)}`,
    compact: sameMonth
      ? `${start.month}月${start.day}–${end.day}日`
      : `${dayLabel(event.value.startsAt)}–${dayLabel(event.value.endsAt)}`,
    weekdays: `${start.weekday} · ${end.weekday}`,
    opening: `${start.month}.${start.day}`,
  };
});
const registrationHref = (ticketId: string) =>
  publicEventScopedPath('/register', event.value.slug, { ticket: ticketId });
const faqHref = computed(() =>
  experience.value.faq.mode === 'page'
    ? publicEventScopedPath('/faq', event.value.slug)
    : '#faq',
);
const homeBlock = (nodeKey: string) => homeBlocks.value.find((block) => block.nodeKey === nodeKey);
const blockEnabled = (nodeKey: string) => homeBlock(nodeKey)?.enabled ?? true;
const blockStyle = (nodeKey: string) => ({
  order: Math.max(
    0,
    homeBlocks.value.findIndex((block) => block.nodeKey === nodeKey),
  ),
});
const blockVariant = (nodeKey: string) => homeBlock(nodeKey)?.variant ?? 'default';
const blockCopy = (nodeKey: string, key: string, fallback: string) => {
  const value = homeBlock(nodeKey)?.content[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
};
const heroPrimaryAction = computed(() =>
  blockCopy('home.hero', 'primaryAction', `立即报名 ${money(primaryTicket.value.price)}`),
);
const heroSecondaryAction = computed(() =>
  blockCopy('home.hero', 'secondaryAction', '查看两日议程'),
);
const heroTitlePrefix = computed(() => blockCopy('home.hero', 'titlePrefix', '2026 全球'));
const heroTitleEvent = computed(() => blockCopy('home.hero', 'titleEvent', '大会运营峰会'));
const heroSlogan = computed(() => blockCopy('home.hero', 'slogan', '让每一次相聚都顺利发生'));
const ticketBenefitDetails = [
  '主会场与双分会场任意进出',
  '完成企业 90 天行动计划',
  '完整版现场首发',
  '含 27 套大会运营模板',
  '会前预习与会后复训',
  '会后 3 个工作日发放',
  '全年案例拆解与工具更新',
  '含 1 次线上复盘直播 QA',
];
const ticketBenefits = computed(() =>
  primaryTicket.value.benefits.map((title, index) => ({
    title,
    detail: ticketBenefitDetails[index] ?? '',
  })),
);

type AgendaEntry =
  | {
      type: 'header';
      key: string;
      tag: string;
      title: string;
      range: string;
    }
  | {
      type: 'session';
      key: string;
      session: Session;
    };

const agendaHeaders = [
  {
    day: 1,
    beforeTitle: '开幕致辞：大会运营的下一程',
    tag: '上午场',
    title: '大会运营 · 趋势与全景',
    range: '09:00 – 12:10',
  },
  {
    day: 1,
    beforeTitle: '12 个月大会运营投入产出全复盘',
    tag: '下午场',
    title: '大会运营 · 实战与数据',
    range: '13:30 – 18:00',
  },
  {
    day: 2,
    beforeTitle: '工作坊 ①：你的品牌 AI 可见度诊断',
    tag: 'A 会场',
    title: '实战工作坊 · 带电脑上手',
    range: '09:00 – 12:30',
  },
  {
    day: 2,
    beforeTitle: '2027 全球大会运营新趋势',
    tag: 'B 会场',
    title: '全球大会运营专场',
    range: '09:00 – 12:30',
  },
  {
    day: 2,
    beforeTitle: 'AI Agent 时代的内容分发',
    tag: '主会场',
    title: '前沿与未来 · 闭幕',
    range: '14:00 – 17:30',
  },
] as const;
const agendaEntries = computed<AgendaEntry[]>(() =>
  activeSessions.value.flatMap((session) => {
    const header = agendaHeaders.find(
      (item) => item.day === activeDay.value && item.beforeTitle === session.title,
    );
    return [
      ...(header
        ? [
            {
              type: 'header' as const,
              key: `header-${activeDay.value}-${header.tag}`,
              tag: header.tag,
              title: header.title,
              range: header.range,
            },
          ]
        : []),
      {
        type: 'session' as const,
        key: session.id,
        session,
      },
    ];
  }),
);

useHead(() => ({
  title: experience.value.home.seo.title || `${event.value.name} · 大会详情与报名`,
  meta: [
    {
      name: 'description',
      content: experience.value.home.seo.description || event.value.description,
    },
    {
      name: 'robots',
      content: experience.value.home.seo.indexable ? 'index,follow' : 'noindex,nofollow',
    },
    {
      property: 'og:url',
      content: `${String(runtimeConfig.public.conferenceOrigin).replace(/\/+$/u, '')}${publicEventHomePath(event.value.slug)}`,
    },
    ...(experience.value.home.seo.shareAssetUrl
      ? [
          {
            property: 'og:image',
            content: experience.value.home.seo.shareAssetUrl,
          },
        ]
      : []),
  ],
  link: [
    {
      rel: 'canonical',
      href: `${String(runtimeConfig.public.conferenceOrigin).replace(/\/+$/u, '')}${publicEventHomePath(event.value.slug)}`,
    },
  ],
}));

watch(loadedEvent, async (loaded) => {
  if (!loaded) return;
  event.value = loaded;
  activeDay.value = days.value[0] ?? 1;
  await nextTick();
  document.querySelectorAll('.reveal:not(.in)').forEach((element) => observer?.observe(element));
});

onMounted(() => {
  activeDay.value = days.value[0] ?? 1;
  const nav = document.getElementById('nav');
  const sticky = document.getElementById('stickyBar');
  const hero = document.getElementById('hero');
  const final = document.getElementById('final');
  scrollHandler = () => {
    nav?.classList.toggle('scrolled', scrollY > 40);
    if (!sticky || !hero || !final) return;
    const heroBottom = hero.getBoundingClientRect().bottom;
    const nearEnd = final.getBoundingClientRect().top < innerHeight;
    sticky.classList.toggle('show', heroBottom < 0 && !nearEnd);
  };
  window.addEventListener('scroll', scrollHandler, { passive: true });

  const pad = (value: number) => String(value).padStart(2, '0');
  const tick = () => {
    const target = new Date(event.value.startsAt).getTime();
    const diff = Math.max(0, target - Date.now());
    const values = {
      cdD: String(Math.floor(diff / 86_400_000)),
      cdH: pad(Math.floor((diff % 86_400_000) / 3_600_000)),
      cdM: pad(Math.floor((diff % 3_600_000) / 60_000)),
      cdS: pad(Math.floor((diff % 60_000) / 1_000)),
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    });
  };
  tick();
  countdown = setInterval(tick, 1_000);

  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer?.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
  );
  document.querySelectorAll('.reveal:not(.in)').forEach((element) => observer?.observe(element));

  const accentSelector =
    '.up-card, .spk-card, .ticket-main, .host-card, .upgrade-quote, .ag-session';
  accentClickHandler = (clickEvent) => {
    const target =
      clickEvent.target instanceof Element ? clickEvent.target.closest(accentSelector) : null;
    document
      .querySelectorAll(accentSelector)
      .forEach((element) => element.classList.remove('is-active'));
    target?.classList.add('is-active');
  };
  document.addEventListener('click', accentClickHandler);
});

onBeforeUnmount(() => {
  if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
  if (accentClickHandler) document.removeEventListener('click', accentClickHandler);
  if (countdown) clearInterval(countdown);
  observer?.disconnect();
});
</script>

<template>
  <a class="skip-link" href="#hero">跳转到主要内容</a>
  <div class="conference-page" lang="zh-CN">
    <!-- ── NAV ── -->
    <nav
      v-if="blockEnabled('home.navigation')"
      id="nav"
      :data-template-variant="blockVariant('home.navigation')"
      :style="blockStyle('home.navigation')"
    >
      <div class="nav-inner">
        <a href="#hero" class="logo">
          <span class="logo-mark">T</span>
          TokEMS Demo
          <span class="logo-sub">2026 · 第二届</span>
        </a>
        <div class="nav-links">
          <a v-if="blockEnabled('home.value')" href="#why">为什么</a>
          <a v-if="blockEnabled('home.value')" href="#upgrade">第二届</a>
          <a v-if="blockEnabled('home.agenda')" href="#agenda">议程</a>
          <a v-if="blockEnabled('home.speakers')" href="#speakers">嘉宾</a>
          <a v-if="blockEnabled('home.tickets')" href="#tickets">门票</a>
          <a v-if="blockEnabled('home.faq-summary')" :href="faqHref">FAQ</a>
        </div>
        <div class="nav-cta">
          <a :href="registrationHref(primaryTicket.id)" class="btn btn-primary">
            <span>立即报名</span>
            <span class="nav-register-price">{{ money(primaryTicket.price) }}</span>
          </a>
          <CustomerAccountAction />
        </div>
      </div>
    </nav>

    <!-- ── HERO ── -->
    <section
      v-if="blockEnabled('home.hero')"
      id="hero"
      :data-template-variant="blockVariant('home.hero')"
      :style="blockStyle('home.hero')"
    >
      <div class="wrap hero-layout">
        <div class="hero-copy">
          <div class="hero-tag reveal in">
            <span class="hero-dot"></span>2026 · {{ event.city }} · {{ eventDate.compact }} ·
            报名进行中
          </div>
          <div class="hero-message">
            <h1 class="hero-h reveal in" data-d="1">
              <span class="title-line title-event">
                {{ heroTitlePrefix }}
                <span class="event-lock">{{ heroTitleEvent }}</span>
              </span>
              <span class="title-line title-slogan accent">{{ heroSlogan }}</span>
            </h1>
            <p class="hero-desc reveal in" data-d="2">
              从官网发布到现场核销，<strong>「清晰、可靠、可追踪」</strong>决定了每位参会者的体验。两天时间，
              与全球大会运营实践者一起拆解完整流程。
            </p>
          </div>
          <div class="hero-chips reveal in" data-d="2">
            <span class="chip"><span class="ic">◷</span><b>{{ eventDate.full }}</b>&nbsp;{{ eventDate.weekdays }}</span>
            <span class="chip"><span class="ic">◎</span><b>中国 · {{ event.city }}</b>&nbsp;{{ event.venue }}</span>
            <span class="chip"><span class="ic">✦</span>{{ primaryTicket.name }}&nbsp;<b>{{
              money(primaryTicket.price)
            }}</b></span>
          </div>
          <div class="hero-btns reveal in" data-d="3">
            <a :href="registrationHref(primaryTicket.id)" class="btn btn-primary">{{ heroPrimaryAction }} <span class="arr">→</span></a>
            <a href="#agenda" class="btn btn-outline">{{ heroSecondaryAction }}</a>
            <span class="hero-note">限量 {{ event.stats.seats }} 席 · 第一届全部售罄</span>
          </div>
        </div>
        <div class="hero-visual reveal in" data-d="2">
          <div class="answer-panel">
            <div class="answer-top">
              <span class="window-dots"><span></span><span></span><span></span></span>
              <span class="answer-title">Operations Snapshot</span>
            </div>
            <div class="answer-prompt">TokEMS Demo Conference · 现场运营概览</div>
            <div class="answer-body">
              <span class="answer-label">LIVE · 数据同步中</span>
              <p>官网、报名、支付、出票和现场核销汇集在同一条运营链路中：</p>
              <div class="answer-ranks">
                <div class="answer-rank">
                  <span class="rk">01</span><span><b>报名与票务</b> · 库存、候补和订单实时联动</span><small>稳定</small>
                </div>
                <div class="answer-rank">
                  <span class="rk">02</span><span><b>通知与发票</b> · 关键节点自动触达参会者</span><small>就绪</small>
                </div>
                <div class="answer-rank">
                  <span class="rk">03</span><span><b>现场核销</b> · 多设备并发与离线批次同步</span><small>在线</small>
                </div>
              </div>
            </div>
            <div class="answer-status">
              <span class="status-dot"></span>
              <div>
                <b>关键流程保持可见、可控、可追溯</b><small>运营团队可以在一个工作台完成协作与复盘。</small>
              </div>
            </div>
            <div class="answer-metrics">
              <span class="answer-metric"><b>{{ money(primaryTicket.price) }}</b><small>{{ primaryTicket.name }}</small></span>
              <span class="answer-metric"><b>{{ event.stats.seats }}+</b><small>限量席位</small></span>
              <span class="answer-metric"><b>{{ eventDate.opening }}</b><small>{{ event.city }}开幕</small></span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── STATS ── -->
    <div
      v-if="blockEnabled('home.stats')"
      class="stats-row"
      :data-template-variant="blockVariant('home.stats')"
      :style="blockStyle('home.stats')"
    >
      <div class="stats-grid">
        <div class="stat-item reveal">
          <div class="stat-num">{{ event.stats.days }}<em>天</em></div>
          <div class="stat-lbl">密集分享 + 实战工作坊</div>
        </div>
        <div class="stat-item reveal" data-d="1">
          <div class="stat-num">{{ event.stats.speakers }}<em>+</em></div>
          <div class="stat-lbl">一线专家与操盘手</div>
        </div>
        <div class="stat-item reveal" data-d="2">
          <div class="stat-num">{{ event.stats.seats }}<em>+</em></div>
          <div class="stat-lbl">创始人 / 高管 / 增长负责人</div>
        </div>
        <div class="stat-item reveal" data-d="3">
          <div class="stat-num">{{ primaryTicket.benefits.length }}<em>项</em></div>
          <div class="stat-lbl">参会权益打包带走</div>
        </div>
      </div>
    </div>
    <div v-if="blockEnabled('home.stats')" class="marquee" :style="blockStyle('home.stats')">
      <div class="marquee-track">
        <span>EVENT OPERATIONS</span><span>官网发布</span><span>报名交易</span><span>电子票</span><span>现场核销</span><span>通知触达</span><span>发票管理</span><span>全球协作</span><span>运营复盘</span> <span>EVENT OPERATIONS</span><span>官网发布</span><span>报名交易</span><span>电子票</span><span>现场核销</span><span>通知触达</span><span>发票管理</span><span>全球协作</span><span>运营复盘</span>
      </div>
    </div>

    <!-- ── WHY ── -->
    <section
      v-if="blockEnabled('home.value')"
      id="why"
      :data-template-variant="blockVariant('home.value')"
      :style="blockStyle('home.value')"
    >
      <div class="wrap">
        <div class="sec-head reveal">
          <span class="kicker">THE OPERATING SYSTEM</span>
          <h2 class="sec-title">一场大会，需要多条链路同时稳定运行</h2>
          <p class="sec-sub">
            内容、报名、交易、通知和现场履约共享同一份数据，团队才能快速判断并行动。
          </p>
        </div>
        <div class="why-layout">
          <div class="pain-list reveal">
            <div class="pain-item">
              <span class="pain-no">01</span>
              <div>
                <h4>官网与运营数据需要同步</h4>
                <p>议程、嘉宾、票种和报名状态来自同一发布快照，减少重复录入与版本偏差。</p>
              </div>
            </div>
            <div class="pain-item">
              <span class="pain-no">02</span>
              <div>
                <h4>交易链路需要一致性</h4>
                <p>报名、库存、订单、支付与出票在关键事务中协同，避免超卖和状态漂移。</p>
              </div>
            </div>
            <div class="pain-item">
              <span class="pain-no">03</span>
              <div>
                <h4>每次触达都需要可追踪</h4>
                <p>短信、邮件和 Webhook 通过 Outbox 投递，失败可重试，结果可以回查。</p>
              </div>
            </div>
            <div class="pain-item">
              <span class="pain-no">04</span>
              <div>
                <h4>现场高峰需要提前演练</h4>
                <p>设备令牌、离线批次和重复核销识别共同保障入场高峰的处理效率。</p>
              </div>
            </div>
            <div class="pain-item">
              <span class="pain-no">05</span>
              <div>
                <h4>复盘需要完整审计线索</h4>
                <p>重要操作、状态变化和运营指标集中留痕，为下一场大会积累可复用经验。</p>
              </div>
            </div>
          </div>
          <div class="ai-mock reveal" data-d="1">
            <div class="mock-bar">
              <span class="dot" style="background: #ff5f57"></span>
              <span class="dot" style="background: #febc2e"></span>
              <span class="dot" style="background: #28c840"></span>
              <span class="label">大会运营时间线</span>
            </div>
            <div class="mock-body">
              <div class="mock-q">TokEMS Demo Conference · 今日关键节点</div>
              <div class="mock-a">
                <span class="lbl">OPS · 实时状态</span>
                所有关键流程均在可观测范围内：
                <ol>
                  <li>
                    <span class="rk">1.</span><span><b>08:30</b> · 签到设备上线并完成令牌校验</span>
                  </li>
                  <li>
                    <span class="rk">2.</span><span><b>09:00</b> · 主会场开放，入场数据持续同步</span>
                  </li>
                  <li>
                    <span class="rk">3.</span><span><b>10:30</b> · 候补席位完成自动递补与通知</span>
                  </li>
                  <li class="miss">
                    <span class="rk">✓</span><span><b>运营台</b> · 当前无阻塞事件</span>
                  </li>
                </ol>
              </div>
            </div>
            <div class="mock-foot">
              统一的数据和审计链路，让运营团队能够更早发现问题并快速恢复。
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── UPGRADE ── -->
    <section
      v-if="blockEnabled('home.value')"
      id="upgrade"
      :data-template-variant="blockVariant('home.value')"
      :style="blockStyle('home.value')"
    >
      <div class="wrap">
        <div class="sec-head reveal">
          <span class="kicker">SECOND EDITION</span>
          <h2 class="sec-title">
            从零散工具走向统一工作台<br /><span style="color: var(--accent)">让每个环节都能协同</span>
          </h2>
          <p class="sec-sub">
            首届北京大会全场售罄之后，我们用一年时间收集了数百条参会者反馈。第二届，在每一个维度上全面升级。
          </p>
        </div>
        <div class="upgrade-grid">
          <div class="up-card reveal">
            <div class="up-compare">
              <span class="up-old">1 天</span><span class="up-arr">→</span><span class="up-new">2 天</span>
            </div>
            <h4>从听讲到上手</h4>
            <p>
              Day 1 战略与方法论密集输出，Day 2
              分会场实战工作坊，现场打开电脑，跑通自己的大会运营链路。
            </p>
          </div>
          <div class="up-card reveal" data-d="1">
            <div class="up-compare">
              <span class="up-old">20+ 专家</span><span class="up-arr">→</span><span class="up-new">40+ 专家</span>
            </div>
            <h4>从布道者到操盘手</h4>
            <p>新增主办方、场馆、票务、技术服务商和国际活动团队视角，覆盖大会运营全链路。</p>
          </div>
          <div class="up-card reveal" data-d="2">
            <div class="up-compare">
              <span class="up-old">300 席</span><span class="up-arr">→</span><span class="up-new">500 席</span>
            </div>
            <h4>从聚会到行业大会</h4>
            <p>移师深圳湾，主会场 + 双分会场 + 展区。粤港澳大湾区，离出海与 AI 产业最近的地方。</p>
          </div>
          <div class="up-card reveal">
            <div class="up-compare">
              <span class="up-old">方法分享</span><span class="up-arr">→</span><span class="up-new">行业基准</span>
            </div>
            <h4>首发《大会运营实践手册》</h4>
            <p>
              联合多家机构整理年度实践：行业数据、交付基准和服务标准，为运营团队提供可对照的尺子。
            </p>
          </div>
          <div class="up-card reveal" data-d="1">
            <div class="up-compare">
              <span class="up-old">案例讲述</span><span class="up-arr">→</span><span class="up-new">数据复盘</span>
            </div>
            <h4>真实账号 · 真实数据</h4>
            <p>
              多个团队现场拆解 12
              个月大会运营投入产出全过程：预算、人力、转化率与到场率，全部摊开讲。
            </p>
          </div>
          <div class="up-card reveal" data-d="2">
            <div class="up-compare">
              <span class="up-old">国内视角</span><span class="up-arr">→</span><span class="up-new">全球视野</span>
            </div>
            <h4>全球大会运营专场</h4>
            <p>围绕多语言内容、跨时区协作、海外支付与数据合规，分享国际活动的真实实践。</p>
          </div>
        </div>
        <div class="upgrade-quote reveal">
          <p>
            过去一年，大会运营从分散工具走向统一数据与自动化协作。第二届示例大会聚焦可复用流程、稳定交付和全球化能力，推动团队形成更清晰的运营标准。
          </p>
          <div class="by">， <b>Alex Chen · Maya Lee</b>&nbsp;&nbsp;TokEMS Demo 发起人</div>
        </div>
      </div>
    </section>

    <!-- ── AGENDA ── -->
    <section
      v-if="blockEnabled('home.agenda')"
      id="agenda"
      :data-template-variant="blockVariant('home.agenda')"
      :style="blockStyle('home.agenda')"
    >
      <div class="wrap">
        <div class="sec-head center reveal">
          <span class="kicker">AGENDA</span>
          <h2 class="sec-title">两天，三十余场密集输出</h2>
          <p class="sec-sub">
            Day 1 建立战略与方法论框架，Day 2 分会场实战深潜，从认知到动手，一气呵成。
          </p>
        </div>
        <div class="center reveal">
          <div class="day-tabs" role="tablist">
            <button
              v-for="day in days"
              :key="day"
              class="day-tab"
              :class="{ active: activeDay === day }"
              type="button"
              role="tab"
              :aria-selected="activeDay === day"
              @click="activeDay = day"
            >
              DAY {{ day }} · {{ day === 1 ? dayLabel(event.startsAt) : dayLabel(event.endsAt)
              }}<small>{{ day === 1 ? '战略与方法论主会场' : '实战工作坊 + 出海专场' }}</small>
            </button>
          </div>
        </div>
        <div class="day-panel active">
          <template v-for="entry in agendaEntries" :key="entry.key">
            <div v-if="entry.type === 'header'" class="ag-session">
              <span class="ag-session-tag">{{ entry.tag }}</span>
              <h4>{{ entry.title }}</h4>
              <span class="ag-time">{{ entry.range }}</span>
            </div>
            <div
              v-else
              class="ag-row"
              :class="{
                break: entry.session.kind === 'break',
                panel: entry.session.kind === 'workshop',
              }"
            >
              <span class="t">{{ entry.session.startsAt
              }}<template
                v-if="entry.session.endsAt && entry.session.endsAt !== entry.session.startsAt"
              >
                – {{ entry.session.endsAt }}</template></span>
              <span class="topic">{{ entry.session.title
              }}<small v-if="entry.session.summary">{{ entry.session.summary }}</small></span>
              <span class="who">{{ entry.session.speaker ?? '' }}</span>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ── SPEAKERS ── -->
    <section
      v-if="blockEnabled('home.speakers')"
      id="speakers"
      :data-template-variant="blockVariant('home.speakers')"
      :style="blockStyle('home.speakers')"
    >
      <div class="wrap">
        <div class="sec-head center reveal">
          <span class="kicker">SPEAKERS</span>
          <h2 class="sec-title">汇聚 40+ 国内外一线专家</h2>
          <p class="sec-sub">
            围绕活动策划、内容发布、报名交易、现场履约与全球协作，集中分享最新判断与真实案例。
          </p>
        </div>
        <div class="spk-grid">
          <div
            v-for="(speaker, index) in event.speakers"
            :key="speaker.id"
            class="spk-card reveal"
            :data-d="index % 4 || undefined"
          >
            <div class="spk-meta">
              <span class="spk-no">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="spk-kind">{{
                index < 13 ? 'Speaker' : index < 15 ? 'To be announced' : 'More soon'
              }}</span>
            </div>
            <h4>{{ speaker.name }}</h4>
            <div class="role">{{ speaker.role }}</div>
            <div class="spk-talk">{{ speaker.topic }}</div>
            <div class="spk-tags">
              <span v-for="tag in speaker.tags" :key="tag">{{ tag }}</span>
            </div>
          </div>
        </div>
        <div class="spk-more reveal">嘉宾阵容持续更新中 · 最终议程以现场为准</div>
      </div>
    </section>

    <!-- ── HOSTS ── -->
    <section
      v-if="blockEnabled('home.organizer')"
      id="hosts"
      :data-template-variant="blockVariant('home.organizer')"
      :style="blockStyle('home.organizer')"
    >
      <div class="wrap">
        <div class="sec-head reveal">
          <span class="kicker">INITIATORS</span>
          <h2 class="sec-title">两位深耕行业多年的实战者</h2>
          <p class="sec-sub">
            从活动策划到现场交付，两位发起人持续推动大会运营方法、工具和服务标准的开放交流。
          </p>
        </div>
        <div class="host-grid">
          <div class="host-card reveal">
            <div class="host-name">Alex Chen</div>
            <div class="host-role">TokEMS Demo 发起人 · 大型活动运营作者</div>
            <div class="host-bio">
              深耕活动产品与数字化交付多年，持续参与大型大会的内容发布、报名交易和现场履约，把一线经验带回这个讲台。
            </div>
            <div class="host-goal">目标：让每一位参会者都清楚「下周一回去该做什么」。</div>
          </div>
          <div class="host-card reveal" data-d="1">
            <div class="host-name">Maya Lee</div>
            <div class="host-role">TokEMS Demo 发起人 · 企业数字增长专家</div>
            <div class="host-bio">
              长期关注参会体验与跨团队协作，从第一届的 300 人到第二届的 500
              人，持续推动大会运营从单次交付走向可复用体系。
            </div>
            <div class="host-goal">目标：搭建让大会运营者持续交流、共同成长的开放平台。</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── TICKETS ── -->
    <section
      v-if="blockEnabled('home.tickets')"
      id="tickets"
      :data-template-variant="blockVariant('home.tickets')"
      :style="blockStyle('home.tickets')"
    >
      <div class="wrap">
        <div class="sec-head center reveal">
          <span class="kicker">TICKETS</span>
          <h2 class="sec-title">一张门票，八项权益</h2>
          <p class="sec-sub">
            统一票价 {{ money(primaryTicket.price) }}，两天议程、实战工作坊与会后学习资料均已包含
          </p>
        </div>
        <div class="ticket-layout">
          <div class="ticket-main reveal">
            <div class="ticket-purchase">
              <span class="ticket-badge">{{ primaryTicket.name }} · 限量 {{ event.stats.seats }} 席</span>
              <span class="price-label">统一票价</span>
              <div class="price-row">
                <span class="price-sym">¥</span><span class="price-num">{{
                  (primaryTicket.price / 100).toLocaleString('zh-CN')
                }}</span>
              </div>
              <div class="ticket-desc">
                {{ eventDate.compact }} · {{ event.city }}<br />一张票，全程参与两天大会
              </div>
              <a :href="registrationHref(primaryTicket.id)" class="btn btn-primary ticket-cta">{{
                                                                                                 primaryTicket.remaining > 0
                                                                                                   ? `立即报名 ${money(primaryTicket.price)}`
                                                                                                   : '加入候补名单'
                                                                                               }}
                <span class="arr">→</span></a>
              <div class="ticket-note">八项参会权益已全部包含</div>
            </div>
            <div class="ticket-benefits">
              <span class="benefit-eyebrow">{{ primaryTicket.benefits.length }} 项权益，全部包含</span>
              <h3>从现场参与到会后复训，一张票覆盖完整学习周期</h3>
              <ul class="perk-list">
                <li v-for="(benefit, index) in ticketBenefits" :key="benefit.title">
                  <span class="perk-no">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span><b>{{ benefit.title }}</b><small v-if="benefit.detail">{{ benefit.detail }}</small></span>
                </li>
              </ul>
            </div>
            <div class="ticket-assurances">
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>7 天安心退款</b>购票后 7 天内可无理由退款</span>
              </div>
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>参会人可转让</b>开幕 3 天前可免费更换参会人</span>
              </div>
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>支持开具发票</b>可申请增值税普通发票或专用发票</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── FAQ ── -->
    <section
      v-if="blockEnabled('home.faq-summary')"
      id="faq"
      :data-template-variant="blockVariant('home.faq-summary')"
      :style="blockStyle('home.faq-summary')"
    >
      <div class="wrap">
        <div class="sec-head center reveal">
          <span class="kicker">FAQ</span>
          <h2 class="sec-title">{{ experience.faq.title }}</h2>
          <p class="sec-sub">{{ experience.faq.introduction }}</p>
        </div>
        <div v-if="experience.faq.mode === 'home'" class="faq-wrap reveal">
          <div
            v-for="(faq, index) in enabledFaqs"
            :key="faq.nodeKey"
            class="faq-item"
            :class="{ open: openFaq === index }"
          >
            <button
              class="faq-q"
              type="button"
              :aria-expanded="openFaq === index"
              @click="openFaq = openFaq === index ? null : index"
            >
              {{ faq.question }}<span class="pm">＋</span>
            </button>
            <div class="faq-a" :style="{ maxHeight: openFaq === index ? '320px' : '0' }">
              <p>{{ faq.answer }}</p>
            </div>
          </div>
        </div>
        <div v-else class="faq-page-promo reveal">
          <div>
            <strong>{{ enabledFaqs.length }} 个问题，按报名、支付、发票与参会分类整理</strong>
            <p>支持关键词搜索与分类浏览，帮助参会者快速找到答案。</p>
          </div>
          <a :href="faqHref" class="btn btn-primary">打开 FAQ 页面 <span class="arr">→</span></a>
        </div>
      </div>
    </section>

    <!-- ── FINAL CTA ── -->
    <section
      v-if="blockEnabled('home.registration-cta')"
      id="final"
      :data-template-variant="blockVariant('home.registration-cta')"
      :style="blockStyle('home.registration-cta')"
    >
      <div class="wrap">
        <div class="reveal">
          <span class="kicker" style="justify-content: center; display: inline-flex">SEE YOU IN SHENZHEN</span>
          <h2>从线上报名到现场相见<br /><span class="accent">每一步都值得认真运营</span></h2>
          <p class="sub">
            {{ eventDate.compact }} · {{ event.city }} · 两日全通票
            {{ money(primaryTicket.price) }} · 限量 {{ event.stats.seats }} 席
          </p>
          <a
            :href="registrationHref(primaryTicket.id)"
            class="btn btn-primary"
            style="font-size: 16px; padding: 16px 44px"
          >{{
             primaryTicket.remaining > 0
               ? `立即报名 ${money(primaryTicket.price)}`
               : '加入候补名单'
           }}
            <span class="arr">→</span></a>
          <p style="margin-top: 20px; font-size: 12.5px; color: var(--ink-muted)">
            7 天无理由退款 · 支持转让 · 支持开票
          </p>
        </div>
      </div>
    </section>

    <footer
      v-if="blockEnabled('home.footer')"
      :data-template-variant="blockVariant('home.footer')"
      :style="blockStyle('home.footer')"
    >
      <div class="wrap foot-inner">
        <span>© 2026 TokEMS Demo 组委会 · {{ event.name }} · {{ event.city }}</span>
        <span>
          <a href="https://github.com/yaojingang/TokEMS" target="_blank" rel="noopener noreferrer">源代码与 AGPL-3.0 许可证</a>
          · 合作咨询 / 团队购票：请联系大会工作人员
        </span>
      </div>
    </footer>

    <div v-if="blockEnabled('home.registration-cta')" id="stickyBar">
      <div class="wrap sticky-in">
        <div>
          <div class="sticky-price">{{ money(primaryTicket.price) }}</div>
          <div class="sticky-desc">
            两日全通票 · {{ primaryTicket.benefits.length }} 项权益 · {{ eventDate.compact }}
            {{ event.city }}
          </div>
        </div>
        <a :href="registrationHref(primaryTicket.id)" class="btn btn-primary">{{
          primaryTicket.remaining > 0 ? '立即报名' : '加入候补'
        }}</a>
      </div>
    </div>
  </div>
</template>
