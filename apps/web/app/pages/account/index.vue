<script setup lang="ts">
import type {
  CustomerInvoiceCenterCounts,
  CustomerInvoiceCenterItem,
  CustomerRegistrationSummary,
} from '@conference/contracts';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';

const customer = useCustomerSession();
const registrations = ref<CustomerRegistrationSummary[]>([]);
const invoiceHighlights = ref<CustomerInvoiceCenterItem[]>([]);
const invoiceCounts = ref<CustomerInvoiceCenterCounts>({
  all: 0,
  eligible: 0,
  actionRequired: 0,
  processing: 0,
  issued: 0,
  history: 0,
});
const loading = ref(true);
const loadingMore = ref(false);
const saving = ref(false);
const nextCursor = ref<string | null>(null);
const errorMessage = ref('');
const successMessage = ref('');
const emailError = ref('');
const profile = reactive({
  nickname: '',
  realName: '',
  email: '',
  company: '',
  title: '',
  city: '',
});

const displayName = computed(
  () =>
    customer.session.value?.customer.profile.nickname ||
    customer.session.value?.customer.profile.realName ||
    customer.session.value?.customer.maskedMobile ||
    '参会者',
);
const accountInitial = computed(() => displayName.value.trim().slice(0, 1).toUpperCase());
const profileCompletion = computed(() => {
  const values = Object.values(profile);
  return Math.round((values.filter((value) => value.trim()).length / values.length) * 100);
});
const validTicketCount = computed(
  () => registrations.value.filter((item) => item.ticketStatus === 'valid').length,
);
const pendingActionCount = computed(
  () =>
    registrations.value.filter(
      (item) =>
        ['pending_review', 'pending_payment'].includes(item.registrationStatus) ||
        ['pending_review', 'pending_payment'].includes(item.orderStatus),
    ).length + invoiceCounts.value.actionRequired,
);
const featuredRegistration = computed(
  () =>
    registrations.value.find(
      (item) =>
        ['pending_review', 'pending_payment'].includes(item.registrationStatus) ||
        ['pending_review', 'pending_payment'].includes(item.orderStatus),
    ) ??
    registrations.value.find((item) => item.ticketStatus === 'valid') ??
    registrations.value[0] ??
    null,
);
const registrationCountLabel = computed(
  () => `${registrations.value.length}${nextCursor.value ? '+' : ''}`,
);

const statusLabels: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审核',
  pending_payment: '待支付',
  confirmed: '已确认',
  cancelled: '已取消',
  checked_in: '已签到',
  completed: '已完成',
  processing: '处理中',
  paid: '已支付',
  partially_refunded: '部分退款',
  refunded: '已退款',
  closed: '已关闭',
  valid: '可使用',
  used: '已使用',
  awaiting_details: '待补充资料',
  issuing: '开具中',
  issue_failed: '开具失败',
  issued: '已开具',
  rejected: '已驳回',
  adjustment_required: '待调整',
  voided: '已作废',
};

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));

const formatMonth = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(new Date(value));

const formatDay = (value: string) => String(new Date(value).getDate()).padStart(2, '0');

const formatDateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '暂无记录';

const primaryRegistrationAction = (item: CustomerRegistrationSummary) => {
  if (item.ticketCode && item.ticketStatus === 'valid') {
    return {
      label: '打开电子票',
      to: `/ticket/${encodeURIComponent(item.ticketCode)}?event=${encodeURIComponent(item.eventSlug)}`,
    };
  }
  if (
    ['pending_review', 'pending_payment'].includes(item.registrationStatus) ||
    ['pending_review', 'pending_payment'].includes(item.orderStatus)
  ) {
    return { label: '处理报名', to: `/account/registrations/${item.id}` };
  }
  return { label: '查看报名', to: `/account/registrations/${item.id}` };
};

const statusLabel = (value: string) => statusLabels[value] ?? value;
const canRequestInvoice = (item: CustomerRegistrationSummary) =>
  item.amount > 0 && ['paid', 'partially_refunded'].includes(item.orderStatus);

function validateEmail() {
  const value = profile.email.trim();
  emailError.value =
    value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '请输入有效的邮箱地址' : '';
  return !emailError.value;
}

function syncProfile() {
  const value = customer.session.value?.customer.profile;
  if (!value) return;
  profile.nickname = value.nickname ?? '';
  profile.realName = value.realName ?? '';
  profile.email = value.email ?? '';
  profile.company = value.company ?? '';
  profile.title = value.title ?? '';
  profile.city = value.city ?? '';
}

async function loadRegistrations(append = false) {
  if (append) loadingMore.value = true;
  else nextCursor.value = null;
  try {
    const result = await customer.registrations(
      append ? (nextCursor.value ?? undefined) : undefined,
    );
    registrations.value = append ? [...registrations.value, ...result.items] : result.items;
    nextCursor.value = result.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

async function loadInvoiceSummary() {
  const result = await customer.invoices('all', undefined, 3);
  invoiceHighlights.value = result.items;
  invoiceCounts.value = result.counts;
}

async function initialize() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (customer.session.value) {
      syncProfile();
      await Promise.all([loadRegistrations(), loadInvoiceSummary()]);
    }
  } catch {
    errorMessage.value = '个人中心暂时无法加载，请稍后重试';
  } finally {
    loading.value = false;
  }
}

async function saveProfile() {
  const current = customer.session.value;
  if (!current) return;
  if (!validateEmail()) return;
  saving.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    await customer.updateProfile({
      version: current.customer.profile.version,
      nickname: profile.nickname.trim() || null,
      realName: profile.realName.trim() || null,
      email: profile.email.trim() || null,
      company: profile.company.trim() || null,
      title: profile.title.trim() || null,
      city: profile.city.trim() || null,
    });
    syncProfile();
    successMessage.value = '个人资料已保存';
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '资料保存失败，请刷新后重试';
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await customer.logout();
  registrations.value = [];
  invoiceHighlights.value = [];
  invoiceCounts.value = {
    all: 0,
    eligible: 0,
    actionRequired: 0,
    processing: 0,
    issued: 0,
    history: 0,
  };
  nextCursor.value = null;
}

