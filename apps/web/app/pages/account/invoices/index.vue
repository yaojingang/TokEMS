<script setup lang="ts">
import type {
  CustomerInvoiceCenterCategory,
  CustomerInvoiceCenterCounts,
  CustomerInvoiceCenterItem,
} from '@conference/contracts';
import { watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  customerInvoiceCategories,
  customerInvoicePrimaryAction,
  customerInvoiceStatusCopy,
  invoiceDate,
  invoiceMoney,
} from '~/utils/customer-invoice';

const route = useRoute();
const router = useRouter();
const customer = useCustomerSession();
const validCategories = new Set<CustomerInvoiceCenterCategory>(
  customerInvoiceCategories.map((item) => item.value),
);
const requestedCategory = String(route.query.category ?? '');
const initialCategory = validCategories.has(requestedCategory as CustomerInvoiceCenterCategory)
  ? (requestedCategory as CustomerInvoiceCenterCategory)
  : 'all';
const category = ref<CustomerInvoiceCenterCategory>(initialCategory);
const items = ref<CustomerInvoiceCenterItem[]>([]);
const counts = ref<CustomerInvoiceCenterCounts>({
  all: 0,
  eligible: 0,
  actionRequired: 0,
  processing: 0,
  issued: 0,
  history: 0,
});
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const errorMessage = ref('');

function itemPresentation(item: CustomerInvoiceCenterItem) {
  if (!item.status) {
    return {
      label: '可申请',
      description: '订单已支付，可以提交开票资料',
      tone: 'info' as const,
    };
  }
  return customerInvoiceStatusCopy[item.status];
}

async function load(append = false) {
  if (append) loadingMore.value = true;
  else {
    loading.value = true;
    items.value = [];
    nextCursor.value = null;
  }
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    const result = await customer.invoices(
      category.value,
      append ? (nextCursor.value ?? undefined) : undefined,
    );
    items.value = append ? [...items.value, ...result.items] : result.items;
    counts.value = result.counts;
    nextCursor.value = result.nextCursor;
  } catch (error) {
    const value = error as { data?: { message?: string } };
    errorMessage.value = value.data?.message ?? '发票记录加载失败，请稍后重试';
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function selectCategory(value: CustomerInvoiceCenterCategory) {
  if (value === category.value) return;
  category.value = value;
  await router.replace({
    query: value === 'all' ? {} : { category: value },
  });
  await load();
}

function selectCategoryFromEvent(event: Event) {
  void selectCategory((event.target as HTMLSelectElement).value as CustomerInvoiceCenterCategory);
}

onMounted(() => void load());
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !loading.value) void load();
  },
);
watch(
  () => route.query.category,
  (value) => {
    const requested = String(value ?? '');
    const nextCategory = validCategories.has(requested as CustomerInvoiceCenterCategory)
      ? (requested as CustomerInvoiceCenterCategory)
      : 'all';
    if (nextCategory !== category.value) {
      category.value = nextCategory;
      void load();
    }
  },
);
useHead({ title: '发票中心' });
</script>

