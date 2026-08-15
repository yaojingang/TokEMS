<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import { dateTime, statusClass, statusLabel } from '../lib/format';

type NotificationDelivery = {
  id: string;
  channel: string;
  recipient: string;
  subject: string;
  status: string;
  error?: string | null;
  sentAt?: string | null;
  createdAt: string;
};

const PAGE_SIZE = 20;

const route = useRoute();
const deliveries = ref<NotificationDelivery[]>([]);
const page = ref(1);
const loading = ref(true);
const errorMessage = ref('');
const canSend = session.can('event.notification.send');
const totalPages = computed(() => Math.max(1, Math.ceil(deliveries.value.length / PAGE_SIZE)));
const paginatedDeliveries = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return deliveries.value.slice(start, start + PAGE_SIZE);
});
const visibleRange = computed(() => {
  if (!deliveries.value.length) return '0 条通知';
  const start = (page.value - 1) * PAGE_SIZE + 1;
  const end = start + paginatedDeliveries.value.length - 1;
  return `第 ${start}–${end} 条，共 ${deliveries.value.length} 条通知`;
});
const queuedMessage = computed(() =>
  route.query.queued === '1' ? '消息通知已加入发送队列。' : '',
);

function channelLabel(channel: string) {
  return (
    {
      email: '邮件',
      sms: '短信',
      wechat: '微信',
    }[channel] ?? channel
  );
}

function changePage(nextPage: number) {
  page.value = Math.min(Math.max(nextPage, 1), totalPages.value);
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  window.scrollTo({ top: 0, behavior });
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    deliveries.value = (await conferenceApi.getNotificationDeliveries()) as NotificationDelivery[];
    page.value = Math.min(page.value, totalPages.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通知数据读取失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">MESSAGE OPERATIONS</p>
      <h1>通知中心</h1>
      <p>查看当前大会的消息通知、接收对象与投递状态。</p>
    </div>
  </header>

  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <p v-if="queuedMessage" class="admin-success" role="status">{{ queuedMessage }}</p>

  <section class="admin-panel reveal is-visible">
    <header class="admin-panel-header">
      <div>
        <h2>通知列表</h2>
        <p>每页显示 20 条，最新通知排在最前</p>
      </div>
      <div class="admin-head-actions">
        <span class="status-badge">{{ deliveries.length }} MESSAGES</span>
        <RouterLink
          v-if="canSend"
          class="button"
          :to="{
            name: 'event-notification-create',
            params: { eventId: route.params.eventId },
          }"
        >
          新建消息通知
        </RouterLink>
      </div>
    </header>

    <div class="data-table-wrap">
      <table class="data-table notification-table">
        <caption class="sr-only">
          大会消息通知列表
        </caption>
        <thead>
          <tr>
            <th>消息内容</th>
            <th>接收对象</th>
            <th>渠道</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>发送时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in paginatedDeliveries" :key="item.id">
            <td class="notification-subject-cell">
              <span class="row-title">{{ item.subject }}</span>
              <span class="row-sub mono-code">{{ item.id }}</span>
            </td>
            <td class="mono-code">{{ item.recipient }}</td>
            <td>{{ channelLabel(item.channel) }}</td>
            <td>
              <span class="status-badge" :class="statusClass(item.status)">
                {{ statusLabel(item.status) }}
              </span>
              <span v-if="item.error" class="row-sub notification-error">{{ item.error }}</span>
            </td>
            <td>{{ dateTime(item.createdAt) }}</td>
            <td>{{ item.sentAt ? dateTime(item.sentAt) : '等待发送' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="admin-loading" role="status">正在读取通知记录…</div>
      <div v-else-if="!deliveries.length" class="admin-empty">
        当前大会暂无通知记录，可以新建第一条消息通知。
      </div>
    </div>

    <footer class="table-footer notification-pagination">
      <span>{{ visibleRange }} · 时间均为 Asia/Shanghai</span>
      <nav v-if="totalPages > 1" class="notification-page-nav" aria-label="通知列表分页">
        <button
          type="button"
          aria-label="上一页"
          :disabled="page === 1"
          @click="changePage(page - 1)"
        >
          ‹
        </button>
        <button
          v-for="pageNumber in totalPages"
          :key="pageNumber"
          type="button"
          :class="{ active: pageNumber === page }"
          :aria-current="pageNumber === page ? 'page' : undefined"
          :aria-label="`第 ${pageNumber} 页`"
          @click="changePage(pageNumber)"
        >
          {{ pageNumber }}
        </button>
        <button
          type="button"
          aria-label="下一页"
          :disabled="page === totalPages"
          @click="changePage(page + 1)"
        >
          ›
        </button>
      </nav>
    </footer>
  </section>
</template>

<style scoped>
.notification-table {
  min-width: 920px;
}

.notification-subject-cell {
  min-width: 320px;
}

.notification-error {
  max-width: 240px;
  color: var(--red);
  white-space: normal;
}

.notification-pagination {
  min-height: 64px;
  flex-wrap: wrap;
}

.notification-page-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.notification-page-nav button {
  width: 40px;
  height: 40px;
  padding: 0;
  color: var(--muted);
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  font-family: var(--mono);
  font-size: 10px;
  transition:
    color 140ms var(--ease),
    background-color 140ms var(--ease),
    border-color 140ms var(--ease),
    transform 140ms var(--ease);
}

.notification-page-nav button:active {
  transform: scale(0.96);
}

.notification-page-nav button.active {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
}

.notification-page-nav button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.notification-page-nav button:focus-visible {
  border-color: var(--blue);
  outline: 2px solid color-mix(in srgb, var(--blue) 18%, transparent);
  outline-offset: 1px;
}

@media (hover: hover) {
  .notification-page-nav button:hover:not(:disabled, .active) {
    color: var(--blue);
    background: var(--blue-soft);
    border-color: color-mix(in srgb, var(--blue) 28%, var(--line));
  }
}

@media (max-width: 700px) {
  .admin-panel-header {
    align-items: stretch;
    flex-direction: column;
  }

  .admin-panel-header .admin-head-actions {
    width: 100%;
    justify-content: space-between;
  }

  .notification-pagination {
    justify-content: center;
  }

  .notification-pagination > span {
    width: 100%;
    text-align: center;
  }
}
</style>