onMounted(initialize);
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void initialize();
  },
);
useHead({ title: '个人中心' });
</script>

<template>
  <div class="flow-page account-page">
    <FlowHeader />
    <main id="main-content" class="account-shell">
      <template v-if="loading">
        <div class="account-loading" role="status">
          <span aria-hidden="true"></span>
          <p>正在整理你的参会信息</p>
        </div>
      </template>

      <section v-else-if="!customer.session.value" class="account-login">
        <div class="account-login__copy">
          <p class="flow-eyebrow">ATTENDEE ACCOUNT</p>
          <h1>你的大会信息，集中在一个入口</h1>
          <p>登录后查看报名进度、电子票、订单与发票，也可以维护常用参会资料。</p>
          <button class="account-primary" type="button" @click="customer.openLogin">
            登录个人中心
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <div class="account-login__preview" aria-hidden="true">
          <span>TOKEMS CONFERENCE</span>
          <strong>ATTENDEE<br />PASS</strong>
          <i>01</i>
        </div>
      </section>

      <template v-else>
        <header class="account-heading">
          <div>
            <p class="flow-eyebrow">ATTENDEE ACCOUNT</p>
            <h1>个人中心</h1>
            <p>{{ displayName }}，这里汇总了你的参会凭证与账户资料。</p>
          </div>
          <NuxtLink class="account-back-link" to="/">
            大会官网
            <span aria-hidden="true">↗</span>
          </NuxtLink>
        </header>

        <p v-if="errorMessage" class="account-message is-error" role="alert">
          {{ errorMessage }}
        </p>
        <p v-if="successMessage" class="account-message is-success" role="status">
          {{ successMessage }}
        </p>

        <div class="account-workspace">
          <aside class="account-rail" aria-label="账户导航">
            <div class="account-rail__identity">
              <div class="account-avatar" aria-hidden="true">{{ accountInitial }}</div>
              <div>
                <strong>{{ displayName }}</strong>
                <span><i></i> 手机已验证</span>
              </div>
            </div>
            <p class="account-rail__mobile">
              {{ customer.session.value.customer.maskedMobile }}
            </p>
            <nav class="account-nav" aria-label="个人中心模块">
              <a href="#overview"><span>01</span> 总览</a>
              <a href="#events"><span>02</span> 我的大会</a>
              <a href="#invoices"><span>03</span> 发票中心</a>
              <a href="#profile"><span>04</span> 个人资料</a>
              <a href="#security"><span>05</span> 账户安全</a>
            </nav>
            <div class="account-rail__completion">
              <div>
                <span>资料完整度</span>
                <strong>{{ profileCompletion }}%</strong>
              </div>
              <div class="account-progress" aria-hidden="true">
                <i :style="{ width: `${profileCompletion}%` }"></i>
              </div>
              <p>
                {{
                  profileCompletion === 100
                    ? '资料完整，报名时可直接使用'
                    : '完善资料，下次报名填写更快'
                }}
              </p>
            </div>
            <div class="account-rail__footer">
              <span>最近登录</span>
              <strong>{{ formatDateTime(customer.session.value.customer.lastLoginAt) }}</strong>
              <button type="button" @click="logout">退出登录</button>
            </div>
          </aside>

          <div class="account-content">
            <section
              id="overview"
              class="account-section account-overview"
              aria-labelledby="overview-title"
            >
              <div class="account-section__heading is-compact">
                <div>
                  <span class="account-section__index">01 / OVERVIEW</span>
                  <h2 id="overview-title">下一步</h2>
                </div>
                <p>
                  {{
                    pendingActionCount
                      ? `有 ${pendingActionCount} 项报名需要处理`
                      : '当前账户状态正常'
                  }}
                </p>
              </div>

              <article v-if="featuredRegistration" class="account-pass">
                <div class="account-pass__main">
                  <div class="account-pass__topline">
                    <span>TOKEMS CONFERENCE · ATTENDEE PASS</span>
                    <span class="account-pass__status">{{
                      statusLabel(featuredRegistration.registrationStatus)
                    }}</span>
                  </div>
                  <h3>{{ featuredRegistration.eventName }}</h3>
                  <p>
                    {{ formatDate(featuredRegistration.startsAt) }} 至
                    {{ formatDate(featuredRegistration.endsAt) }} ·
                    {{ featuredRegistration.ticketTypeName }}
                  </p>
                  <div class="account-pass__actions">
                    <NuxtLink
                      class="account-pass__primary"
                      :to="primaryRegistrationAction(featuredRegistration).to"
                    >
                      {{ primaryRegistrationAction(featuredRegistration).label }}
                      <span aria-hidden="true">→</span>
                    </NuxtLink>
                    <NuxtLink :to="`/account/registrations/${featuredRegistration.id}`">
                      报名详情
                    </NuxtLink>
                  </div>
                </div>
                <div class="account-pass__stub">
                  <span>{{ formatMonth(featuredRegistration.startsAt) }}</span>
                  <strong>{{ formatDay(featuredRegistration.startsAt) }}</strong>
                  <small>{{ featuredRegistration.registrationCode }}</small>
                </div>
              </article>

              <article v-else class="account-pass is-empty">
                <div class="account-pass__main">
                  <div class="account-pass__topline">
                    <span>TOKEMS CONFERENCE · NEXT EVENT</span>
                    <span class="account-pass__status">待启程</span>
                  </div>
                  <h3>下一场大会，从这里开始</h3>
                  <p>完成报名后，进度、电子票与现场签到凭证会自动汇总到个人中心。</p>
                  <div class="account-pass__actions">
                    <NuxtLink class="account-pass__primary" to="/">
                      浏览近期大会
                      <span aria-hidden="true">→</span>
                    </NuxtLink>
                  </div>
                </div>
                <div class="account-pass__stub">
                  <span>MEMBER</span>
                  <strong>G</strong>
                  <small>READY TO JOIN</small>
                </div>
              </article>

              <dl class="account-summary" aria-label="参会信息摘要">
                <div>
                  <dt>我的大会</dt>
                  <dd>{{ registrationCountLabel }}</dd>
                  <small>全部报名</small>
                </div>
                <div>
                  <dt>有效票券</dt>
                  <dd>{{ validTicketCount }}{{ nextCursor ? '+' : '' }}</dd>
                  <small>可用于签到</small>
                </div>
                <div>
                  <dt>待办事项</dt>
                  <dd :class="{ 'is-attention': pendingActionCount > 0 }">
                    {{ pendingActionCount }}{{ nextCursor ? '+' : '' }}
                  </dd>
                  <small>{{ pendingActionCount ? '请及时处理' : '当前无待办' }}</small>
                </div>
              </dl>
            </section>

            <section id="events" class="account-section" aria-labelledby="events-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">02 / MY EVENTS</span>
                  <h2 id="events-title">我的大会</h2>
                </div>
                <p>报名、订单、票券和发票跟随每场大会归档。</p>
              </div>

              <div class="account-surface account-events">
                <div v-if="registrations.length" class="registration-list">
                  <article v-for="item in registrations" :key="item.id" class="registration-row">
                    <div class="registration-row__date" aria-hidden="true">
                      <span>{{ formatMonth(item.startsAt) }}</span>
                      <strong>{{ formatDay(item.startsAt) }}</strong>
                    </div>
                    <div class="registration-row__body">
                      <div class="registration-row__heading">
                        <div>
                          <h3>{{ item.eventName }}</h3>
                          <p>{{ formatDate(item.startsAt) }} 至 {{ formatDate(item.endsAt) }}</p>
                        </div>
                        <span class="registration-status" :data-status="item.registrationStatus">
                          {{ statusLabels[item.registrationStatus] ?? item.registrationStatus }}
                        </span>
                      </div>
                      <dl class="registration-meta">
                        <div>
                          <dt>票种</dt>
                          <dd>{{ item.ticketTypeName }}</dd>
                        </div>
                        <div>
                          <dt>订单</dt>
                          <dd>{{ statusLabels[item.orderStatus] ?? item.orderStatus }}</dd>
                        </div>
                        <div>
                          <dt>电子票</dt>
                          <dd>
                            {{
                              item.ticketStatus
                                ? (statusLabels[item.ticketStatus] ?? item.ticketStatus)
                                : '暂未生成'
                            }}
                          </dd>
                        </div>
                        <div>
                          <dt>金额</dt>
                          <dd>{{ money(item.amount, item.currency) }}</dd>
                        </div>
                        <div>
                          <dt>发票</dt>
                          <dd>
                            {{
                              item.invoiceStatus
                                ? (statusLabels[item.invoiceStatus] ?? item.invoiceStatus)
                                : '未申请'
                            }}
                          </dd>
                        </div>
                        <div>
                          <dt>报名编号</dt>
                          <dd>{{ item.registrationCode }}</dd>
                        </div>
                      </dl>
                      <div class="registration-row__actions">
                        <NuxtLink
                          class="registration-primary-action"
                          :to="primaryRegistrationAction(item).to"
                        >
                          {{ primaryRegistrationAction(item).label }}
                          <span aria-hidden="true">→</span>
                        </NuxtLink>
                        <NuxtLink :to="`/account/registrations/${item.id}`">报名详情</NuxtLink>
                        <NuxtLink
                          v-if="canRequestInvoice(item)"
                          :to="`/account/invoices/${item.orderId}`"
                        >
                          {{ item.invoiceId ? '查看发票' : '申请发票' }}
                        </NuxtLink>
                      </div>
                    </div>
                  </article>
                  <button
                    v-if="nextCursor"
                    class="registration-more"
                    type="button"
                    :disabled="loadingMore"
                    @click="loadRegistrations(true)"
                  >
                    {{ loadingMore ? '正在加载…' : '加载更多大会' }}
                  </button>
                </div>
                <div v-else class="account-empty">
                  <span class="account-empty__count">00</span>
                  <div>
                    <p class="account-empty__eyebrow">YOUR EVENT ARCHIVE</p>
                    <h3>还没有报名记录</h3>
                    <p>报名成功后，每场大会会形成一份完整档案，包含订单、电子票和发票进度。</p>
                    <NuxtLink to="/">查看正在报名的大会 <span aria-hidden="true">→</span></NuxtLink>
                  </div>
                </div>
              </div>
            </section>

            <section id="invoices" class="account-section" aria-labelledby="invoices-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">03 / INVOICES</span>
                  <h2 id="invoices-title">发票中心</h2>
                </div>
                <p>申请、审核、下载和历史记录统一汇总。</p>
              </div>

              <div class="account-surface account-invoices">
                <div class="account-invoices__summary">
                  <div>
                    <span>可申请</span>
                    <strong>{{ invoiceCounts.eligible }}</strong>
                    <small>已支付订单</small>
                  </div>
                  <div :class="{ attention: invoiceCounts.actionRequired > 0 }">
                    <span>待我处理</span>
                    <strong>{{ invoiceCounts.actionRequired }}</strong>
                    <small>{{ invoiceCounts.actionRequired ? '请完善资料' : '当前无待办' }}</small>
                  </div>
                  <div>
                    <span>处理中</span>
                    <strong>{{ invoiceCounts.processing }}</strong>
                    <small>审核与开具</small>
                  </div>
                  <div>
                    <span>已开具</span>
                    <strong>{{ invoiceCounts.issued }}</strong>
                    <small>可下载文件</small>
                  </div>
                </div>

                <div class="account-invoices__entry">
                  <div>
                    <span class="account-invoices__eyebrow">INVOICE SERVICE</span>
                    <h3>
                      {{
                        invoiceCounts.actionRequired
                          ? `有 ${invoiceCounts.actionRequired} 项发票资料需要处理`
                          : invoiceCounts.eligible
                            ? `有 ${invoiceCounts.eligible} 笔订单可以申请发票`
                            : '发票记录已经整理完成'
                      }}
                    </h3>
                    <p>
                      {{
                        invoiceHighlights[0]
                          ? `${invoiceHighlights[0].eventName} · ${statusLabel(invoiceHighlights[0].status ?? 'paid')}`
                          : '收费订单完成支付后，可以在这里提交开票资料。'
                      }}
                    </p>
                  </div>
                  <NuxtLink to="/account/invoices">
                    进入发票中心 <span aria-hidden="true">→</span>
                  </NuxtLink>
                </div>
              </div>
            </section>

            <section id="profile" class="account-section" aria-labelledby="profile-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">04 / PROFILE</span>
                  <h2 id="profile-title">个人资料</h2>
                </div>
                <p>这些资料可用于下一次报名预填。</p>
              </div>

              <div class="account-surface account-profile">
                <div class="account-profile__intro">
                  <span>{{ profileCompletion }}%</span>
                  <h3>{{ profileCompletion === 100 ? '资料已经完整' : '继续完善参会名片' }}</h3>
                  <p>姓名、公司与职位会用于参会信息，请保持内容准确。</p>
                  <div class="account-progress" aria-hidden="true">
                    <i :style="{ width: `${profileCompletion}%` }"></i>
                  </div>
                </div>
                <form class="account-form" @submit.prevent="saveProfile">
                  <label>
                    <span>常用称呼</span>
                    <input
                      v-model="profile.nickname"
                      maxlength="80"
                      autocomplete="nickname"
                      placeholder="你的常用称呼"
                    />
                  </label>
                  <label>
                    <span>真实姓名</span>
                    <input
                      v-model="profile.realName"
                      maxlength="120"
                      autocomplete="name"
                      placeholder="用于参会信息"
                    />
                  </label>
                  <label>
                    <span>邮箱</span>
                    <input
                      v-model="profile.email"
                      type="email"
                      autocomplete="email"
                      placeholder="用于接收参会通知"
                      :aria-invalid="Boolean(emailError)"
                      @blur="validateEmail"
                    />
                    <small v-if="emailError" class="account-field-error">{{ emailError }}</small>
                  </label>
                  <label>
                    <span>所在公司</span>
                    <input
                      v-model="profile.company"
                      maxlength="160"
                      autocomplete="organization"
                      placeholder="公司或机构名称"
                    />
                  </label>
                  <label>
                    <span>职位</span>
                    <input
                      v-model="profile.title"
                      maxlength="100"
                      autocomplete="organization-title"
                      placeholder="当前职位"
                    />
                  </label>
                  <label>
                    <span>城市</span>
                    <input
                      v-model="profile.city"
                      maxlength="80"
                      autocomplete="address-level2"
                      placeholder="常驻城市"
                    />
                  </label>
                  <button class="account-primary is-form-action" type="submit" :disabled="saving">
                    {{ saving ? '正在保存…' : '保存个人资料' }}
                  </button>
                </form>
              </div>
            </section>

            <section id="security" class="account-section" aria-labelledby="security-title">
              <div class="account-section__heading">
                <div>
                  <span class="account-section__index">05 / SECURITY</span>
                  <h2 id="security-title">账户与安全</h2>
                </div>
                <p>手机号验证保护你的参会凭证与订单信息。</p>
              </div>

              <div class="account-surface account-security">
                <div class="account-security__status">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>账户状态正常</strong>
                    <p>登录手机号已经完成验证</p>
                  </div>
                </div>
                <dl class="account-facts">
                  <div>
                    <dt>登录手机号</dt>
                    <dd>{{ customer.session.value.customer.maskedMobile }}</dd>
                  </div>
                  <div>
                    <dt>完成验证</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.verifiedAt) }}</dd>
                  </div>
                  <div>
                    <dt>最近登录</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.lastLoginAt) }}</dd>
                  </div>
                  <div>
                    <dt>账户创建</dt>
                    <dd>{{ formatDateTime(customer.session.value.customer.createdAt) }}</dd>
                  </div>
                  <div>
                    <dt>本次登录有效期</dt>
                    <dd>{{ formatDateTime(customer.session.value.expiresAt) }}</dd>
                  </div>
                </dl>
                <div class="account-security__action">
                  <div>
                    <strong>退出当前账号</strong>
                    <p>退出后需要重新验证手机号才能进入个人中心。</p>
                  </div>
                  <button type="button" @click="logout">退出登录</button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.account-page {
  --account-canvas: #f4f5f7;
  --account-surface: #ffffff;
  --account-ink: #15171b;
  --account-muted: #6f737c;
  --account-line: #dfe2e7;
  --account-line-soft: #eceef1;
  --account-title-page: clamp(32px, 3.2vw, 40px);
  --account-title-section: 23px;
  --account-title-card: clamp(22px, 2.5vw, 28px);
  --account-body: 13px;
  min-height: 100vh;
  background: var(--account-canvas);
}

