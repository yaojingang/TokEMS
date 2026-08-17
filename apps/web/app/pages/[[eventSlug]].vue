<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { createError, definePageMeta, useAsyncData, useRuntimeConfig } from '#imports';
import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  publicEventHomePath,
  publicEventScopedPath,
  speakerAvatarText,
  type EventPurchaseContext,
  type PublicEvent,
  type PublicEventMemberList,
  type Session,
} from '@conference/contracts';
import { resolveEventExperience } from '~/composables/useEventExperience';
import {
  loadMemberDirectoryWithFallback,
  startMemberDirectoryAutoRefresh,
} from '~/utils/member-directory-refresh';
import {
  isMemberDirectoryInitialLoading,
  resolveMemberDirectoryState,
} from '~/utils/member-directory-state';
import { attendeeAvatarInitial } from '~/utils/attendee-poster';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { readOrderAccessToken } from '~/composables/useOrderAccessToken';
import { resolveHomeRegistrationCta } from '~/utils/purchase-journey';
import {
  createPublicViewRecorder,
  formatTrackingStartDate,
  resolvePublicMetricFallbacks,
  splitMetricNumber,
} from '~/utils/public-event-metrics';

definePageMeta({ publicEventHome: true });

let countdown: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
let scrollHandler: (() => void) | undefined;
let accentClickHandler: ((event: MouseEvent) => void) | undefined;
let memberVisibilityHandler: (() => void) | undefined;
let memberRefreshController: ReturnType<typeof startMemberDirectoryAutoRefresh> | undefined;
const api = useConferenceApi();
const customer = useCustomerSession();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const event = api.eventState;
const purchaseContext = ref<EventPurchaseContext | null>(null);
const purchaseContextLoading = ref(false);
const purchaseContextFailed = ref(false);
let purchaseContextLoadKey = '';

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
    requestedEventSlug.value ? api.getEvent(requestedEventSlug.value) : api.getHomepageEvent(),
  { deep: false, watch: [eventRouteKey] },
);
if (eventLoadError.value) {
  const failure = eventLoadError.value as { statusCode?: number; status?: number };
  throw createError({
    statusCode: failure.statusCode ?? failure.status ?? 503,
    statusMessage:
      (failure.statusCode ?? failure.status) === 404
        ? '大会不存在或尚未发布'
        : '大会页面暂时不可用',
  });
}
if (loadedEvent.value) event.value = loadedEvent.value;
const livePublicMetrics = ref({ ...event.value.publicMetrics });
const activeDay = ref(1);
const openFaq = ref<number | null>(null);
const experience = computed(() => resolveEventExperience(event.value));
const homeBlocks = computed(() => experience.value.home.blocks);
const membersBlock = computed(() =>
  event.value.experience?.home?.blocks.find((block) => block.nodeKey === 'home.members'),
);
const membersBlockEnabled = computed(() => Boolean(membersBlock.value?.enabled));
const membersPage = ref(1);
const membersIndustry = ref('');
const defaultHomeBlocks =
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.kind === 'structured'
    ? DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home.blocks
    : [];
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
const registrationAction = computed(() => {
  const pendingOrderId = purchaseContext.value?.resumePaymentOrderId;
  const storedToken = pendingOrderId ? readOrderAccessToken(pendingOrderId) : '';
  return resolveHomeRegistrationCta({
    eventSlug: event.value.slug,
    ticketId: primaryTicket.value.id,
    priceLabel: money(primaryTicket.value.price),
    state:
      !customer.loaded.value || purchaseContextLoading.value
        ? 'loading'
        : !customer.session.value
          ? 'anonymous'
          : purchaseContextFailed.value
            ? 'failed'
            : 'ready',
    context: purchaseContext.value,
    ...(pendingOrderId && storedToken
      ? { resumePaymentHref: publicEventScopedPath(`/order/${pendingOrderId}`, event.value.slug) }
      : {}),
  });
});
const registrationActionLabel = computed(() =>
  registrationAction.value.kind === 'register' && primaryTicket.value.remaining < 1
    ? '加入候补名单'
    : registrationAction.value.label,
);
const faqHref = computed(() =>
  experience.value.faq.mode === 'page' ? publicEventScopedPath('/faq', event.value.slug) : '#faq',
);
const cooperationHref = computed(() =>
  publicEventScopedPath('/apply/cooperation', event.value.slug),
);
const homeBlock = (nodeKey: string) =>
  homeBlocks.value.find((block) => block.nodeKey === nodeKey) ??
  defaultHomeBlocks.find((block) => block.nodeKey === nodeKey);