<template>
  <div class="flow-page invoice-center-page">
    <FlowHeader />
    <main id="main-content" class="invoice-center-shell">
      <NuxtLink class="invoice-center-back" to="/account#invoices">
        <span aria-hidden="true">←</span> 返回个人中心
      </NuxtLink>

      <header class="invoice-center-heading">
        <div>
          <p>INVOICE CENTER</p>
          <h1>发票中心</h1>
          <span>集中管理大会订单的申请、审核、文件下载与历史记录。</span>
        </div>
        <NuxtLink class="invoice-center-event-link" to="/account#events">
          查看我的大会 <span aria-hidden="true">↗</span>
        </NuxtLink>
      </header>

      <div v-if="loading" class="invoice-center-loading" role="status">
        <span aria-hidden="true"></span>
        <p>正在汇总发票记录</p>
      </div>

      <template v-else-if="customer.session.value">
        <p v-if="errorMessage" class="invoice-center-message" role="alert">
          {{ errorMessage }}
        </p>

        <section class="invoice-center-overview" aria-label="发票概览">
          <div>
            <span>可申请</span>
            <strong>{{ counts.eligible }}</strong>
            <small>已支付订单</small>
          </div>
          <div :class="{ attention: counts.actionRequired > 0 }">
            <span>待我处理</span>
            <strong>{{ counts.actionRequired }}</strong>
            <small>{{ counts.actionRequired ? '请及时完善资料' : '当前无待办' }}</small>
          </div>
          <div>
            <span>处理中</span>
            <strong>{{ counts.processing }}</strong>
            <small>审核与开具进度</small>
          </div>
          <div>
            <span>已开具</span>
            <strong>{{ counts.issued }}</strong>
            <small>可下载文件</small>
          </div>
        </section>

        <section class="invoice-center-records" aria-labelledby="records-title">
          <header class="invoice-center-section-head">
            <div>
              <p>01 / RECORDS</p>
              <h2 id="records-title">发票记录</h2>
            </div>
            <span>{{ counts.all }} 条相关订单</span>
          </header>

          <nav class="invoice-center-tabs" aria-label="发票记录分类">
            <button
              v-for="option in customerInvoiceCategories"
              :key="option.value"
              type="button"
              :class="{ active: category === option.value }"
              :aria-current="category === option.value ? 'page' : undefined"
              @click="selectCategory(option.value)"
            >
              {{ option.label }}
              <span>{{ counts[option.countKey] }}</span>
            </button>
          </nav>
          <label class="invoice-center-mobile-filter">
            <span>记录分类</span>
            <select :value="category" @change="selectCategoryFromEvent">
              <option
                v-for="option in customerInvoiceCategories"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}（{{ counts[option.countKey] }}）
              </option>
            </select>
          </label>

          <div v-if="items.length" class="invoice-center-list">
            <article v-for="item in items" :key="item.orderId" class="invoice-center-row">
              <div class="invoice-center-date" aria-hidden="true">
                <span>{{
                  new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(
                    new Date(item.startsAt),
                  )
                }}</span>
                <strong>{{ String(new Date(item.startsAt).getDate()).padStart(2, '0') }}</strong>
              </div>
              <div class="invoice-center-row__body">
                <div class="invoice-center-row__head">
                  <div>
                    <h3>{{ item.eventName }}</h3>
                    <p>订单 {{ item.orderNo }}</p>
                  </div>
                  <span class="invoice-center-status" :data-tone="itemPresentation(item).tone">
                    <i aria-hidden="true"></i>{{ itemPresentation(item).label }}
                  </span>
                </div>
                <div class="invoice-center-row__details">
                  <dl>
                    <div>
                      <dt>{{ item.invoiceId ? '发票金额' : '可开票金额' }}</dt>
                      <dd>
                        {{ invoiceMoney(item.invoiceAmount ?? item.eligibleAmount, item.currency) }}
                      </dd>
                    </div>
                    <div>
                      <dt>发票抬头</dt>
                      <dd>{{ item.title ?? '提交申请时填写' }}</dd>
                    </div>
                    <div>
                      <dt>{{ item.invoiceId ? '最近更新' : '支付状态' }}</dt>
                      <dd>{{ item.invoiceId ? invoiceDate(item.updatedAt, true) : '已支付' }}</dd>
                    </div>
                  </dl>
                  <p>{{ itemPresentation(item).description }}</p>
                </div>
                <div class="invoice-center-row__action">
                  <NuxtLink :to="`/account/invoices/${item.orderId}`">
                    {{ customerInvoicePrimaryAction(item) }} <span aria-hidden="true">→</span>
                  </NuxtLink>
                  <small v-if="item.requestNo">申请编号 {{ item.requestNo }}</small>
                </div>
              </div>
            </article>
            <button
              v-if="nextCursor"
              class="invoice-center-more"
              type="button"
              :disabled="loadingMore"
              @click="load(true)"
            >
              {{ loadingMore ? '正在加载' : '加载更多记录' }}
            </button>
          </div>

          <div v-else class="invoice-center-empty">
            <span>00</span>
            <div>
              <strong>这个分类暂无记录</strong>
              <p>
                {{
                  category === 'eligible'
                    ? '收费订单完成支付后，会在这里显示可申请发票的记录。'
                    : '新的发票状态变化会自动汇总到对应分类。'
                }}
              </p>
              <button v-if="category !== 'all'" type="button" @click="selectCategory('all')">
                查看全部记录
              </button>
            </div>
          </div>
        </section>

        <aside class="invoice-center-note">
          <span aria-hidden="true">i</span>
          <div>
            <strong>关于发票修改</strong>
            <p>
              待补充、待修改和待审核阶段可以更新开票信息。进入开具流程后，如需更正请联系主办方。
            </p>
          </div>
        </aside>
      </template>
    </main>
  </div>