.account-shell {
  width: min(100% - 40px, 1180px);
  margin-inline: auto;
  padding: 52px 0 104px;
}

.account-loading {
  display: grid;
  min-height: 420px;
  place-content: center;
  justify-items: center;
  gap: 15px;
  color: var(--account-muted);
}

.account-loading span {
  width: 28px;
  height: 28px;
  border: 2px solid #dbeafe;
  border-top-color: var(--conference-primary);
  border-radius: 50%;
  animation: account-loading-spin 800ms linear infinite;
}

.account-loading p {
  margin: 0;
  font-size: 13px;
}

@keyframes account-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

.account-login {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  min-height: 540px;
  align-items: center;
  gap: 72px;
}

.account-login__copy {
  max-width: 650px;
}

.account-login h1,
.account-heading h1 {
  margin: 0;
  color: var(--account-ink);
  font-weight: 850;
  line-height: 1.12;
  text-wrap: balance;
}

.account-login h1 {
  font-size: clamp(32px, 4vw, 48px);
}

.account-login__copy > p:not(.flow-eyebrow),
.account-heading > div > p:last-child {
  margin: 18px 0 0;
  color: var(--account-muted);
  font-size: 15px;
  line-height: 1.75;
  text-wrap: pretty;
}

.account-login__preview {
  position: relative;
  display: grid;
  min-height: 380px;
  align-content: space-between;
  overflow: hidden;
  padding: 30px;
  border: 1px solid #dbe5f6;
  border-radius: 12px;
  background: #f5f8fe;
  color: var(--conference-primary);
}

