<script setup lang="ts">
import type { AttendeeNeedsProfile, CustomerRegistrationDetail } from '@conference/contracts';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { customerRegistrationTicketHref } from '~/utils/purchase-journey';

const route = useRoute();
const customer = useCustomerSession();
const detail = ref<CustomerRegistrationDetail | null>(null);
const attendeeNeeds = ref<AttendeeNeedsProfile | null>(null);
const loading = ref(true);
const errorMessage = ref('');
const rendersChildPage = computed(() => /\/(showcase|needs)\/?$/u.test(route.path));
const registrationStatusLabels: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审核',
  pending_payment: '待支付',
  confirmed: '已确认',
  cancelled: '已取消',
  checked_in: '已签到',
  completed: '已完成',
};
const orderStatusLabels: Record<string, string> = {
  pending_review: '待审核',
  pending_payment: '待支付',
  processing: '处理中',
  paid: '已支付',
  partially_refunded: '部分退款',
  refunded: '已退款',
  closed: '已关闭',
};
const canOpenShowcase = computed(() =>
  ['confirmed', 'checked_in'].includes(detail.value?.registrationStatus ?? ''),
);
const canEditNeeds = computed(() => Boolean(attendeeNeeds.value?.id || attendeeNeeds.value?.canCreate));
const canOpenTicket = computed(() => Boolean(detail.value?.ticketCode));
const detailTicketHref = computed(() => {
  const value = detail.value;
  return value?.ticketCode
    ? customerRegistrationTicketHref(value.ticketCode, value.eventSlug)
    : '/account';
});
const canOpenInvoice = computed(() => {
  const value = detail.value;
  return Boolean(
    value?.canManageOrder &&
      value.amount > 0 &&
      ['paid', 'partially_refunded'].includes(value.orderStatus),
  );
});
const hasDetailActions = computed(
  () => canOpenShowcase.value || canEditNeeds.value || canOpenTicket.value || canOpenInvoice.value,
);

const money = (amount: number) =>
  amount === 0 ? '免费' : `¥${(amount / 100).toLocaleString('zh-CN')}`;

async function load() {
  if (rendersChildPage.value) return;
  loading.value = true;
  try {
    await customer.refresh();
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    [detail.value, attendeeNeeds.value] = await Promise.all([
      customer.registration(String(route.params.id)),
      customer.attendeeNeeds(String(route.params.id)).catch(() => null),
    ]);
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '报名详情加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!rendersChildPage.value) void load();
});
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void load();
  },
);

useHead({ title: '报名详情' });
</script>

<template>
  <NuxtPage v-if="rendersChildPage" />
  <div v-else class="flow-page">
    <FlowHeader />
    <main id="main-content" class="detail-shell">
      <NuxtLink class="detail-back" to="/account">← 返回用户中心</NuxtLink>
      <p v-if="loading" class="detail-state">正在加载报名详情…</p>
      <p v-else-if="errorMessage" class="detail-state is-error">{{ errorMessage }}</p>
      <article v-else-if="detail" class="detail-panel">
        <header>
          <div>
            <p class="flow-eyebrow">REGISTRATION DETAIL</p>
            <h1>{{ detail.eventName }}</h1>
            <p>
              {{ new Date(detail.startsAt).toLocaleString('zh-CN') }} 至
              {{ new Date(detail.endsAt).toLocaleString('zh-CN') }}
            </p>
          </div>
          <span>{{ detail.registrationCode }}</span>
        </header>
        <dl class="detail-grid">
          <div>
            <dt>参会人</dt>
            <dd>{{ detail.attendee.name || '待完善' }}</dd>
          </div>
          <div>
            <dt>手机号</dt>
            <dd>{{ detail.attendee.mobile }}</dd>
          </div>
          <div>
            <dt>票种</dt>
            <dd>{{ detail.ticketTypeName }}</dd>
          </div>
          <div v-if="detail.canManageOrder">
            <dt>订单金额</dt>
            <dd>{{ money(detail.amount) }}</dd>
          </div>
          <div>
            <dt>报名状态</dt>
            <dd>
              {{ registrationStatusLabels[detail.registrationStatus] ?? detail.registrationStatus }}
            </dd>
          </div>
          <div v-if="detail.canManageOrder">
            <dt>订单状态</dt>
            <dd>{{ orderStatusLabels[detail.orderStatus] ?? detail.orderStatus }}</dd>
          </div>
          <div>
            <dt>公司</dt>
            <dd>{{ detail.attendee.company || '未填写' }}</dd>
          </div>
          <div>
            <dt>邮箱</dt>
            <dd>{{ detail.attendee.email || '未填写' }}</dd>
          </div>
        </dl>
        <footer v-if="hasDetailActions">
          <NuxtLink
            v-if="canOpenShowcase"
            class="detail-primary"
            :to="`/account/registrations/${detail.id}/showcase?event=${encodeURIComponent(detail.eventSlug)}`"
          >
            完善参会名片
          </NuxtLink>
          <NuxtLink
            v-if="canEditNeeds"
            class="detail-secondary"
            :to="`/account/registrations/${detail.id}/needs?event=${encodeURIComponent(detail.eventSlug)}`"
          >
            编辑参会需求
          </NuxtLink>
          <NuxtLink
            v-if="canOpenTicket"
            class="detail-secondary"
            :to="detailTicketHref"
          >
            查看电子票
          </NuxtLink>
          <NuxtLink
            v-if="canOpenInvoice"
            class="detail-secondary"
            :to="`/account/invoices/${detail.orderId}`"
          >
            {{ detail.invoiceId ? '查看发票' : '申请发票' }}
          </NuxtLink>
        </footer>
      </article>
    </main>
  </div>