</template>

<style scoped>
.invoice-center-page {
  min-height: 100vh;
  background: #f4f5f7;
  color: #17191d;
}

.invoice-center-shell {
  width: min(100% - 40px, 1120px);
  margin-inline: auto;
  padding: 38px 0 100px;
}

.invoice-center-back,
.invoice-center-event-link {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 9px;
  color: #6f737c;
  font-size: 13px;
  font-weight: 680;
  text-decoration: none;
  transition:
    color 150ms ease,
    transform 150ms ease;
}

.invoice-center-back:active,
.invoice-center-event-link:active,
.invoice-center-tabs button:active,
.invoice-center-row__action a:active,
.invoice-center-more:active {
  transform: scale(0.97);
}

.invoice-center-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin: 22px 0 30px;
}

.invoice-center-heading p,
.invoice-center-section-head p {
  margin: 0 0 8px;
  color: var(--conference-primary);
  font-family: var(--conference-font-mono);
  font-size: 9px;
  font-weight: 720;
  letter-spacing: 0.11em;
}

.invoice-center-heading h1 {
  margin: 0;
  font-size: clamp(30px, 3.2vw, 34px);
  font-weight: 850;
  line-height: 1.12;
  text-wrap: balance;
}

.invoice-center-heading > div > span {
  display: block;
  margin-top: 12px;
  color: #6f737c;
  font-size: 14px;
  line-height: 1.7;
}

.invoice-center-loading {
  display: grid;
  min-height: 460px;
  place-content: center;
  justify-items: center;
  gap: 14px;
  color: #6f737c;
  font-size: 13px;
}

.invoice-center-loading span {
  width: 28px;
  height: 28px;
  border: 2px solid #dbe6f7;
  border-top-color: var(--conference-primary);
  border-radius: 50%;
  animation: invoice-center-spin 800ms linear infinite;
}

@keyframes invoice-center-spin {
  to {
    transform: rotate(360deg);
  }
}

.invoice-center-message {
  margin: 0 0 18px;
  padding: 12px 14px;
  border-radius: 8px;
  background: #fff3f2;
  color: #a83e38;
  font-size: 13px;
}

.invoice-center-overview {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  overflow: hidden;
  border: 1px solid #dfe3e9;
  border-radius: 11px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 10%);
}

.invoice-center-overview > div {
  display: grid;
  gap: 5px;
  padding: 20px 22px 22px;
  border-right: 1px solid #eceef2;
}

.invoice-center-overview > div:last-child {
  border-right: 0;
}

.invoice-center-overview span,
.invoice-center-overview small {
  color: #737780;
  font-size: 10px;
}

.invoice-center-overview strong {
  font-family: var(--conference-font-mono);
  font-size: 24px;
  font-variant-numeric: tabular-nums;
}

.invoice-center-overview .attention strong {
  color: #aa6c12;
}

.invoice-center-records {
  margin-top: 30px;
  overflow: hidden;
  border: 1px solid #dfe3e9;
  border-radius: 11px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 10%);
}

.invoice-center-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 26px 20px;
}

.invoice-center-section-head h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 820;
}

.invoice-center-section-head > span {
  color: #777b84;
  font-size: 11px;
}