.account-login__preview::before,
.account-login__preview::after {
  position: absolute;
  right: -20px;
  width: 120px;
  height: 120px;
  border: 1px solid #dce6f7;
  border-radius: 50%;
  content: '';
}

.account-login__preview::before {
  top: 90px;
}
.account-login__preview::after {
  top: 145px;
}

.account-login__preview span {
  font-family: var(--conference-font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
}

.account-login__preview strong {
  color: var(--account-ink);
  font-size: 34px;
  line-height: 1.02;
}

.account-login__preview i {
  font-family: var(--conference-font-mono);
  font-size: 12px;
  font-style: normal;
}

.account-primary {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  gap: 20px;
  margin-top: 28px;
  padding: 0 20px;
  border-radius: 8px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 720;
  transition:
    background-color 160ms ease,
    transform 160ms ease,
    opacity 160ms ease;
}

.account-primary:active {
  transform: scale(0.97);
}
.account-primary:disabled {
  cursor: wait;
  opacity: 0.62;
}

.account-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 42px;
}

.account-heading h1 {
  font-size: var(--account-title-page);
  letter-spacing: -0.025em;
}

.account-back-link {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 10px;
  color: var(--account-muted);
  font-size: 13px;
  font-weight: 680;
  text-decoration: none;
  transition:
    color 160ms ease,
    transform 160ms ease;
}

