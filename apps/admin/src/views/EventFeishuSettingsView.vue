<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router';
import {
  FeishuDigestTestMessageSchema,
  nextFeishuDigestRun,
  feishuDigestReportWindow,
  type EventId,
  type FeishuBotConfiguration,
  type FeishuChat,
  type FeishuDigestDelivery,
  type FeishuDigestDeliveryDetail,
  type FeishuDigestSnapshot,
  type FeishuDigestSubscription,
  type FeishuDigestTestMessage,
} from '@conference/contracts';
import { AdminApiError, conferenceApi, session } from '../lib/api';
import { parseEventId } from '../lib/route-scope';
import { provideSettingsFormState } from '../composables/settings-form-state';
import FeishuConnectionPanel from '../components/feishu/FeishuConnectionPanel.vue';
import FeishuDigestPreview from '../components/feishu/FeishuDigestPreview.vue';
import SaveStatus from '../components/SaveStatus.vue';
import '../styles/feishu.css';

const route = useRoute();
const formState = provideSettingsFormState();
const eventId = computed(() => parseEventId(String(route.params.eventId ?? '')));
const canManage = computed(
  () => session.can('org.settings.manage') && session.can('event.dashboard.read'),
);
const configuration = ref<FeishuBotConfiguration>();
const subscription = ref<FeishuDigestSubscription>();
const snapshot = ref<FeishuDigestSnapshot>();
const records = ref<FeishuDigestDelivery[]>([]);
const detail = ref<FeishuDigestDeliveryDetail>();
const loading = ref(true);
const pending = ref(false);
const error = ref('');
const previewError = ref('');
const message = ref('');
const chatsError = ref('');
const chats = ref<FeishuChat[]>([]);
const chatsLoaded = ref(false);
const chatsLoading = ref(false);
const search = ref('');
const chatId = ref('');
const time = ref('09:00');
const editingTarget = ref(false);
const targetVersions = ref({ configVersion: 0, connectionVersion: 0 });
const visibilityConfirmed = ref(false);
const resendConfirmed = ref(false);
const activeDelivery = ref<FeishuDigestDeliveryDetail>();
const unresolvedTest = ref<{ key: string; input: FeishuDigestTestMessage; deliveryId?: string }>();
const recoveryKeys = new Map<string, string>();
const errorElement = ref<HTMLElement>();
let generation = 0;
let previewGeneration = 0;
let pollGeneration = 0;
let detailGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollStartedAt = 0;
const connectionReady = computed(
  () => configuration.value?.enabled && configuration.value.status === 'verified',
);
const step = computed(() =>
  !connectionReady.value ? 1 : !subscription.value?.chatId || editingTarget.value ? 2 : 3,
);
const filteredChats = computed(() =>
  chats.value.filter(
    (chat) =>
      chat.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()) ||
      chat.chatId.includes(search.value),
  ),
);
const firstReport = computed(() => {
  const sub = subscription.value;
  if (!sub) return null;
  const date = nextFeishuDigestRun(new Date(), sub.timezone, sub.sendLocalTime);
  return {
    sendAt: date.toISOString(),
    reportDate: feishuDigestReportWindow(date, sub.timezone).reportDate,
  };
});
const archived = computed(() => subscription.value?.eventStatus === 'archived');
const automaticallyEligible = computed(() =>
  ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(
    subscription.value?.eventStatus ?? '',
  ),
);
const targetDirty = computed(
  () =>
    editingTarget.value &&
    (chatId.value !== (subscription.value?.chatId ?? '') ||
      time.value !== subscription.value?.sendLocalTime),
);
const deliveryRunning = computed(
  () =>
    activeDelivery.value &&
    ['queued', 'generating', 'sending', 'retrying'].includes(activeDelivery.value.status),
);
const statusLabels: Record<FeishuDigestDelivery['status'], string> = {
  queued: '等待发送',
  generating: '正在生成',
  sending: '正在发送',
  retrying: '等待重试',
  sent: '已发送',
  unknown: '结果待确认',
  failed: '发送失败',
  skipped: '已跳过',
  cancelled: '已取消',
};
const kindLabels = { scheduled: '自动日报', manual_test: '测试日报', manual_resend: '人工补发' };
function formatTime(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: subscription.value?.timezone ?? 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(new Date(value))
    : '暂无';
}
function storageKey() {
  return `tokems.feishu.test:${session.identity.value?.organization.id ?? ''}:${session.identity.value?.user.id ?? ''}:${eventId.value}`;
}
function persistTest() {
  try {
    if (unresolvedTest.value)
      sessionStorage.setItem(storageKey(), JSON.stringify(unresolvedTest.value));
    else sessionStorage.removeItem(storageKey());
  } catch {
    /* Server history remains the durable record when browser storage is unavailable. */
  }
}
function restoreTest() {
  unresolvedTest.value = undefined;
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey()) ?? 'null');
    const input = FeishuDigestTestMessageSchema.safeParse(value?.input);
    if (input.success && typeof value?.key === 'string' && value.key.length < 100)
      unresolvedTest.value = {
        key: value.key,
        input: input.data,
        ...(typeof value.deliveryId === 'string' ? { deliveryId: value.deliveryId } : {}),
      };
  } catch {
    /* Malformed local state never starts a new send. */
  }
  return unresolvedTest.value;
}
async function fail(caught: unknown) {
  error.value = caught instanceof Error ? caught.message : '操作未完成，请刷新后重试。';
  await nextTick();
  errorElement.value?.focus();
}
async function refreshPreview() {
  if (!eventId.value) return;
  const event = eventId.value;
  const request = ++previewGeneration;
  const scope = generation;
  previewError.value = '';
  try {
    const result = await conferenceApi.previewFeishuDigest(event);
    if (scope === generation && request === previewGeneration) snapshot.value = result.snapshot;
  } catch (caught) {
    if (scope === generation && request === previewGeneration) {
      snapshot.value = undefined;
      previewError.value = caught instanceof Error ? caught.message : '预览读取失败，请重试。';
    }
  }
}
async function copyBotName() {
  try {
    await navigator.clipboard.writeText(configuration.value?.appName ?? '');
    message.value = '机器人名称已复制';
  } catch {
    chatsError.value = '复制失败，请选中机器人名称后复制。';
  }
}
async function loadChats(refresh = false) {
  if (chatsLoading.value || !canManage.value || !connectionReady.value) return;
  const scope = generation;
  chatsLoading.value = true;
  chatsError.value = '';
  try {
    const result = refresh
      ? await conferenceApi.refreshFeishuChats()
      : await conferenceApi.getFeishuChats();
    if (scope !== generation) return;
    if (result.connectionVersion !== configuration.value?.connectionVersion)
      throw new Error('连接已变化，请刷新页面后重新选择。');
    chats.value = result.items;
    chatsLoaded.value = true;
    if (refresh && eventId.value) {
      const sub = await conferenceApi.getFeishuDigestSubscription(eventId.value);
      if (scope === generation) subscription.value = sub;
    }
  } catch (caught) {
    if (scope === generation) {
      chatsError.value = caught instanceof Error ? caught.message : '群列表未读取完整，请重试。';
      chatsLoaded.value = false;
    }
  } finally {
    if (scope === generation) chatsLoading.value = false;
  }
}
async function load() {
  const scope = ++generation;
  pollGeneration++;
  detailGeneration++;
  const event = eventId.value;
  if (pollTimer) clearTimeout(pollTimer);
  loading.value = true;
  pending.value = false;
  error.value = '';
  snapshot.value = undefined;
  detail.value = undefined;
  activeDelivery.value = undefined;
  configuration.value = undefined;
  subscription.value = undefined;
  records.value = [];
  chats.value = [];
  chatsLoaded.value = false;
  chatsLoading.value = false;
  editingTarget.value = false;
  visibilityConfirmed.value = false;
  unresolvedTest.value = undefined;
  recoveryKeys.clear();
  if (!event) {
    loading.value = false;
    error.value = '大会编号无效，请重新选择大会。';
    return;
  }
  try {
    const [config, sub, history] = await Promise.all([
      conferenceApi.getFeishuBotConfiguration(),
      conferenceApi.getFeishuDigestSubscription(event),
      conferenceApi.getFeishuDeliveries(event),
    ]);
    if (scope !== generation) return;
    configuration.value = config;
    subscription.value = sub;
    records.value = history;
    resetTargetDraft(sub);
    const restored = restoreTest();
    const runningTest = history.find(
      (item) =>
        item.kind === 'manual_test' &&
        ['queued', 'generating', 'sending', 'retrying'].includes(item.status),
    );
    const testId = restored ? restored.deliveryId : runningTest?.id;
    if (testId) startPolling(testId, event, scope);
    void refreshPreview();
    if (step.value === 2) void loadChats();
  } catch (caught) {
    if (scope === generation) await fail(caught);
  } finally {
    if (scope === generation) loading.value = false;
  }
}
async function connected(config: FeishuBotConfiguration) {
  const scope = generation;
  const event = eventId.value;
  configuration.value = config;
  visibilityConfirmed.value = false;
  chatsLoaded.value = false;
  if (!event) return;
  try {
    const sub = await conferenceApi.getFeishuDigestSubscription(event);
    if (scope === generation) {
      subscription.value = sub;
      resetTargetDraft(sub);
      void loadChats();
    }
  } catch (caught) {
    if (scope === generation) await fail(caught);
  }
}
function resetTargetDraft(sub: FeishuDigestSubscription) {
  chatId.value = sub.chatId ?? '';
  time.value = sub.sendLocalTime;
  targetVersions.value = {
    configVersion: sub.configVersion,
    connectionVersion: sub.connectionVersion,
  };
}
function editTarget() {
  if (!subscription.value) return;
  resetTargetDraft(subscription.value);
  editingTarget.value = true;
  void loadChats();
}
async function saveSettings(enabled: boolean) {
  const event = eventId.value;
  const sub = subscription.value;
  if (!event || !sub || pending.value || !canManage.value) return;
  const scope = generation;
  pending.value = true;
  error.value = '';
  message.value = '';
  const editing = editingTarget.value || !sub.chatId;
  const versions = editing ? targetVersions.value : sub;
  try {
    const updated = await conferenceApi.updateFeishuDigestSubscription(event, {
      expectedConfigVersion: versions.configVersion,
      expectedConnectionVersion: versions.connectionVersion,
      enabled,
      chatId: editing ? chatId.value || null : sub.chatId,
      chatName: editing
        ? (chats.value.find((chat) => chat.chatId === chatId.value)?.name ?? sub.chatName)
        : sub.chatName,
      sendLocalTime: editing ? time.value : sub.sendLocalTime,
    });
    if (scope !== generation) return;
    subscription.value = updated;
    resetTargetDraft(updated);
    editingTarget.value = false;
    visibilityConfirmed.value = false;
    message.value = enabled ? '每日推送已开启。' : '设置已保存。暂停前已提交的消息仍可能到达。';
    const history = await conferenceApi.getFeishuDeliveries(event);
    if (scope === generation) records.value = history;
  } catch (caught) {
    if (scope === generation) await fail(caught);
  } finally {
    if (scope === generation) pending.value = false;
  }
}
function startPolling(id: string, event: EventId, scope: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollStartedAt = Date.now();
  const request = ++pollGeneration;
  void poll(id, event, scope, request);
}
async function poll(id: string, event: EventId, scope: number, request: number) {
  if (scope !== generation || request !== pollGeneration) return;
  try {
    const result = await conferenceApi.getFeishuDelivery(event, id);
    if (scope !== generation || request !== pollGeneration) return;
    activeDelivery.value = result;
    records.value = [result, ...records.value.filter((row) => row.id !== result.id)].slice(0, 100);
    if (!['queued', 'generating', 'sending', 'retrying'].includes(result.status)) {
      if (unresolvedTest.value?.deliveryId === result.id) {
        unresolvedTest.value = undefined;
        persistTest();
      }
      const sub = await conferenceApi.getFeishuDigestSubscription(event);
      if (scope === generation && request === pollGeneration) subscription.value = sub;
      return;
    }
    const elapsed = Date.now() - pollStartedAt;
    if (elapsed < 120_000)
      pollTimer = setTimeout(
        () => {
          void poll(id, event, scope, request);
        },
        elapsed < 30_000 ? 2_000 : 5_000,
      );
  } catch (caught) {
    if (scope === generation && request === pollGeneration) await fail(caught);
  }
}
async function sendTest() {
  const event = eventId.value;
  const sub = subscription.value;
  if (!event || !sub?.chatId || pending.value || !canManage.value || archived.value) return;
  if (!unresolvedTest.value && !visibilityConfirmed.value) return;
  const scope = generation;
  pending.value = true;
  error.value = '';
  if (!unresolvedTest.value) {
    unresolvedTest.value = {
      key: crypto.randomUUID(),
      input: {
        chatId: sub.chatId,
        dataVisibilityConfirmed: true,
        expectedConfigVersion: sub.configVersion,
        expectedConnectionVersion: sub.connectionVersion,
      },
    };
    persistTest();
  }
  const attempt = unresolvedTest.value;
  try {
    const result = await conferenceApi.sendFeishuTest(event, attempt.input, attempt.key);
    if (scope !== generation) return;
    unresolvedTest.value = { ...attempt, deliveryId: result.deliveryId };
    persistTest();
    visibilityConfirmed.value = false;
    startPolling(result.deliveryId, event, scope);
  } catch (caught) {
    if (scope === generation) {
      // A definitive rejection cannot have accepted this request; network uncertainty keeps its key.
      if (
        caught instanceof AdminApiError &&
        caught.status >= 400 &&
        caught.status < 500 &&
        caught.details?.operationPending !== true &&
        ![408, 429].includes(caught.status)
      ) {
        unresolvedTest.value = undefined;
        persistTest();
        visibilityConfirmed.value = false;
      }
      await fail(caught);
    }
  } finally {
    if (scope === generation) pending.value = false;
  }
}
async function openDetail(id: string) {
  const scope = generation;
  const event = eventId.value;
  if (!event) return;
  const request = ++detailGeneration;
  detail.value = undefined;
  resendConfirmed.value = false;
  try {
    const result = await conferenceApi.getFeishuDelivery(event, id);
    if (scope === generation && request === detailGeneration) detail.value = result;
  } catch (caught) {
    if (scope === generation && request === detailGeneration) await fail(caught);
  }
}
async function recover(action: 'resend' | 'regenerate' | 'resolve') {
  const row = detail.value;
  const event = eventId.value;
  const sub = subscription.value;
  if (!row || !event || !sub || pending.value || !canManage.value) return;
  if (action === 'resend' && !resendConfirmed.value) return;
  const scope = generation;
  pending.value = true;
  error.value = '';
  const keyId = `${row.id}:${action}:${sub.configVersion}:${sub.connectionVersion}`;
  const key = recoveryKeys.get(keyId) ?? crypto.randomUUID();
  recoveryKeys.set(keyId, key);
  try {
    const result = await conferenceApi.recoverFeishuDelivery(
      event,
      row.id,
      action,
      {
        expectedConfigVersion: sub.configVersion,
        expectedConnectionVersion: sub.connectionVersion,
        ...(action === 'resend' ? { confirmResend: true } : {}),
      },
      key,
    );
    if (scope !== generation) return;
    recoveryKeys.delete(keyId);
    const [updated, history] = await Promise.all([
      conferenceApi.getFeishuDelivery(event, row.id),
      conferenceApi.getFeishuDeliveries(event),
    ]);
    if (scope !== generation) return;
    if (detail.value?.id === row.id) {
      detail.value = updated;
      resendConfirmed.value = false;
    }
    records.value = history;
    message.value =
      action === 'resolve'
        ? '已记录人工确认，原发送结果保留。'
        : '任务已提交，可在发送记录查看进度。';
    if (action !== 'resolve') startPolling(result.deliveryId, event, scope);
  } catch (caught) {
    if (scope === generation) await fail(caught);
  } finally {
    if (scope === generation) pending.value = false;
  }
}
function leave() {
  return !(
    (formState.dirty.value || targetDirty.value) &&
    !window.confirm('当前设置尚未保存，离开后更改会丢失。确定离开吗？')
  );
}
onBeforeRouteLeave(leave);
onBeforeRouteUpdate((to, from) => to.params.eventId === from.params.eventId || leave());
watch(eventId, load, { immediate: true });
onBeforeUnmount(() => {
  generation++;
  pollGeneration++;
  detailGeneration++;
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <div class="feishu-settings">
    <header class="feishu-page-head">
      <div>
        <h2>飞书机器人</h2>
        <p>每天将大会运营数据发送到指定飞书群。</p>
      </div>
      <span
        v-if="subscription"
        class="feishu-status"
        :class="subscription.enabled ? 'success' : 'muted'"
      >{{
        subscription.enabled ? '✓ 自动日报已开启' : archived ? '大会已归档' : '自动日报未开启'
      }}</span>
    </header>
    <p v-if="loading" role="status">正在读取大会日报设置…</p>
    <p v-if="error" ref="errorElement" role="alert" tabindex="-1" class="feishu-error">
      {{ error }} <button class="feishu-text-button" type="button" @click="load">刷新配置</button>
    </p>
    <template v-if="configuration && subscription">
      <ol v-if="!subscription.enabled && !archived" class="feishu-steps" aria-label="飞书接入进度">
        <li
          v-for="(label, index) in ['连接应用', '选择接收群', '试发并开启']"
          :key="label"
          :aria-current="step === index + 1 ? 'step' : undefined"
          :class="{ current: step === index + 1, complete: step > index + 1 }"
        >
          <span>{{ step > index + 1 ? '✓' : index + 1 }}</span>{{ label }}
        </li>
      </ol>
      <FeishuConnectionPanel
        :key="String(eventId)"
        :configuration="configuration"
        @updated="connected"
      />
      <div v-if="connectionReady" class="feishu-workspace">
        <section class="feishu-controls" aria-label="日报设置">
          <div class="feishu-section-head">
            <div>
              <h3>{{ step === 2 ? '选择接收群' : '每日推送' }}</h3>
              <p>仅发送汇总数据，具体业务在后台处理。</p>
            </div>
            <button
              v-if="canManage && subscription.chatId && !archived && !editingTarget"
              class="button secondary"
              type="button"
              @click="editTarget"
            >
              修改设置
            </button>
          </div>
          <form
            v-if="step === 2 && canManage && !archived"
            class="feishu-target-form"
            @submit.prevent="saveSettings(false)"
          >
            <label for="feishu-chat-search">搜索接收群<input
              id="feishu-chat-search"
              v-model="search"
              type="search"
              placeholder="输入群名或短 ID"
            /></label>
            <p class="feishu-hint">
              仅显示 {{ configuration.appName || '当前机器人' }} 已加入的群。<button
                class="feishu-text-button"
                type="button"
                @click="copyBotName"
              >
                复制机器人名称
              </button>
            </p>
            <div v-if="chatsLoading" role="status">正在读取完整群列表…</div>
            <p v-if="chatsError" role="alert" class="feishu-error">
              {{ chatsError }} 当前已保存的接收群保留。
            </p>
            <p v-if="chatsLoaded && !chats.length" class="feishu-notice">
              暂时没有可选择的群。请在飞书目标群的「设置 →
              群机器人」中添加当前应用机器人，然后返回这里刷新。
            </p>
            <label for="feishu-chat">日报接收群<select
              id="feishu-chat"
              v-model="chatId"
              required
              :disabled="chatsLoading || !chatsLoaded"
            >
              <option value="">请选择接收群</option>
              <option
                v-if="
                  subscription.chatId &&
                    !filteredChats.some((chat) => chat.chatId === subscription?.chatId)
                "
                :value="subscription.chatId"
                disabled
              >
                {{ subscription.chatName }} · 当前保存的群
              </option>
              <option
                v-for="chat in filteredChats"
                :key="chat.chatId"
                :value="chat.chatId"
                :disabled="!chat.selectable"
              >
                {{ chat.name }} · {{ chat.chatId.slice(-8)
                }}{{ chat.unavailableReason ? ` · ${chat.unavailableReason}` : '' }}
              </option>
            </select></label>
            <div class="feishu-actions">
              <button
                class="button secondary"
                type="button"
                :disabled="chatsLoading"
                @click="loadChats(true)"
              >
                刷新群列表
              </button>
              <details class="feishu-help">
                <summary>已添加仍找不到？</summary>
                <p>
                  请依次核对机器人名称、应用发布状态、群与应用是否属于同一企业，以及群是否已解散。群列表读取不完整时，请重新刷新。
                </p>
              </details>
            </div>
            <label for="feishu-send-time">每天发送时间<input id="feishu-send-time" v-model="time" type="time" required /></label>
            <p class="feishu-hint">
              大会时区：{{ subscription.timezone }}。每天发送前一完整自然日的数据。
            </p>
            <p v-if="subscription.enabled" class="feishu-notice">
              保存修改会暂停当前大会日报。核对配置后可重新开启。
            </p>
            <div class="feishu-actions">
              <button
                class="button"
                type="submit"
                :disabled="pending || !chatId || chatsLoading || !chatsLoaded"
              >
                {{ pending ? '正在保存' : '保存并继续' }}
              </button><button
                v-if="editingTarget"
                class="button secondary"
                type="button"
                :disabled="pending"
                @click="
                  editingTarget = false;
                  chatId = subscription.chatId ?? '';
                  time = subscription.sendLocalTime;
                "
              >
                取消修改
              </button>
            </div>
          </form>
          <template v-else-if="subscription.chatId">
            <dl class="feishu-schedule">
              <div>
                <dt>接收群</dt>
                <dd>{{ subscription.chatName }}</dd>
              </div>
              <div>
                <dt>每天</dt>
                <dd>{{ subscription.sendLocalTime }} · {{ subscription.timezone }}</dd>
              </div>
              <div>
                <dt>下次发送</dt>
                <dd>{{ formatTime(subscription.nextRunAt) }}</dd>
              </div>
              <div>
                <dt>最近成功</dt>
                <dd>{{ formatTime(subscription.lastSuccessfulAt) }}</dd>
              </div>
            </dl>
            <p v-if="!subscription.serviceHealth.ready" class="feishu-notice" role="status">
              自动发送服务暂未就绪，配置已保留。恢复后可继续试发或开启。<button
                class="feishu-text-button"
                type="button"
                @click="load"
              >
                重新检查
              </button>
            </p>
            <p v-if="subscription.pauseReason && !subscription.enabled" class="feishu-hint">
              {{
                subscription.pauseReason === 'upgrade_requires_test'
                  ? '日报功能已升级，请重新试发并开启。'
                  : subscription.pauseReason === 'connection_changed'
                    ? '组织连接已替换，请重新试发。'
                    : subscription.pauseReason === 'chat_unavailable'
                      ? '当前群已不可用，请重新选择接收群。'
                      : '设置已保留，可在核对后开启。'
              }}
            </p>
            <div v-if="activeDelivery" class="feishu-test-result" aria-live="polite">
              <strong>{{ kindLabels[activeDelivery.kind] }} ·
                {{ statusLabels[activeDelivery.status] }}</strong>
              <p v-if="deliveryRunning">
                任务在后台处理，关闭页面后仍会继续。等待较长时，可稍后在发送记录查看。
              </p>
              <p v-else-if="activeDelivery.status === 'sent'">
                日报已发送到「{{ activeDelivery.chatName }}」。请在群内核对内容。
              </p>
              <p v-else>{{ activeDelivery.lastError || '请查看发送记录中的详情。' }}</p>
              <button
                class="feishu-text-button"
                type="button"
                @click="eventId && startPolling(activeDelivery.id, eventId, generation)"
              >
                刷新发送结果
              </button>
            </div>
            <template v-if="canManage && !archived">
              <label v-if="!unresolvedTest && !deliveryRunning" class="feishu-checkbox"><input
                v-model="visibilityConfirmed"
                type="checkbox"
              />我确认该群成员可以查看本大会的汇总经营数据。</label>
              <div class="feishu-actions">
                <button
                  v-if="!deliveryRunning"
                  class="button"
                  :class="subscription.targetGroupVerified ? 'secondary' : ''"
                  type="button"
                  :disabled="pending || (!visibilityConfirmed && !unresolvedTest)"
                  @click="sendTest"
                >
                  {{
                    unresolvedTest ? '查询上次试发结果' : pending ? '正在提交' : '发送测试日报'
                  }}
                </button><button
                  v-if="!subscription.enabled && subscription.targetGroupVerified"
                  class="button"
                  type="button"
                  :disabled="pending || !subscription.serviceHealth.ready || !automaticallyEligible"
                  @click="saveSettings(true)"
                >
                  开启每日推送
                </button><button
                  v-if="subscription.enabled"
                  class="button secondary"
                  type="button"
                  :disabled="pending"
                  @click="saveSettings(false)"
                >
                  暂停日报
                </button>
              </div>
              <p v-if="!automaticallyEligible" class="feishu-hint">
                大会处于草稿或配置阶段，可预览和试发。进入预发布阶段后可开启自动日报。
              </p>
              <p
                v-if="subscription.targetGroupVerified && !subscription.enabled"
                class="feishu-hint"
              >
                试发已通过。现在开启后，预计
                {{ formatTime(firstReport?.sendAt) }} 发送首份日报，数据日期为
                {{ firstReport?.reportDate }}。
              </p>
            </template>
          </template>
          <p v-else class="feishu-hint">尚未设置接收群，请由组织管理员完成配置。</p>
        </section>
        <aside class="feishu-preview-panel">
          <div class="feishu-section-head">
            <h3>日报预览</h3>
            <button class="feishu-text-button" type="button" @click="refreshPreview">
              刷新预览
            </button>
          </div>
          <p class="feishu-hint">以下数据生成于标注时间，试发时会更新统计。</p>
          <FeishuDigestPreview v-if="snapshot" :snapshot="snapshot" />
          <p v-else-if="previewError" class="feishu-error" role="alert">{{ previewError }}</p>
          <p v-else role="status">正在生成预览…</p>
        </aside>
      </div>
      <section class="feishu-history">
        <div class="feishu-section-head">
          <div>
            <h3>发送记录</h3>
            <p>最近 100 条。自动日报、试发和补发均保留记录。</p>
          </div>
          <button class="button secondary" type="button" @click="load">刷新记录</button>
        </div>
        <p v-if="!records.length" class="feishu-empty">
          还没有发送记录。完成接入后，可先发送一份测试日报。
        </p>
        <ul v-else class="feishu-history-list">
          <li v-for="record in records" :key="record.id">
            <div>
              <strong>{{ record.reportDate }} · {{ kindLabels[record.kind] }}</strong>
              <p>{{ record.chatName }} · {{ formatTime(record.createdAt) }}</p>
            </div>
            <span
              class="feishu-status"
              :class="
                record.status === 'sent'
                  ? 'success'
                  : ['unknown', 'failed'].includes(record.status)
                    ? 'warning'
                    : 'muted'
              "
            >{{
              record.resolution?.kind === 'received'
                ? '人工确认已收到'
                : record.resolution?.kind === 'resent'
                  ? '已安排补发'
                  : statusLabels[record.status]
            }}</span><button class="feishu-text-button" type="button" @click="openDetail(record.id)">
              查看详情
            </button>
          </li>
        </ul>
        <section v-if="detail" class="feishu-history-detail" aria-label="投递详情">
          <div class="feishu-section-head">
            <h3>{{ detail.reportDate }} · {{ statusLabels[detail.status] }}</h3>
            <button class="button secondary" type="button" @click="detail = undefined">
              收起详情
            </button>
          </div>
          <p>
            {{ detail.chatName }} · {{ kindLabels[detail.kind] }} · 已尝试 {{ detail.attempts }} 次
          </p>
          <p v-if="detail.lastError" class="feishu-notice">{{ detail.lastError }}</p>
          <p v-if="detail.resolution">
            处理结论：{{
              detail.resolution.kind === 'received' ? '人工确认已收到' : '已安排补发'
            }}
            · {{ formatTime(detail.resolution.at) }}
          </p>
          <template v-if="canManage && detail.availableActions.length">
            <label v-if="detail.availableActions.includes('resend')" class="feishu-checkbox"><input
              v-model="resendConfirmed"
              type="checkbox"
            />我已查看目标群，确认按原始数据补发。原消息可能仍会到达。</label>
            <div class="feishu-actions">
              <button
                v-if="detail.availableActions.includes('resolve')"
                class="button secondary"
                type="button"
                :disabled="pending"
                @click="recover('resolve')"
              >
                人工确认已收到
              </button><button
                v-if="detail.availableActions.includes('resend')"
                class="button"
                type="button"
                :disabled="pending || !resendConfirmed"
                @click="recover('resend')"
              >
                确认补发
              </button><button
                v-if="detail.availableActions.includes('regenerate')"
                class="button"
                type="button"
                :disabled="pending"
                @click="recover('regenerate')"
              >
                重新生成
              </button>
            </div>
            <p v-if="detail.availableActions.includes('regenerate')" class="feishu-hint">
              沿用原报告日期，当前累计与待办会更新到重新生成时。
            </p>
          </template>
          <details class="feishu-help">
            <summary>诊断详情</summary>
            <dl class="feishu-schedule">
              <div>
                <dt>投递编号</dt>
                <dd class="feishu-mono">{{ detail.id }}</dd>
              </div>
              <div>
                <dt>错误码</dt>
                <dd>{{ detail.lastErrorCode || '无' }}</dd>
              </div>
              <div>
                <dt>飞书消息编号</dt>
                <dd class="feishu-mono">{{ detail.providerMessageId || '尚未取得' }}</dd>
              </div>
            </dl>
          </details>
          <FeishuDigestPreview v-if="detail.snapshot" :snapshot="detail.snapshot" />
          <p v-else>本次尚未生成可用快照。</p>
        </section>
      </section>
    </template>
    <SaveStatus :message="message" />
  </div>
</template>