.invoice-center-tabs {
  display: flex;
  overflow-x: auto;
  padding: 0 18px;
  border-top: 1px solid #eceef2;
  border-bottom: 1px solid #dfe3e9;
  scrollbar-width: none;
}

.invoice-center-tabs::-webkit-scrollbar {
  display: none;
}

.invoice-center-tabs button {
  position: relative;
  display: inline-flex;
  min-width: max-content;
  min-height: 48px;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  color: #777b84;
  font-size: 12px;
  font-weight: 680;
  transition:
    color 150ms ease,
    transform 150ms ease;
}

.invoice-center-tabs button::after {
  position: absolute;
  right: 12px;
  bottom: -1px;
  left: 12px;
  height: 2px;
  background: transparent;
  content: '';
}

.invoice-center-tabs button.active {
  color: #17191d;
}

.invoice-center-tabs button.active::after {
  background: var(--conference-primary);
}

.invoice-center-tabs button span {
  min-width: 19px;
  padding: 2px 5px;
  border-radius: 999px;
  background: #f0f2f5;
  color: #777b84;
  font-family: var(--conference-font-mono);
  font-size: 8px;
  text-align: center;
}

.invoice-center-mobile-filter {
  display: none;
}

.invoice-center-list {
  padding: 0 26px 22px;
}

.invoice-center-row {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 20px;
  padding: 24px 0;
  border-bottom: 1px solid #e7e9ed;
}

.invoice-center-date {
  display: grid;
  height: 68px;
  align-content: center;
  justify-items: center;
  border: 1px solid #d8e1ef;
  border-radius: 8px;
  background: #f3f7fd;
}

.invoice-center-date span {
  color: #6680a6;
  font-size: 9px;
}

.invoice-center-date strong {
  margin-top: 2px;
  font-family: var(--conference-font-mono);
  font-size: 20px;
}

.invoice-center-row__body {
  min-width: 0;
}

.invoice-center-row__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.invoice-center-row__head h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 780;
  line-height: 1.4;
}

.invoice-center-row__head p {
  margin: 5px 0 0;
  color: #858991;
  font-family: var(--conference-font-mono);
  font-size: 9px;
}

.invoice-center-status {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 1px solid #cfd9e9;
  border-radius: 999px;
  background: #f4f7fc;
  color: #315d9a;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.invoice-center-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}

.invoice-center-status[data-tone='success'] {
  border-color: #b9ddce;
  background: #f0faf6;
  color: #167653;
}

.invoice-center-status[data-tone='warning'] {
  border-color: #eed6a9;
  background: #fff9ec;
  color: #946313;
}

.invoice-center-status[data-tone='neutral'] {
  border-color: #d9dce2;
  background: #f5f5f6;
  color: #666a72;
}

.invoice-center-row__details {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  align-items: end;
  gap: 24px;
  margin-top: 17px;
}

.invoice-center-row__details dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}

.invoice-center-row__details dl div {
  min-width: 0;
  padding-right: 14px;
}

.invoice-center-row__details dt {
  color: #858991;
  font-size: 9px;
}