.account-back-link:active {
  transform: scale(0.96);
}

.account-message {
  margin: -18px 0 24px;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
}

.account-message.is-error {
  background: #fff1f2;
  color: #be123c;
}
.account-message.is-success {
  background: #ecfdf5;
  color: #047857;
}

.account-workspace {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  align-items: start;
  gap: 34px;
}

.account-rail {
  position: sticky;
  top: 24px;
  overflow: hidden;
  border: 1px solid var(--account-line);
  border-radius: 10px;
  background: var(--account-surface);
}

.account-rail__identity {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 22px 20px 12px;
}

.account-avatar {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  border: 1px solid #cddcf6;
  background: #edf3fd;
  color: var(--conference-primary);
  font-size: 16px;
  font-weight: 820;
}

.account-rail__identity > div:last-child {
  min-width: 0;
}

.account-rail__identity strong {
  display: block;
  overflow: hidden;
  color: var(--account-ink);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-rail__identity span {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  color: #167653;
  font-size: 10px;
}

.account-rail__identity i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.account-rail__mobile {
  margin: 0;
  padding: 0 20px 20px;
  color: var(--account-muted);
  font-family: var(--conference-font-mono);
  font-size: 10px;
}

.account-nav {
  display: grid;
  padding: 8px;
  border-top: 1px solid var(--account-line-soft);
  border-bottom: 1px solid var(--account-line-soft);
}

.account-nav a {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 13px;
  padding: 0 12px;
  border-radius: 7px;
  color: #44474f;
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  transition:
    background-color 160ms ease,
    color 160ms ease;
}

.account-nav a span {
  color: #a0a4ad;
  font-family: var(--conference-font-mono);
  font-size: 9px;
}

.account-rail__completion {
  padding: 20px;
}

.account-rail__completion > div:first-child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--account-muted);
  font-size: 11px;
}

.account-rail__completion strong {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 12px;
}

.account-progress {
  width: 100%;
  height: 3px;
  overflow: hidden;
  margin-top: 12px;
  border-radius: 999px;
  background: #e6e8ec;
}

.account-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--conference-primary);
  transition: width 240ms ease;
}

.account-rail__completion p {
  margin: 10px 0 0;
  color: #8a8e97;
  font-size: 10px;
  line-height: 1.55;
}

.account-rail__footer {
  padding: 18px 20px 20px;
  border-top: 1px solid var(--account-line-soft);
  background: #fafafa;
}

.account-rail__footer > span,
.account-rail__footer > strong {
  display: block;
}

.account-rail__footer > span {
  color: #999da5;
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-rail__footer > strong {
  margin-top: 5px;
  color: #686c74;
  font-size: 10px;
  font-weight: 550;
  line-height: 1.5;
}

.account-rail__footer button {
  min-height: 40px;
  margin-top: 12px;
  color: var(--account-muted);
  font-size: 11px;
  font-weight: 650;
}

.account-content {
  display: grid;
  min-width: 0;
  gap: 74px;
}

.account-section {
  min-width: 0;
  padding: 0;
  scroll-margin-top: 24px;
}

.account-section__heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}

.account-section__heading.is-compact {
  margin-bottom: 18px;
}

