<script setup lang="ts">
import type { CustomerRegistrationDetail } from '@conference/contracts';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import { customerRegistrationTicketHref } from '~/utils/purchase-journey';

const route = useRoute();
const customer = useCustomerSession();
const detail = ref<CustomerRegistrationDetail | null>(null);
const loading = ref(true);
const errorMessage = ref('');
const rendersChildPage = computed(() => /\/showcase\/?$/u.test(route.path));

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
    detail.value = await customer.registration(String(route.params.id));
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
            <dd>{{ detail.registrationStatus }}</dd>
          </div>
          <div v-if="detail.canManageOrder">
            <dt>订单状态</dt>
            <dd>{{ detail.orderStatus }}</dd>
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
        <footer>
          <NuxtLink
            v-if="['confirmed', 'checked_in'].includes(detail.registrationStatus)"
            class="detail-primary"
            :to="`/account/registrations/${detail.id}/showcase?event=${encodeURIComponent(detail.eventSlug)}`"
          >
            完善参会名片
          </NuxtLink>
          <NuxtLink
            v-if="detail.ticketCode"
            class="detail-secondary"
            :to="customerRegistrationTicketHref(detail.ticketCode, detail.eventSlug)"
          >
            查看电子票
          </NuxtLink>
          <NuxtLink
            v-if="
              detail.canManageOrder &&
                detail.amount > 0 &&
                ['paid', 'partially_refunded'].includes(detail.orderStatus)
            "
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
  min-height: 40px;
  align-items: center;
  color: var(--conference-ink-muted);
  font-size: 13px;
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
  margin: 0;
  font-size: clamp(26px, 4vw, 38px);
  letter-spacing: -0.03em;
}
.detail-panel header p:last-child {
  margin: 10px 0 0;
  color: var(--conference-ink-muted);
  font-size: 13px;
}
.detail-panel header > span {
  padding: 6px 9px;
  border-radius: 6px;
  background: #f4f4f5;
  color: #52525b;
  font-family: var(--conference-font-mono);
  font-size: 11px;
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
    padding: 18px 20px;
  }
}
</style>