</template>

<style scoped>
.detail-shell {
  width: min(100% - 40px, 880px);
  margin-inline: auto;
  padding: 44px 0 80px;
}
.detail-back {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  color: var(--conference-ink-muted);
  font-size: 13px;
  transition: transform 110ms ease;
}
.detail-back:active {
  transform: scale(0.98);
}
.detail-panel {
  margin-top: 18px;
  overflow: hidden;
  border-radius: var(--conference-radius-md);
  background: #fff;
  box-shadow:
    0 1px 3px rgb(15 23 42 / 10%),
    0 16px 42px rgb(15 23 42 / 6%);
}
.detail-panel header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 30px;
  border-bottom: 1px solid var(--conference-line);
}
.detail-panel h1 {
  max-width: 20ch;
  margin: 0;
  font-size: clamp(26px, 4vw, 38px);
  letter-spacing: -0.03em;
  line-height: 1.18;
  text-wrap: balance;
}
.detail-panel header p:last-child {
  margin: 10px 0 0;
  color: var(--conference-ink-muted);
  font-size: 13px;
}
.detail-panel header > span {
  max-width: 100%;
  padding: 6px 9px;
  border-radius: 6px;
  background: #f4f4f5;
  color: #52525b;
  font-family: var(--conference-font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  margin: 0;
  padding: 8px 30px;
}
.detail-grid > div {
  padding: 20px 0;
  border-bottom: 1px solid var(--conference-line);
}
.detail-grid > div:nth-last-child(-n + 2) {
  border-bottom: 0;
}
.detail-grid dt {
  color: var(--conference-ink-muted);
  font-size: 11px;
}
.detail-grid dd {
  margin: 6px 0 0;
  color: var(--conference-ink);
  font-size: 14px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.detail-panel footer {
  display: flex;
  gap: 10px;
  padding: 20px 30px;
  background: #fafafa;
}
.detail-primary,
.detail-secondary {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  padding: 0 16px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 700;
}
.detail-primary {
  background: var(--conference-primary);
  color: #fff;
}
.detail-secondary {
  background: #e4e4e7;
  color: #27272a;
}
.detail-primary:active,
.detail-secondary:active {
  transform: scale(0.98);
}
.detail-state {
  padding: 64px 0;
  color: var(--conference-ink-muted);
  text-align: center;
}
.detail-state.is-error {
  color: #be123c;
}
@media (max-width: 640px) {
  .detail-shell {
    width: min(100% - 28px, 880px);
  }
  .detail-panel header {
    display: block;
    padding: 24px 20px;
  }
  .detail-panel header > span {
    display: inline-block;
    margin-top: 18px;
  }
  .detail-grid {
    grid-template-columns: 1fr;
    padding-inline: 20px;
  }
  .detail-grid > div:nth-last-child(2) {
    border-bottom: 1px solid var(--conference-line);
  }
  .detail-panel footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 18px 20px;
  }
  .detail-primary,
  .detail-secondary {
    min-height: 44px;
    justify-content: center;
    text-align: center;
  }
  .detail-primary {
    grid-column: 1 / -1;
  }
}
@media (max-width: 380px) {
  .detail-panel footer {
    grid-template-columns: 1fr;
  }
  .detail-primary {
    grid-column: auto;
  }
}
</style>