.account-section__index {
  display: block;
  margin-bottom: 8px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.account-section__heading h2 {
  margin: 0;
  color: var(--account-ink);
  font-size: var(--account-title-section);
  font-weight: 820;
  line-height: 1.15;
}

.account-section__heading > p {
  max-width: 380px;
  margin: 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: right;
}

.account-pass {
  position: relative;
  display: grid;
  width: 100%;
  max-width: 100%;
  grid-template-columns: minmax(0, 1fr) 178px;
  min-height: 274px;
  overflow: hidden;
  border: 1px solid #cedbf1;
  border-top: 3px solid var(--conference-primary);
  border-radius: 0;
  background: var(--account-surface);
  color: var(--account-ink);
}

.account-pass__main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  padding: 30px 32px;
}

.account-pass__topline {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: #6d7f9e;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-pass__status {
  padding: 5px 7px;
  border: 1px solid #c9d9f4;
  border-radius: 4px;
  background: #f1f6ff;
  color: var(--conference-primary);
  letter-spacing: 0;
}

.account-pass h3 {
  max-width: 620px;
  margin: 35px 0 0;
  font-size: var(--account-title-card);
  font-weight: 830;
  line-height: 1.12;
  text-wrap: balance;
}

.account-pass__main > p {
  margin: 12px 0 0;
  color: var(--account-muted);
  font-size: var(--account-body);
  line-height: 1.65;
}

.account-pass__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  margin-top: auto;
  padding-top: 24px;
}

.account-pass__actions a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 18px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  text-decoration: none;
}

.account-pass__actions .account-pass__primary {
  padding: 0 16px;
  border: 1px solid #c9d9f4;
  border-radius: 7px;
  background: #f1f6ff;
  color: #174bb9;
}

.account-pass__stub {
  position: relative;
  display: grid;
  align-content: center;
  justify-items: center;
  border-left: 1px dashed #b7c7e1;
  background: #f5f8fd;
  text-align: center;
}

.account-pass__stub::before,
.account-pass__stub::after {
  position: absolute;
  left: -10px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--account-canvas);
  content: '';
}

.account-pass__stub::before {
  top: -10px;
}
.account-pass__stub::after {
  bottom: -10px;
}

.account-pass__stub span,
.account-pass__stub small {
  color: #7c8ba4;
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.account-pass__stub strong {
  margin: 7px 0 12px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 44px;
  line-height: 0.95;
}

.account-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 24px 0 0;
  border-top: 1px solid #cfd3d9;
  border-bottom: 1px solid #cfd3d9;
}

.account-summary > div {
  padding: 20px 2px;
}
.account-summary > div + div {
  padding-left: 22px;
  border-left: 1px solid #cfd3d9;
}

.account-summary dt,
.account-summary dd,
.account-summary small {
  margin: 0;
}

.account-summary dt {
  color: var(--account-muted);
  font-size: 10px;
}

.account-summary dd {
  margin-top: 8px;
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 24px;
  font-weight: 750;
  line-height: 1;
}

.account-summary dd.is-attention {
  color: #c2410c;
}

.account-summary small {
  display: block;
  margin-top: 6px;
  color: #999da5;
  font-size: 9.5px;
}

.account-surface {
  overflow: hidden;
  border: 1px solid var(--account-line);
  border-radius: 10px;
  background: var(--account-surface);
}

.account-invoices__summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--account-line-soft);
}

.account-invoices__summary > div {
  display: grid;
  gap: 5px;
  padding: 20px 22px 22px;
  border-right: 1px solid var(--account-line-soft);
}

.account-invoices__summary > div:last-child {
  border-right: 0;
}

.account-invoices__summary span,
.account-invoices__summary small {
  color: var(--account-muted);
  font-size: 9.5px;
}

.account-invoices__summary strong {
  color: var(--account-ink);
  font-family: var(--conference-font-mono);
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}

.account-invoices__summary .attention strong {
  color: #aa6c12;
}

.account-invoices__entry {
  display: flex;
  min-height: 154px;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 25px 28px 28px;
  background: #fafbfd;
}

.account-invoices__entry > div {
  min-width: 0;
}

.account-invoices__eyebrow {
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.account-invoices__entry h3 {
  margin: 9px 0 0;
  color: var(--account-ink);
  font-size: 18px;
  font-weight: 780;
  line-height: 1.4;
  text-wrap: balance;
}

.account-invoices__entry p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.6;
}

.account-invoices__entry > a {
  display: inline-flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  gap: 18px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--conference-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 720;
  text-decoration: none;
  transition:
    transform 150ms ease,
    opacity 150ms ease;
}

.account-invoices__entry > a:active {
  transform: scale(0.97);
}

.registration-list {
  display: grid;
}

.registration-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 24px;
  padding: 28px;
  border-bottom: 1px solid var(--account-line-soft);
  transition: background-color 160ms ease;
}

.registration-row:last-child {
  border-bottom: 0;
}

.registration-row__date {
  display: grid;
  width: 68px;
  height: 72px;
  align-content: center;
  border-top: 3px solid var(--conference-primary);
  background: #f2f5fb;
  color: var(--account-ink);
  text-align: center;
}

.registration-row__date span {
  color: var(--conference-primary);
  font-size: 9px;
  font-weight: 700;
}

.registration-row__date strong {
  margin-top: 4px;
  font-family: var(--conference-font-mono);
  font-size: 26px;
  line-height: 1;
}

.registration-row__body {
  min-width: 0;
}

.registration-row__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.registration-row__heading > div {
  min-width: 0;
}