.invoice-center-row__details dd {
  overflow-wrap: anywhere;
  margin: 5px 0 0;
  font-size: 11px;
  font-weight: 670;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

.invoice-center-row__details > p {
  margin: 0;
  color: #6f737c;
  font-size: 11px;
  line-height: 1.6;
  text-align: right;
}

.invoice-center-row__action {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 16px;
}

.invoice-center-row__action a {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  gap: 16px;
  padding: 0 15px;
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

.invoice-center-row__action small {
  color: #969aa2;
  font-family: var(--conference-font-mono);
  font-size: 8px;
}

.invoice-center-more {
  display: flex;
  min-height: 44px;
  align-items: center;
  margin: 18px auto 0;
  padding: 0 15px;
  border: 1px solid #ccd3de;
  border-radius: 8px;
  color: #4d525b;
  font-size: 12px;
  font-weight: 680;
  transition: transform 150ms ease;
}

.invoice-center-empty {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  align-items: center;
  gap: 26px;
  min-height: 260px;
  padding: 40px 44px;
}

.invoice-center-empty > span {
  color: #dbe1e9;
  font-family: var(--conference-font-mono);
  font-size: 56px;
  font-weight: 740;
}

.invoice-center-empty strong {
  font-size: 18px;
}

.invoice-center-empty p {
  margin: 8px 0 0;
  color: #6f737c;
  font-size: 12px;
  line-height: 1.7;
}

.invoice-center-empty button {
  min-height: 40px;
  margin-top: 12px;
  color: var(--conference-primary);
  font-size: 12px;
  font-weight: 700;
}

.invoice-center-note {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 12px;
  margin-top: 18px;
  padding: 17px 19px;
  border: 1px solid #d5e1f2;
  border-radius: 10px;
  background: #f1f6fd;
}

.invoice-center-note > span {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: #dbe8fa;
  color: #315d9a;
  font-family: serif;
  font-size: 12px;
  font-weight: 700;
}

.invoice-center-note strong {
  font-size: 12px;
}

.invoice-center-note p {
  margin: 5px 0 0;
  color: #61718b;
  font-size: 11px;
  line-height: 1.65;
}

@media (hover: hover) {
  .invoice-center-back:hover,
  .invoice-center-event-link:hover {
    color: var(--conference-primary);
  }

  .invoice-center-row__action a:hover {
    opacity: 0.9;
  }
}

@media (max-width: 760px) {
  .invoice-center-overview {
    grid-template-columns: 1fr 1fr;
  }

  .invoice-center-overview > div:nth-child(2) {
    border-right: 0;
  }

  .invoice-center-overview > div:nth-child(-n + 2) {
    border-bottom: 1px solid #eceef2;
  }

  .invoice-center-row__details {
    grid-template-columns: 1fr;
  }

  .invoice-center-row__details > p {
    text-align: left;
  }
}

@media (max-width: 560px) {
  .invoice-center-shell {
    width: min(100% - 28px, 1120px);
    padding: 24px 0 calc(72px + env(safe-area-inset-bottom));
  }

  .invoice-center-heading {
    display: grid;
    margin-top: 16px;
  }

  .invoice-center-heading h1 {
    font-size: 29px;
  }

  .invoice-center-event-link {
    justify-self: start;
  }

  .invoice-center-overview > div {
    padding: 17px 18px 19px;
  }

  .invoice-center-section-head,
  .invoice-center-list {
    padding-inline: 18px;
  }

  .invoice-center-tabs {
    display: none;
  }

  .invoice-center-mobile-filter {
    display: grid;
    gap: 7px;
    padding: 14px 18px 16px;
    border-top: 1px solid #eceef2;
    border-bottom: 1px solid #dfe3e9;
    color: #6f737c;
    font-size: 10px;
    font-weight: 680;
  }

  .invoice-center-mobile-filter select {
    width: 100%;
    min-height: 44px;
    padding: 0 34px 0 12px;
    border: 1px solid #d9dee6;
    border-radius: 7px;
    background: #fff;
    color: #17191d;
    font-size: 16px;
    font-weight: 680;
  }

  .invoice-center-row {
    grid-template-columns: 48px minmax(0, 1fr);
    gap: 14px;
  }

  .invoice-center-date {
    height: 58px;
  }

  .invoice-center-date strong {
    font-size: 17px;
  }

  .invoice-center-row__head {
    display: grid;
  }

  .invoice-center-status {
    justify-self: start;
  }

  .invoice-center-row__details dl {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .invoice-center-row__action {
    display: grid;
    justify-content: start;
  }

  .invoice-center-row__action a,
  .invoice-center-empty button,
  .invoice-center-more {
    min-height: 44px;
  }

  .invoice-center-empty {
    grid-template-columns: 1fr;
    padding: 34px 24px;
  }

  .invoice-center-empty > span {
    font-size: 42px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .invoice-center-loading span {
    animation: none;
  }

  .invoice-center-back,
  .invoice-center-event-link,
  .invoice-center-tabs button,
  .invoice-center-row__action a,
  .invoice-center-more {
    transition: none;
  }
}
</style>