const blockEnabled = (nodeKey: string) => homeBlock(nodeKey)?.enabled ?? true;
const blockStyle = (nodeKey: string) => {
  const eventOrder = homeBlocks.value.findIndex((block) => block.nodeKey === nodeKey);
  const defaultOrder = defaultHomeBlocks.findIndex((block) => block.nodeKey === nodeKey);
  return { order: Math.max(0, eventOrder >= 0 ? eventOrder : defaultOrder) };
};
const blockVariant = (nodeKey: string) => homeBlock(nodeKey)?.variant ?? 'default';
const blockCopy = (nodeKey: string, key: string, fallback: string) => {
  const value = homeBlock(nodeKey)?.content[key];
  if (typeof value === 'string') return value;
  const defaultValue = defaultHomeBlocks.find((block) => block.nodeKey === nodeKey)?.content[key];
  return typeof defaultValue === 'string' ? defaultValue : fallback;
};
const liveStatsEnabled = computed(
  () => blockEnabled('home.stats') && blockVariant('home.stats') === 'live',
);
const staticSessionCount = computed(() => {
  const configured = Number.parseInt(blockCopy('home.stats', 'sessionsValue', '30'), 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : event.value.sessions.length;
});
const liveMetricFallbacks = computed(() =>
  resolvePublicMetricFallbacks(livePublicMetrics.value, {
    speakers: event.value.stats.speakers,
    sessions: staticSessionCount.value,
  }),
);
const trackingStartDate = computed(() =>
  formatTrackingStartDate(livePublicMetrics.value.trackingStartedAt, event.value.timezone),
);
const pageViewDigits = computed(() => splitMetricNumber(livePublicMetrics.value.pageViews));
const liveStatsItems = computed(() => [
  {
    key: 'views',
    value: livePublicMetrics.value.pageViews,
    unit: '次',
    label: trackingStartDate.value
      ? `自 ${trackingStartDate.value} 起累计访问`
      : '大会官网累计访问',
  },
  {
    key: 'attendees',
    value: livePublicMetrics.value.confirmedAttendees,
    unit: '人',
    label: blockCopy('home.stats', 'confirmedAttendeesLabel', '已确认参会'),
  },
  {
    key: 'organizations',
    value: liveMetricFallbacks.value.organization.value,
    unit: liveMetricFallbacks.value.organization.unit,
    label: liveMetricFallbacks.value.organization.fallback
      ? blockCopy('home.stats', 'speakersLabel', '一线专家与操盘手')
      : blockCopy('home.stats', 'organizationsLabel', '参会企业与机构'),
  },
  {
    key: 'cities',
    value: liveMetricFallbacks.value.city.value,
    unit: liveMetricFallbacks.value.city.unit,
    label: liveMetricFallbacks.value.city.fallback
      ? blockCopy('home.stats', 'sessionsLabel', '主题分享与实战议程')
      : blockCopy('home.stats', 'citiesLabel', '参会者覆盖城市'),
  },
]);
const formatMetricNumber = (value: number) =>
  Math.max(0, Math.trunc(value)).toLocaleString('zh-CN');
const recordPublicViewOnce = createPublicViewRecorder((slug, pageViewId) =>
  api.recordPublicEventView(slug, pageViewId),
);
let publicMetricsMounted = false;
async function recordLivePublicView() {
  const result = await recordPublicViewOnce({
    slug: event.value.slug,
    variant: blockVariant('home.stats'),
    preview: route.query.preview,
  });
  if (!result) return;
  livePublicMetrics.value = {
    ...livePublicMetrics.value,
    pageViews: result.pageViews,
    trackingStartedAt: result.trackingStartedAt,
  };
}
const emptyMemberList = (): PublicEventMemberList => ({
  items: [],
  total: 0,
  overallTotal: 0,
  page: 1,
  pageSize: 40,
  totalPages: 1,
  categoryMode: false,
  industries: [],
});
const memberDirectorySnapshots = new Map<string, PublicEventMemberList>();
const {
  data: memberDirectory,
  pending: membersPending,
  refresh: refreshMemberDirectory,
} = await useAsyncData(
  () => `conference-members-${event.value.slug}`,
  async () => {
    if (!membersBlockEnabled.value) return emptyMemberList();
    const slug = event.value.slug;
    const page = membersPage.value;
    const industry = membersIndustry.value;
    const snapshotKey = `${slug}:${page}:${industry}`;
    const result = await loadMemberDirectoryWithFallback(
      () => api.getEventMembers(slug, page, industry || undefined),
      memberDirectorySnapshots.get(snapshotKey) ?? emptyMemberList(),
    );
    memberDirectorySnapshots.set(snapshotKey, result);
    return result;
  },
  { watch: [eventRouteKey, membersBlockEnabled, membersPage, membersIndustry] },
);
const membersInitialLoading = computed(() =>
  isMemberDirectoryInitialLoading(membersPending.value, Boolean(memberDirectory.value)),
);
let memberNavigationPending = false;
const selectMemberIndustry = (code: string) => {
  if (membersIndustry.value === code) return;
  memberNavigationPending = true;
  membersIndustry.value = code;
  membersPage.value = 1;
};
const changeMembersPage = (change: number) => {
  const target = Math.min(
    Math.max(1, membersPage.value + change),
    memberDirectory.value?.totalPages ?? 1,
  );
  if (target === membersPage.value) return;
  memberNavigationPending = true;
  membersPage.value = target;
};
const memberTotal = computed(() => memberDirectory.value?.overallTotal ?? 0);
const memberDirectoryState = computed(() =>
  resolveMemberDirectoryState(
    membersBlockEnabled.value,
    membersInitialLoading.value,
    memberDirectory.value?.total ?? 0,
  ),
);
const heroPrimaryAction = computed(() =>
  registrationAction.value.kind === 'register'
    ? blockCopy('home.hero', 'primaryAction', registrationActionLabel.value)
    : registrationActionLabel.value,
);
const heroSecondaryAction = computed(() =>
  blockCopy('home.hero', 'secondaryAction', '查看两日议程'),
);
const heroTitlePrefix = computed(() => blockCopy('home.hero', 'titlePrefix', '第二届中国'));
const heroTitleEvent = computed(() => blockCopy('home.hero', 'titleEvent', 'GEO & AI 营销大会'));
const heroSlogan = computed(() => blockCopy('home.hero', 'slogan', '让好的品牌被 AI 正确推荐'));
const valueItems = computed(() =>
  [
    [
      '决策入口正在迁移',
      '越来越多用户跳过搜索结果页，直接向 ChatGPT、DeepSeek、豆包、Kimi 要答案。AI 给出的三个推荐，就是用户的全部候选名单。',
    ],
    [
      '你的品牌可能正在被 AI 忽略',
      'AI 回答中没有你，意味着你在新入口完全缺席；AI 引用了错误信息，比缺席更危险。',
    ],
    [
      'SEO 经验还在，但规则已经变了',
      '排名逻辑正在向「引用逻辑」迁移：AI 不看第几名，它看谁可信、谁结构清晰、谁被反复印证。',
    ],
    [
      '窗口期红利只属于先行动的人',
      '第一届大会之后，先做 GEO 的企业已经在 AI 回答中建立了占位。窗口仍在，但正在收窄。',
    ],
    [
      '单点技巧不够，需要一套体系',
      '从内容资产、知识库、结构化数据到效果监测——GEO 是一条完整的工程链路。',
    ],
  ].map(([title, body], index) => ({
    title: blockCopy('home.value', `item${index + 1}Title`, title!),
    body: blockCopy('home.value', `item${index + 1}Body`, body!),
  })),
);
const upgradeItems = computed(() =>
  [
    [
      '1 天',
      '2 天',
      '从听讲到上手',
      'Day 1 战略与方法论密集输出，Day 2 分会场实战工作坊——现场打开电脑，跑通你自己的 GEO 链路。',
    ],
    [
      '20+ 专家',
      '40+ 专家',
      '从布道者到操盘手',
      '新增大模型平台视角、上市公司 CMO、出海一线操盘手与 Agent 生态创业者，覆盖 GEO 全产业链。',
    ],
    [
      '北京单会场',
      '深圳多会场',
      '从聚会到行业大会',
      '移师深圳湾，主会场 + 双分会场 + 展区。粤港澳大湾区，离出海与 AI 产业最近的地方。',
    ],
    [
      '方法分享',
      '行业基准',
      '首发《中国GEO行业白皮书》',
      '联合多家机构发布年度白皮书：行业数据、效果基准、服务标准——给中国 GEO 一把可对照的尺子。',
    ],
    [
      '案例讲述',
      '数据复盘',
      '真实账号 · 真实数据',
      '多个标杆企业现场拆解 12 个月 GEO 投入产出全过程：预算、人力、内容量、引用率曲线，全部摊开讲。',
    ],
    [
      '国内视角',
      '全球视野',
      '出海 GEO 专场',
      'ChatGPT、Gemini、Perplexity 引用机制逆向研究 + 出海品牌实战，帮中国品牌占领全球 AI 答案。',
    ],
  ].map(([oldValue, newValue, title, body], index) => ({
    oldValue: blockCopy(
      'home.upgrade',
      index === 2 ? 'item3OldVenue' : `item${index + 1}Old`,
      oldValue!,
    ),
    newValue: blockCopy(
      'home.upgrade',
      index === 2 ? 'item3NewVenue' : `item${index + 1}New`,
      newValue!,
    ),
    title: blockCopy('home.upgrade', `item${index + 1}Title`, title!),
    body: blockCopy('home.upgrade', `item${index + 1}Body`, body!),
  })),
);
const hosts = computed(() =>
  [
    {
      name: '姚金刚',
      role: 'GEO大会发起人 · 《AI营销：从SEO到GEO》作者',
      bio: '深耕搜索与增长领域十余年，国内最早系统研究 GEO 方法论的实践者之一。首届大会后持续服务数十家企业的 GEO 落地，把一线踩过的坑和跑通的路，全部带回这个讲台。',
      goal: '目标：让每一位参会者都清楚「下周一回去该做什么」。',
    },
    {
      name: '乔向阳',
      role: 'GEO大会发起人 · 企业数字增长专家',
      bio: '长期关注企业数字增长与品牌建设，坚信 GEO 是未来三年品牌竞争力的关键变量，持续推动中国 GEO 从聚会走向行业共同体。',
      goal: '目标：搭建让 GEO 从业者持续交流、共同成长的行业平台。',
    },
  ].map((host, index) => ({
    name: blockCopy('home.organizer', `host${index + 1}Name`, host.name),
    role: blockCopy('home.organizer', `host${index + 1}Role`, host.role),
    bio: blockCopy(
      'home.organizer',
      index === 1 ? 'host2Summary' : `host${index + 1}Bio`,
      host.bio,
    ),
    goal: blockCopy('home.organizer', `host${index + 1}Goal`, host.goal),
  })),
);
const marqueeItems = computed(() =>
  [
    'GENERATIVE ENGINE OPTIMIZATION',
    '被 AI 看见',
    '被 AI 理解',
    '被 AI 推荐',
    'AI SEARCH',
    '品牌占位',
    'AGENT 营销',
    '出海 GEO',
    '内容资产',
  ].map((item, index) => blockCopy('home.stats', `marquee${index + 1}`, item)),
);
const ticketBenefitDetails = computed(() =>
  [
    '主会场与双分会场任意进出',
    '完成企业 90 天行动计划',
    '完整版现场首发',
    '含 27 套 GEO 提示词合集',
    '会前预习与会后复训',
    '会后 3 个工作日发放',
    '全年案例拆解与工具更新',
    '含 1 次线上复盘直播 QA',
  ].map((item, index) => blockCopy('home.tickets', `benefit${index + 1}Detail`, item)),
);
const ticketBenefits = computed(() =>
  primaryTicket.value.benefits.map((title, index) => ({
    title,
    detail: ticketBenefitDetails.value[index] ?? '',
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

const agendaHeaders = computed(() => [
  {
    day: 1,
    beforeTitle: '开幕致辞：中国 GEO 的第二年',
    tag: blockCopy('home.agenda', 'day1MorningTag', '上午场'),
    title: blockCopy('home.agenda', 'day1MorningTitle', 'GEO 战略 · 趋势与全景'),
    range: blockCopy('home.agenda', 'day1MorningRange', '09:00 – 12:10'),
  },
  {
    day: 1,
    beforeTitle: '12 个月 GEO 投入产出全复盘',
    tag: blockCopy('home.agenda', 'day1AfternoonTag', '下午场'),
    title: blockCopy('home.agenda', 'day1AfternoonTitle', 'GEO 实战 · 企业与数据'),
    range: blockCopy('home.agenda', 'day1AfternoonRange', '13:30 – 18:00'),
  },
  {
    day: 2,
    beforeTitle: '工作坊 ①：你的品牌 AI 可见度诊断',
    tag: blockCopy('home.agenda', 'day2WorkshopTag', 'A 会场'),
    title: blockCopy('home.agenda', 'day2WorkshopTitle', '实战工作坊 · 带电脑上手'),
    range: blockCopy('home.agenda', 'day2WorkshopRange', '09:00 – 12:30'),
  },
  {
    day: 2,
    beforeTitle: '2027 出海 GEO 新趋势',
    tag: blockCopy('home.agenda', 'day2GlobalTag', 'B 会场'),
    title: blockCopy('home.agenda', 'day2GlobalTitle', '出海 GEO 专场'),
    range: blockCopy('home.agenda', 'day2GlobalRange', '09:00 – 12:30'),
  },
  {
    day: 2,
    beforeTitle: 'AI Agent 时代的内容分发',
    tag: blockCopy('home.agenda', 'day2ClosingTag', '主会场'),
    title: blockCopy('home.agenda', 'day2ClosingTitle', '前沿与未来 · 闭幕'),
    range: blockCopy('home.agenda', 'day2ClosingRange', '14:00 – 17:30'),
  },
]);
const agendaEntries = computed<AgendaEntry[]>(() =>
  activeSessions.value.flatMap((session) => {
    const header = agendaHeaders.value.find(
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
  livePublicMetrics.value = { ...loaded.publicMetrics };
  membersPage.value = 1;
  membersIndustry.value = '';
  activeDay.value = days.value[0] ?? 1;
  await nextTick();
  document.querySelectorAll('.reveal:not(.in)').forEach((element) => observer?.observe(element));
  if (publicMetricsMounted) void recordLivePublicView();
});

watch(memberDirectory, async (directory) => {
  if (!directory) return;
  if (!directory.categoryMode && membersIndustry.value) {
    membersIndustry.value = '';
    return;
  }
  if (membersPage.value > directory.totalPages) {
    membersPage.value = directory.totalPages;
    return;
  }
  if (!import.meta.client) return;
  await nextTick();
  document.querySelectorAll('.reveal:not(.in)').forEach((element) => observer?.observe(element));
  if (!memberNavigationPending) return;
  memberNavigationPending = false;
  const results = document.querySelector<HTMLElement>('#members .member-grid');
  results?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  results?.focus({ preventScroll: true });
});

async function loadPurchaseContext() {
  if (!import.meta.client || !customer.loaded.value) return;
  if (!customer.session.value) {
    purchaseContext.value = null;
    purchaseContextFailed.value = false;
    purchaseContextLoadKey = '';
    return;
  }
  const key = `${customer.session.value.customer.id}:${event.value.id}`;
  if (key === purchaseContextLoadKey) return;
  purchaseContextLoadKey = key;
  purchaseContextLoading.value = true;
  purchaseContextFailed.value = false;
  try {
    purchaseContext.value = await customer.purchaseContext(event.value.id);
  } catch {
    purchaseContext.value = null;
    purchaseContextFailed.value = true;
  } finally {
    purchaseContextLoading.value = false;
  }
}

watch(
  () => [customer.loaded.value, customer.session.value?.customer.id, event.value.id],
  () => void loadPurchaseContext(),
  { flush: 'post' },
);

onMounted(async () => {
  publicMetricsMounted = true;
  void recordLivePublicView();
  await customer.refresh().catch(() => null);
  await loadPurchaseContext();
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

  memberRefreshController = startMemberDirectoryAutoRefresh(
    refreshMemberDirectory,
    () =>
      membersBlockEnabled.value && !membersPending.value && document.visibilityState === 'visible',
  );
  memberVisibilityHandler = () => {
    if (document.visibilityState === 'visible') memberRefreshController?.refreshIfNeeded();
  };
  document.addEventListener('visibilitychange', memberVisibilityHandler);

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
  publicMetricsMounted = false;
  if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
  if (accentClickHandler) document.removeEventListener('click', accentClickHandler);
  if (countdown) clearInterval(countdown);
  if (memberVisibilityHandler) {
    document.removeEventListener('visibilitychange', memberVisibilityHandler);
  }
  memberRefreshController?.stop();
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
          <span class="logo-mark">{{ blockCopy('home.navigation', 'logoMark', 'G') }}</span>
          {{ blockCopy('home.navigation', 'brandLabel', 'GEO大会') }}
          <span class="logo-sub">{{
            blockCopy('home.navigation', 'brandMeta', '2026 · 第二届')
          }}</span>
        </a>
        <div class="nav-links">
          <a v-if="blockEnabled('home.value')" href="#why">{{
            blockCopy('home.navigation', 'whyLabel', '为什么')
          }}</a>
          <a v-if="blockEnabled('home.upgrade')" href="#upgrade">{{
            blockCopy('home.navigation', 'editionLabel', '第二届')
          }}</a>
          <a v-if="blockEnabled('home.agenda')" href="#agenda">{{
            blockCopy('home.navigation', 'agendaLabel', '议程')
          }}</a>
          <a v-if="blockEnabled('home.speakers')" href="#speakers">{{
            blockCopy('home.navigation', 'speakersLabel', '嘉宾')
          }}</a>
          <a v-if="memberDirectoryState.visible" href="#members">报名会员</a>
          <a v-if="blockEnabled('home.tickets')" href="#tickets">{{
            blockCopy('home.navigation', 'ticketsLabel', '门票')
          }}</a>
          <a v-if="blockEnabled('home.cooperation')" :href="cooperationHref">{{
            blockCopy('home.navigation', 'cooperationLabel', '合作')
          }}</a>
          <a v-if="blockEnabled('home.faq-summary')" :href="faqHref">{{
            blockCopy('home.navigation', 'faqLabel', 'FAQ')
          }}</a>
        </div>
        <div class="nav-cta">
          <a
            :href="registrationAction.href"
            class="btn btn-primary"
            :class="{ 'is-context-loading': registrationAction.kind === 'loading' }"
            :aria-disabled="registrationAction.kind === 'loading'"
            @click="registrationAction.kind === 'loading' && $event.preventDefault()"
          >
            <span>{{ registrationActionLabel }}</span>
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
              {{ blockCopy('home.hero', 'descriptionLead', '当十亿用户开始向 AI 提问，')
              }}<strong>{{
                blockCopy('home.hero', 'descriptionStrong', '「被引用、被理解、被推荐」')
              }}</strong>{{
                blockCopy(
                  'home.hero',
                  'descriptionTail',
                  '就是新的流量入口。两天时间，与中国 GEO 最前沿的实践者站在一起。',
                )
              }}
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
            <a
              :href="registrationAction.href"
              class="btn btn-primary"
              :class="{ 'is-context-loading': registrationAction.kind === 'loading' }"
              :aria-disabled="registrationAction.kind === 'loading'"
              @click="registrationAction.kind === 'loading' && $event.preventDefault()"
            >{{ heroPrimaryAction }} <span class="arr">→</span></a>
            <a href="#agenda" class="btn btn-outline">{{ heroSecondaryAction }}</a>
            <span class="hero-note">{{ blockCopy('home.hero', 'note', '第一届全部售罄') }}</span>
          </div>
        </div>
        <div class="hero-visual reveal in" data-d="2">
          <div class="answer-panel">
            <div class="answer-top">
              <span class="window-dots"><span></span><span></span><span></span></span>
              <span class="answer-title">{{
                blockCopy('home.hero', 'answerTitle', 'AI Answer Preview')
              }}</span>
            </div>
            <div class="answer-prompt">
              {{
                blockCopy('home.hero', 'answerPrompt', '帮我推荐几个适合企业增长负责人的 GEO 大会')
              }}
            </div>
            <div class="answer-body">
              <span class="answer-label">{{
                blockCopy('home.hero', 'answerLabel', 'AI · 正在生成回答')
              }}</span>
              <p>
                {{
                  blockCopy(
                    'home.hero',
                    'answerIntroduction',
                    '如果你想系统理解 AI 搜索、品牌引用与内容资产建设，优先关注这些信息密度高、案例真实的活动：',
                  )
                }}
              </p>
              <div class="answer-ranks">
                <div class="answer-rank">
                  <span class="rk">01</span><span><b>{{ blockCopy('home.hero', 'answerRank1Title', 'GEO大会 2026') }}</b> ·
                    {{ blockCopy('home.hero', 'answerRank1Body', '深圳两日主会场 + 工作坊') }}</span><small>{{ blockCopy('home.hero', 'answerRank1Badge', '推荐') }}</small>
                </div>
                <div class="answer-rank">
                  <span class="rk">02</span><span><b>{{ blockCopy('home.hero', 'answerRank2Title', '行业白皮书首发') }}</b> ·
                    {{ blockCopy('home.hero', 'answerRank2Body', '平台引用机制与效果基准') }}</span><small>{{ blockCopy('home.hero', 'answerRank2Badge', '可信源') }}</small>
                </div>
                <div class="answer-rank">
                  <span class="rk">03</span><span><b>{{ blockCopy('home.hero', 'answerRank3Title', '40+ 实战嘉宾') }}</b> ·
                    {{
                      blockCopy('home.hero', 'answerRank3Body', '品牌方、服务商、平台视角')
                    }}</span><small>{{ blockCopy('home.hero', 'answerRank3Badge', '案例') }}</small>
                </div>
              </div>
            </div>
            <div class="answer-status">
              <span class="status-dot"></span>
              <div>
                <b>{{
                  blockCopy('home.hero', 'answerStatusTitle', '目标不是曝光，是进入 AI 的候选答案')
                }}</b><small>{{
                  blockCopy(
                    'home.hero',
                    'answerStatusBody',
                    '让品牌资料、案例和可信来源被模型正确理解。',
                  )
                }}</small>
              </div>
            </div>
            <div class="answer-metrics">
              <span class="answer-metric"><b>{{ money(primaryTicket.price) }}</b><small>{{ blockCopy('home.hero', 'priceMetricLabel', '两日通票') }}</small></span>
              <span class="answer-metric"><b>40+</b><small>{{ blockCopy('home.hero', 'topicsMetricLabel', '干货主题') }}</small></span>
              <span class="answer-metric"><b>{{ eventDate.opening }}</b><small>{{ event.city
              }}{{ blockCopy('home.hero', 'openingMetricSuffix', '开幕') }}</small></span>
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
        <template v-if="liveStatsEnabled">
          <div
            v-for="(item, index) in liveStatsItems"
            :key="item.key"
            class="stat-item reveal"
            :data-d="index || undefined"
          >
            <div
              v-if="item.key === 'views'"
              class="stat-num stat-num-live"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              :aria-label="`${item.value} 次，${item.label}`"
            >
              <span aria-hidden="true">{{ pageViewDigits.prefix }}</span>
              <span class="stat-digit-slot" aria-hidden="true">
                <Transition name="stat-digit">
                  <span :key="item.value" class="stat-digit">{{ pageViewDigits.lastDigit }}</span>
                </Transition>
              </span>
              <em aria-hidden="true">{{ item.unit }}</em>
            </div>
            <div v-else class="stat-num">
              {{ formatMetricNumber(item.value) }}<em>{{ item.unit }}</em>
            </div>
            <div class="stat-lbl">{{ item.label }}</div>
          </div>
        </template>
        <template v-else>
          <div class="stat-item reveal">
            <div class="stat-num">{{ event.stats.days }}<em>天</em></div>
            <div class="stat-lbl">
              {{ blockCopy('home.stats', 'daysLabel', '密集分享 + 实战工作坊') }}
            </div>
          </div>
          <div class="stat-item reveal" data-d="1">
            <div class="stat-num">{{ event.stats.speakers }}<em>+</em></div>
            <div class="stat-lbl">
              {{ blockCopy('home.stats', 'speakersLabel', '一线专家与操盘手') }}
            </div>
          </div>
          <div class="stat-item reveal" data-d="2">
            <div class="stat-num">
              {{ blockCopy('home.stats', 'sessionsValue', '30') }}<em>+</em>
            </div>
            <div class="stat-lbl">
              {{ blockCopy('home.stats', 'sessionsLabel', '主题分享与实战议程') }}
            </div>
          </div>
          <div class="stat-item reveal" data-d="3">
            <div class="stat-num">{{ primaryTicket.benefits.length }}<em>项</em></div>
            <div class="stat-lbl">
              {{ blockCopy('home.stats', 'benefitsLabel', '参会权益打包带走') }}
            </div>
          </div>
        </template>
      </div>
    </div>
    <div v-if="blockEnabled('home.stats')" class="marquee" :style="blockStyle('home.stats')">
      <div class="marquee-track">
        <template v-for="copy in 2" :key="copy">
          <span v-for="item in marqueeItems" :key="copy + '-' + item">{{ item }}</span>
        </template>
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
          <span class="kicker">{{ blockCopy('home.value', 'kicker', 'THE SHIFT') }}</span>
          <h2 class="sec-title">
            {{ blockCopy('home.value', 'title', 'AI 正在改写「被发现」的规则') }}
          </h2>
          <p class="sec-sub">
            {{
              blockCopy(
                'home.value',
                'subtitle',
                '搜索框正在让位给对话框。当用户开始问 AI「推荐一个……」，你的品牌是否有资格出现在那条回答里',
              )
            }}
          </p>
        </div>
        <div class="why-layout">
          <div class="pain-list reveal">
            <div v-for="(item, index) in valueItems" :key="item.title" class="pain-item">
              <span class="pain-no">{{ String(index + 1).padStart(2, '0') }}</span>
              <div>
                <h4>{{ item.title }}</h4>
                <p>{{ item.body }}</p>
              </div>
            </div>
          </div>
          <div class="ai-mock reveal" data-d="1">
            <div class="mock-bar">
              <span class="dot" style="background: #ff5f57"></span>
              <span class="dot" style="background: #febc2e"></span>
              <span class="dot" style="background: #28c840"></span>
              <span class="label">{{ blockCopy('home.value', 'mockTitle', 'AI 回答示意') }}</span>
            </div>
            <div class="mock-body">
              <div class="mock-q">
                {{ blockCopy('home.value', 'mockPrompt', '帮我推荐几个适合 B2B 企业的营销服务商') }}
              </div>
              <div class="mock-a">
                <span class="lbl">{{
                  blockCopy('home.value', 'mockLabel', 'AI · 正在生成回答')
                }}</span>
                {{
                  blockCopy(
                    'home.value',
                    'mockIntroduction',
                    '根据公开资料与行业最佳实践，为你推荐：',
                  )
                }}
                <ol>
                  <li>
                    <span class="rk">1.</span><span><b>{{ blockCopy('home.value', 'mockRank1Title', '品牌 A') }}</b> —
                      {{
                        blockCopy(
                          'home.value',
                          'mockRank1Body',
                          '全链路营销自动化，多家上市公司案例…',
                        )
                      }}</span>
                  </li>
                  <li>
                    <span class="rk">2.</span><span><b>{{ blockCopy('home.value', 'mockRank2Title', '品牌 B') }}</b> —
                      {{
                        blockCopy(
                          'home.value',
                          'mockRank2Body',
                          '数据驱动增长平台，多行业报告引用…',
                        )
                      }}</span>
                  </li>
                  <li>
                    <span class="rk">3.</span><span><b>{{ blockCopy('home.value', 'mockRank3Title', '品牌 C') }}</b> —
                      {{
                        blockCopy(
                          'home.value',
                          'mockRank3Body',
                          '垂直行业口碑领先，知识库结构完善…',
                        )
                      }}</span>
                  </li>
                  <li class="miss">
                    <span class="rk">✕</span><span><b>{{ blockCopy('home.value', 'mockMissingTitle', '你的品牌') }}</b> —
                      {{
                        blockCopy('home.value', 'mockMissingBody', '未被引用，未出现在回答中')
                      }}</span>
                  </li>
                </ol>
              </div>
            </div>
            <div class="mock-foot">
              {{
                blockCopy(
                  'home.value',
                  'mockFoot',
                  '如果你的品牌不在 AI 的回答里，你正在把一个全新的获客入口整体让给竞争对手。',
                )
              }}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── UPGRADE ── -->
    <section
      v-if="blockEnabled('home.upgrade')"
      id="upgrade"
      :data-template-variant="blockVariant('home.upgrade')"
      :style="blockStyle('home.upgrade')"
    >
      <div class="wrap">
        <div class="sec-head reveal">
          <span class="kicker">{{ blockCopy('home.upgrade', 'kicker', 'SECOND EDITION') }}</span>
          <h2 class="sec-title">
            {{ blockCopy('home.upgrade', 'titleLine1', '第一届回答「GEO 是什么」') }}<br /><span
              style="color: var(--accent)"
            >{{ blockCopy('home.upgrade', 'titleLine2', '第二届回答「GEO 怎么赢」') }}</span>
          </h2>
          <p class="sec-sub">
            {{
              blockCopy(
                'home.upgrade',
                'subtitle',
                '首届北京大会全场售罄之后，我们用一年时间收集了数百条参会者反馈。第二届，在每一个维度上全面升级',
              )
            }}
          </p>
        </div>
        <div class="upgrade-grid">
          <div
            v-for="(item, index) in upgradeItems"
            :key="item.title"
            class="up-card reveal"
            :data-d="index % 3 || undefined"
          >
            <div class="up-compare">
              <span class="up-old">{{ item.oldValue }}</span><span class="up-arr">→</span><span class="up-new">{{ item.newValue }}</span>
            </div>
            <h4>{{ item.title }}</h4>
            <p>{{ item.body }}</p>
          </div>
        </div>
        <div class="upgrade-quote reveal">
          <p>
            {{
              blockCopy(
                'home.upgrade',
                'quote',
                '过去一年，中国 GEO 从概念走向实践。企业竞争的焦点，正在从搜索时代的「被看见」，升级为生成式时代的「被理解、被引用、被推荐」。第二届大会的使命，是推动中国 GEO 从零散探索，走向更系统、更专业、更具共识的阶段。',
              )
            }}
          </p>
          <div class="by">
            —— <b>{{ blockCopy('home.upgrade', 'attributionNames', '姚金刚 · 乔向阳') }}</b>&nbsp;&nbsp;{{ blockCopy('home.upgrade', 'attributionRole', 'GEO大会发起人') }}
          </div>
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
          <span class="kicker">{{ blockCopy('home.agenda', 'kicker', 'AGENDA') }}</span>
          <h2 class="sec-title">
            {{ blockCopy('home.agenda', 'title', '两天，三十余场密集输出') }}
          </h2>
          <p class="sec-sub">
            {{
              blockCopy(
                'home.agenda',
                'subtitle',
                'Day 1 建立战略与方法论框架，Day 2 分会场实战深潜——从认知到动手，一气呵成',
              )
            }}
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
              }}<small>{{
                day === 1
                  ? blockCopy('home.agenda', 'day1Subtitle', '战略与方法论主会场')
                  : blockCopy('home.agenda', 'day2Subtitle', '实战工作坊 + 出海专场')
              }}</small>
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
          <span class="kicker">{{ blockCopy('home.speakers', 'kicker', 'SPEAKERS') }}</span>
          <h2 class="sec-title">
            {{ blockCopy('home.speakers', 'title', '汇聚 40+ 国内外一线专家') }}
          </h2>
          <p class="sec-sub">
            {{
              blockCopy(
                'home.speakers',
                'subtitle',
                '围绕 AI 营销、Agent 生态、AI 搜索、内容工程与品牌占位，集中分享最新判断与真实案例',
              )
            }}
          </p>
        </div>
        <div class="spk-grid">
          <NuxtLink
            v-for="(speaker, index) in event.speakers"
            :key="speaker.id"
            class="spk-card reveal"
            :data-d="index % 4 || undefined"
            :to="publicEventScopedPath(`/speakers/${encodeURIComponent(speaker.id)}`, event.slug)"
            :aria-label="`查看嘉宾 ${speaker.name} 的详情`"
          >
            <div class="spk-meta">
              <span class="spk-no">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="spk-kind">{{
                index < 13 ? 'Speaker' : index < 15 ? 'To be announced' : 'More soon'
              }}</span>
            </div>
            <div class="spk-profile">
              <div class="spk-avatar" :style="{ '--spk-accent': speaker.accentFrom }">
                <img
                  v-if="speaker.avatarUrl"
                  :src="speaker.avatarUrl"
                  :alt="`${speaker.name}的头像`"
                  width="56"
                  height="56"
                  loading="lazy"
                />
                <span v-else aria-hidden="true">
                  {{ speakerAvatarText(speaker.name, speaker.initials) }}
                </span>
              </div>
              <div>
                <h4>{{ speaker.name }}</h4>
                <div class="role">{{ speaker.role }}</div>
              </div>
            </div>
            <div class="spk-talk">{{ speaker.topic }}</div>
            <div class="spk-tags">
              <span v-for="tag in speaker.tags" :key="tag">{{ tag }}</span>
            </div>
            <span class="spk-open" aria-hidden="true">查看资料 →</span>
          </NuxtLink>
        </div>
        <div class="spk-more reveal">
          {{ blockCopy('home.speakers', 'moreLabel', '嘉宾阵容持续更新中 · 最终议程以现场为准') }}
        </div>
      </div>
    </section>

    <!-- ── REGISTERED MEMBERS ── -->
    <section
      v-if="memberDirectoryState.visible"
      id="members"
      :data-template-variant="membersBlock?.variant ?? 'editorial-grid'"
      :style="blockStyle('home.members')"
    >
      <div class="wrap">
        <div class="sec-head reveal member-head">
          <div>
            <span class="kicker">{{ blockCopy('home.members', 'kicker', 'ATTENDEES') }}</span>
            <h2 class="sec-title">
              {{ blockCopy('home.members', 'title', '和同行者，在大会前先认识') }}
            </h2>
            <p class="sec-sub">
              {{
                blockCopy(
                  'home.members',
                  'subtitle',
                  '已报名并主动公开参会名片的会员，将按报名顺序在这里出现',
                )
              }}
            </p>
          </div>
          <div v-if="memberTotal" class="member-count">
            <span>已公开</span>
            <strong>{{ memberTotal }}</strong>
            <span>位会员</span>
          </div>
        </div>

        <div
          v-if="memberDirectory?.categoryMode"
          class="member-industries"
          role="tablist"
          aria-label="按行业筛选报名会员"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="membersIndustry === ''"
            :class="{ active: membersIndustry === '' }"
            @click="selectMemberIndustry('')"
          >
            全部 <span>{{ memberTotal }}</span>
          </button>
          <button
            v-for="industry in memberDirectory.industries"
            :key="industry.code"
            type="button"
            role="tab"
            :aria-selected="membersIndustry === industry.code"
            :class="{ active: membersIndustry === industry.code }"
            @click="selectMemberIndustry(industry.code)"
          >
            {{ industry.label }} <span>{{ industry.count }}</span>
          </button>
        </div>

        <div v-if="membersInitialLoading" class="member-loading" role="status">
          正在更新报名会员…
        </div>
        <div v-else-if="memberDirectoryState.empty" class="member-empty" role="status">
          <span aria-hidden="true">MEMBER DIRECTORY</span>
          <strong>{{
            blockCopy('home.members', 'emptyText', '报名会员正在陆续完善参会名片')
          }}</strong>
          <p>完成报名并公开参会名片后，将按报名顺序展示在这里。</p>
        </div>
        <div v-else class="member-grid" tabindex="-1">
          <a
            v-for="member in memberDirectory?.items ?? []"
            :key="member.publicSlug"
            class="member-tile"
            :href="
              publicEventScopedPath(`/members/${encodeURIComponent(member.publicSlug)}`, event.slug)
            "
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="member-identity">
              <span class="member-avatar">
                <img
                  v-if="member.avatarUrl"
                  :src="member.avatarUrl"
                  :alt="member.displayName ? `${member.displayName}的头像` : '报名会员头像'"
                  loading="lazy"
                />
                <b v-else aria-hidden="true">{{
                  attendeeAvatarInitial(member.displayName || member.initials)
                }}</b>
              </span>
              <span class="member-copy">
                <strong>{{ member.displayName || '报名会员' }}</strong>
                <em v-if="member.company">{{ member.company }}</em>
              </span>
            </span>
            <span class="member-open" aria-hidden="true">↗</span>
          </a>
        </div>

        <nav
          v-if="(memberDirectory?.totalPages ?? 1) > 1"
          class="member-pagination"
          aria-label="报名会员分页"
        >
          <button type="button" :disabled="membersPage <= 1" @click="changeMembersPage(-1)">
            上一页
          </button>
          <span>第 {{ memberDirectory?.page ?? membersPage }} /
            {{ memberDirectory?.totalPages ?? 1 }} 页</span>
          <button
            type="button"
            :disabled="membersPage >= (memberDirectory?.totalPages ?? 1)"
            @click="changeMembersPage(1)"
          >
            下一页
          </button>
        </nav>
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
          <span class="kicker">{{ blockCopy('home.organizer', 'kicker', 'INITIATORS') }}</span>
          <h2 class="sec-title">
            {{ blockCopy('home.organizer', 'title', '两位深耕行业多年的实战者') }}
          </h2>
          <p class="sec-sub">
            {{
              blockCopy(
                'home.organizer',
                'subtitle',
                '从中国第一场 GEO 大会，到推动行业白皮书与服务标准——他们想做的，是把这个行业真正建起来',
              )
            }}
          </p>
        </div>
        <div class="host-grid">
          <div
            v-for="(host, index) in hosts"
            :key="host.name"
            class="host-card reveal"
            :data-d="index || undefined"
          >
            <div class="host-name">{{ host.name }}</div>
            <div class="host-role">{{ host.role }}</div>
            <div class="host-bio">{{ host.bio }}</div>
            <div class="host-goal">{{ host.goal }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── COOPERATION ── -->
    <section
      v-if="blockEnabled('home.cooperation')"
      id="cooperation"
      :data-template-variant="blockVariant('home.cooperation')"
      :style="blockStyle('home.cooperation')"
    >
      <div class="wrap cooperation-band reveal">
        <div class="cooperation-band__index" aria-hidden="true">PARTNER<br />WITH US</div>
        <div class="cooperation-band__copy">
          <span class="kicker">{{ blockCopy('home.cooperation', 'kicker', 'PARTNERSHIP') }}</span>
          <h2>{{ blockCopy('home.cooperation', 'title', '让合作，成为大会内容的一部分') }}</h2>
          <p>
            {{
              blockCopy(
                'home.cooperation',
                'subtitle',
                '品牌、媒体、内容与社群伙伴，都可以在这里提出合作设想。',
              )
            }}
          </p>
          <small>{{
            blockCopy(
              'home.cooperation',
              'directions',
              '品牌赞助 · 展位展示 · 媒体合作 · 内容共创 · 社群渠道 · 团队购票',
            )
          }}</small>
        </div>
        <div class="cooperation-band__action">
          <a :href="cooperationHref" class="btn cooperation-btn">
            {{ blockCopy('home.cooperation', 'actionLabel', '提交合作申请') }}
            <span class="arr">→</span>
          </a>
          <span>{{
            blockCopy('home.cooperation', 'note', '提交后，大会团队将在 2 个工作日内与你联系。')
          }}</span>
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
          <span class="kicker">{{ blockCopy('home.tickets', 'kicker', 'TICKETS') }}</span>
          <h2 class="sec-title">{{ blockCopy('home.tickets', 'title', '一张门票，八项权益') }}</h2>
          <p class="sec-sub">
            {{ blockCopy('home.tickets', 'subtitlePrefix', '统一票价') }}
            {{ money(primaryTicket.price)
            }}{{
              blockCopy(
                'home.tickets',
                'subtitleSuffix',
                '，两天议程、实战工作坊与会后学习资料均已包含',
              )
            }}
          </p>
        </div>
        <div class="ticket-layout">
          <div class="ticket-main reveal">
            <div class="ticket-purchase">
              <span class="ticket-badge">{{ primaryTicket.name }}</span>
              <span class="price-label">{{
                blockCopy('home.tickets', 'priceLabel', '统一票价')
              }}</span>
              <div class="price-row">
                <span class="price-sym">¥</span><span class="price-num">{{
                  (primaryTicket.price / 100).toLocaleString('zh-CN')
                }}</span>
              </div>
              <div class="ticket-desc">
                {{ eventDate.compact }} · {{ event.city }}<br />{{
                  blockCopy('home.tickets', 'description', '一张票，全程参与两天大会')
                }}
              </div>
              <a
                :href="registrationAction.href"
                class="btn btn-primary ticket-cta"
                :class="{ 'is-context-loading': registrationAction.kind === 'loading' }"
                :aria-disabled="registrationAction.kind === 'loading'"
                @click="registrationAction.kind === 'loading' && $event.preventDefault()"
              >{{
                 registrationAction.kind === 'register'
                   ? blockCopy('home.tickets', 'actionLabel', registrationActionLabel)
                   : registrationActionLabel
               }}
                <span class="arr">→</span></a>
              <div class="ticket-note">
                {{ blockCopy('home.tickets', 'note', '八项参会权益已全部包含') }}
              </div>
            </div>
            <div class="ticket-benefits">
              <span class="benefit-eyebrow">{{
                blockCopy(
                  'home.tickets',
                  'benefitsEyebrow',
                  String(primaryTicket.benefits.length) + ' 项权益，全部包含',
                )
              }}</span>
              <h3>
                {{
                  blockCopy(
                    'home.tickets',
                    'benefitsTitle',
                    '从现场参与到会后复训，一张票覆盖完整学习周期',
                  )
                }}
              </h3>
              <ul class="perk-list">
                <li v-for="(benefit, index) in ticketBenefits" :key="benefit.title">
                  <span class="perk-no">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span><b>{{ benefit.title }}</b><small v-if="benefit.detail">{{ benefit.detail }}</small></span>
                </li>
              </ul>
            </div>
            <div class="ticket-assurances">
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>{{ blockCopy('home.tickets', 'assurance1Title', '7 天安心退款') }}</b>{{
                  blockCopy('home.tickets', 'assurance1Body', '购票后 7 天内可无理由退款')
                }}</span>
              </div>
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>{{ blockCopy('home.tickets', 'assurance2Title', '参会人可转让') }}</b>{{
                  blockCopy('home.tickets', 'assurance2Body', '开幕 3 天前可免费更换参会人')
                }}</span>
              </div>
              <div class="assurance">
                <span class="assurance-mark">✓</span><span><b>{{ blockCopy('home.tickets', 'assurance3Title', '支持开具发票') }}</b>{{
                  blockCopy('home.tickets', 'assurance3Body', '可申请增值税普通发票或专用发票')
                }}</span>
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
          <span class="kicker">{{ blockCopy('home.faq-summary', 'kicker', 'FAQ') }}</span>
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
          <span class="kicker" style="justify-content: center; display: inline-flex">{{
            blockCopy('home.registration-cta', 'kicker', 'SEE YOU IN SHENZHEN')
          }}</span>
          <h2>
            {{ blockCopy('home.registration-cta', 'titleLine1', '下一次用户问 AI 的时候')
            }}<br /><span class="accent">{{
              blockCopy('home.registration-cta', 'titleLine2', '答案里应该有你')
            }}</span>
          </h2>
          <p class="sub">
            {{ eventDate.compact }} · {{ event.city }} · 两日全通票
            {{ money(primaryTicket.price) }}
          </p>
          <a
            :href="registrationAction.href"
            class="btn btn-primary"
            :class="{ 'is-context-loading': registrationAction.kind === 'loading' }"
            :aria-disabled="registrationAction.kind === 'loading'"
            style="font-size: 16px; padding: 16px 44px"
            @click="registrationAction.kind === 'loading' && $event.preventDefault()"
          >{{
             registrationAction.kind === 'register'
               ? blockCopy('home.registration-cta', 'actionLabel', registrationActionLabel)
               : registrationActionLabel
           }}
            <span class="arr">→</span></a>
          <p style="margin-top: 20px; font-size: 12.5px; color: var(--ink-muted)">
            {{
              blockCopy(
                'home.registration-cta',
                'assurance',
                '7 天无理由退款 · 支持转让 · 支持开票',
              )
            }}
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
        <span>© 2026 {{ blockCopy('home.footer', 'organizer', 'GEO大会组委会') }} ·
          {{ blockCopy('home.footer', 'eventLabel', '中国第二届GEO主题大会') }} ·
          {{ event.city }}</span>
        <a class="foot-cooperation" :href="cooperationHref">{{
          blockCopy('home.footer', 'support', '合作咨询 / 团队购票 / 媒体支持：提交合作申请')
        }}</a>
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
        <a
          :href="registrationAction.href"
          class="btn btn-primary"
          :class="{ 'is-context-loading': registrationAction.kind === 'loading' }"
          :aria-disabled="registrationAction.kind === 'loading'"
          @click="registrationAction.kind === 'loading' && $event.preventDefault()"
        >{{ registrationActionLabel }}</a>
      </div>
    </div>
  </div>
</template>