.registration-row__heading h3 {
  margin: 0;
  overflow: hidden;
  color: var(--account-ink);
  font-size: 17px;
  font-weight: 750;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.registration-row__heading p {
  margin: 7px 0 0;
  color: var(--account-muted);
  font-size: 11px;
}

.registration-status {
  flex: 0 0 auto;
  padding: 5px 8px;
  border-radius: 4px;
  background: #f2f3f5;
  color: #5f636b;
  font-size: 10px;
}

.registration-status[data-status='confirmed'],
.registration-status[data-status='completed'],
.registration-status[data-status='checked_in'] {
  background: #eaf7f1;
  color: #167653;
}

.registration-status[data-status='pending_payment'],
.registration-status[data-status='pending_review'] {
  background: #fff3e7;
  color: #b45309;
}

.registration-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px 24px;
  margin: 22px 0 0;
  padding: 18px 0;
  border-top: 1px solid var(--account-line-soft);
  border-bottom: 1px solid var(--account-line-soft);
}

.registration-meta div {
  min-width: 0;
}
.registration-meta dt,
.registration-meta dd {
  margin: 0;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.registration-meta dt {
  color: #979ba4;
}
.registration-meta dd {
  margin-top: 5px;
  color: #4f535b;
  font-variant-numeric: tabular-nums;
}

.registration-row__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 20px;
  margin-top: 10px;
}

.registration-row__actions a {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  color: #676b73;
  font-size: 11px;
  font-weight: 650;
  text-decoration: none;
}

.registration-row__actions .registration-primary-action {
  color: var(--conference-primary);
}

.registration-more {
  min-height: 44px;
  margin: 18px 28px 24px;
  padding: 0 16px;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  background: #fff;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  transition:
    background-color 160ms ease,
    transform 160ms ease;
}

.registration-more:active {
  transform: scale(0.98);
}
.registration-more:disabled {
  cursor: wait;
  opacity: 0.62;
}

.account-empty {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  min-height: 300px;
  align-items: center;
}

.account-empty__count {
  display: grid;
  height: 100%;
  place-items: center;
  border-right: 1px solid var(--account-line-soft);
  background: #f6f7f9;
  color: #d1d4da;
  font-family: var(--conference-font-mono);
  font-size: 44px;
  font-weight: 720;
}

.account-empty > div {
  max-width: 480px;
  padding: 40px;
}
.account-empty__eyebrow {
  margin: 0 0 12px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
}
.account-empty h3 {
  margin: 0;
  color: var(--account-ink);
  font-size: 20px;
}
.account-empty > div > p:not(.account-empty__eyebrow) {
  margin: 12px 0 0;
  color: var(--account-muted);
  font-size: 12px;
  line-height: 1.7;
}
.account-empty a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 680;
  text-decoration: none;
}

.account-profile {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
}

.account-profile__intro {
  padding: 30px;
  border-right: 1px solid var(--account-line-soft);
  background: #f7f8fa;
}

.account-profile__intro > span {
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 32px;
  font-weight: 750;
  line-height: 1;
}

.account-profile__intro h3 {
  margin: 24px 0 0;
  color: var(--account-ink);
  font-size: 16px;
}
.account-profile__intro p {
  margin: 10px 0 0;
  color: var(--account-muted);
  font-size: 11px;
  line-height: 1.65;
}
.account-profile__intro .account-progress {
  margin-top: 24px;
}

.account-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  padding: 30px;
}

.account-form label {
  display: grid;
  align-content: start;
  gap: 7px;
  color: #555962;
  font-size: 11px;
  font-weight: 650;
}

.account-form input {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid #d7d9de;
  border-radius: 7px;
  background: #fff;
  color: var(--account-ink);
  font: inherit;
  outline: none;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.account-form input::placeholder {
  color: #a6a9b0;
}
.account-form input:focus {
  border-color: var(--conference-primary);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 10%);
}
.account-form input[aria-invalid='true'] {
  border-color: #e11d48;
}
.account-field-error {
  color: #be123c;
  font-size: 10px;
  font-weight: 500;
}

.account-primary.is-form-action {
  grid-column: 1 / -1;
  width: max-content;
  margin-top: 4px;
}

.account-security {
  padding: 0 28px;
}

.account-security__status,
.account-security__action {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 24px 0;
}

.account-security__status {
  border-bottom: 1px solid var(--account-line-soft);
}

.account-security__status > span {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: #eaf7f1;
  color: #167653;
  font-size: 14px;
  font-weight: 800;
}

.account-security__status strong,
.account-security__action strong {
  color: var(--account-ink);
  font-size: 13px;
}
.account-security__status p,
.account-security__action p {
  margin: 5px 0 0;
  color: var(--account-muted);
  font-size: 10px;
}

.account-facts {
  margin: 0;
}

.account-facts > div {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: 24px;
  padding: 16px 0;
  border-bottom: 1px solid var(--account-line-soft);
}

.account-facts dt,
.account-facts dd {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}
.account-facts dt {
  color: #8d9199;
}
.account-facts dd {
  color: #4f535b;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.account-security__action {
  justify-content: space-between;
  gap: 24px;
}
.account-security__action button {
  min-height: 40px;
  flex: 0 0 auto;
  padding: 0 14px;
  border: 1px solid var(--account-line);
  border-radius: 7px;
  color: #565a62;
  font-size: 11px;
  font-weight: 650;
  transition:
    background-color 160ms ease,
    transform 160ms ease;
}
.account-security__action button:active {
  transform: scale(0.96);
}

@media (hover: hover) {
  .account-back-link:hover {
    color: var(--conference-primary);
  }
  .account-nav a:hover {
    background: #f2f5fb;
    color: var(--conference-primary);
  }
  .account-rail__footer button:hover {
    color: #b42318;
  }
  .account-primary:hover {
    background: var(--conference-primary-dark);
  }
  .registration-row:hover {
    background: #fafbfc;
  }
  .registration-row__actions a:hover,
  .account-empty a:hover {
    color: var(--conference-primary-dark);
  }
  .registration-more:hover {
    background: #f2f5fb;
  }
  .account-security__action button:hover {
    background: #f5f5f6;
  }
}

@media (max-width: 1000px) {
  .account-workspace {
    grid-template-columns: 1fr;
  }
  .account-rail {
    position: static;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .account-rail__identity {
    padding-bottom: 22px;
  }
  .account-rail__mobile {
    display: none;
  }
  .account-nav {
    grid-column: 1 / -1;
    grid-row: 2;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    border-bottom: 0;
  }
  .account-rail__completion {
    min-width: 220px;
  }
  .account-rail__footer {
    display: none;
  }
}

@media (max-width: 760px) {
  .account-shell {
    width: min(100% - 28px, 1180px);
    padding: 38px 0 72px;
  }
  .account-heading {
    align-items: flex-start;
    margin-bottom: 32px;
  }
  .account-heading h1 {
    font-size: 32px;
  }
  .account-heading > div > p:last-child {
    max-width: 30ch;
    font-size: 12px;
  }
  .account-back-link {
    font-size: 0;
  }
  .account-back-link span {
    display: grid;
    width: 40px;
    height: 40px;
    place-items: center;
    border: 1px solid var(--account-line);
    border-radius: 7px;
    background: #fff;
    font-size: 15px;
  }
  .account-login {
    grid-template-columns: 1fr;
    min-height: 0;
    gap: 44px;
  }
  .account-login__preview {
    min-height: 280px;
  }
  .account-workspace {
    gap: 28px;
  }
  .account-rail {
    grid-template-columns: 1fr;
  }
  .account-rail__completion {
    display: none;
  }
  .account-nav {
    overflow-x: auto;
  }
  .account-nav a {
    min-width: 108px;
    justify-content: center;
    padding-inline: 8px;
  }
  .account-content {
    gap: 56px;
  }
  .account-section__heading {
    align-items: flex-start;
  }
  .account-section__heading > p {
    max-width: 210px;
    text-align: right;
  }
  .account-pass {
    grid-template-columns: minmax(0, 1fr);
  }
  .account-pass__main {
    width: 100%;
  }
  .account-pass__topline > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .account-pass__stub {
    min-height: 100px;
    grid-template-columns: auto auto 1fr;
    align-content: center;
    justify-items: start;
    gap: 12px;
    padding: 0 28px;
    border-top: 1px dashed #b7c7e1;
    border-left: 0;
    text-align: left;
  }
  .account-pass__stub::before,
  .account-pass__stub::after {
    top: -10px;
    bottom: auto;
  }
  .account-pass__stub::before {
    left: -10px;
  }
  .account-pass__stub::after {
    right: -10px;
    left: auto;
  }
  .account-pass__stub strong {
    margin: 0;
    font-size: 30px;
  }
  .account-pass__stub small {
    justify-self: end;
  }
  .account-profile {
    grid-template-columns: 1fr;
  }
  .account-profile__intro {
    border-right: 0;
    border-bottom: 1px solid var(--account-line-soft);
  }
  .account-invoices__summary {
    grid-template-columns: 1fr 1fr;
  }
  .account-invoices__summary > div:nth-child(2) {
    border-right: 0;
  }
  .account-invoices__summary > div:nth-child(-n + 2) {
    border-bottom: 1px solid var(--account-line-soft);
  }
  .account-invoices__entry {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 600px) {
  .account-section__heading {
    display: block;
  }
  .account-section__heading > p {
    max-width: none;
    margin-top: 10px;
    text-align: left;
  }
  .account-pass__main {
    padding: 25px 22px;
  }
  .account-pass__topline {
    align-items: flex-start;
  }
  .account-pass h3 {
    margin-top: 28px;
    font-size: 24px;
  }
  .account-summary > div {
    padding-block: 17px;
  }
  .account-summary > div + div {
    padding-left: 14px;
  }
  .account-summary dd {
    font-size: 23px;
  }
  .registration-row {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 16px;
    padding: 20px;
  }
  .registration-row__date {
    width: 54px;
    height: 60px;
  }
  .registration-row__date strong {
    font-size: 21px;
  }
  .registration-row__heading {
    display: block;
  }
  .registration-status {
    display: inline-block;
    margin-top: 10px;
  }
  .registration-meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .account-empty {
    grid-template-columns: 1fr;
  }
  .account-empty__count {
    height: 110px;
    border-right: 0;
    border-bottom: 1px solid var(--account-line-soft);
    font-size: 44px;
  }
  .account-empty > div {
    padding: 30px 24px 34px;
  }
  .account-form {
    grid-template-columns: 1fr;
    padding: 24px;
  }
  .account-profile__intro {
    padding: 24px;
  }
}

@media (max-width: 400px) {
  .account-shell {
    width: min(100% - 22px, 1180px);
  }
  .account-heading h1 {
    font-size: 30px;
  }
  .account-nav {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow: visible;
  }
  .account-nav a {
    min-width: 0;
    justify-content: flex-start;
    padding-inline: 12px;
  }
  .account-pass__topline > span:first-child {
    max-width: 180px;
    line-height: 1.5;
  }
  .account-pass__stub {
    grid-template-columns: auto auto;
  }
  .account-pass__stub small {
    display: none;
  }
  .account-summary dt {
    font-size: 9px;
  }
  .account-summary small {
    font-size: 8.5px;
  }
  .registration-row {
    grid-template-columns: 1fr;
  }
  .registration-row__date {
    width: 100%;
    height: 52px;
    grid-template-columns: auto auto;
    place-content: center;
    align-items: center;
    gap: 7px;
  }
  .registration-row__date strong {
    margin: 0;
  }
  .account-facts > div {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .account-facts dd {
    text-align: left;
  }
  .account-security__action {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .account-loading span {
    animation: none;
  }
  .account-progress i {
    transition: none;
  }
}
</style>
