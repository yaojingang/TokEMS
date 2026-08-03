<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import { conferenceApi, session, type CheckInResult } from '../lib/api';
import { checkInStorageKey, clearLegacyCheckInStorage } from '../lib/checkin-storage';
import { dateTime } from '../lib/format';

const input = ref<HTMLInputElement>();
const ticketCode = ref('');
const pending = ref(false);
const result = ref<CheckInResult>();
const recent = ref<CheckInResult[]>([]);
const devices = ref<Array<Record<string, unknown>>>([]);
const errorMessage = ref('');
const showDeviceEditor = ref(false);
const showOfflineAuth = ref(false);
const showOfflineSyncConfirm = ref(false);
const offlineTokenInput = ref<HTMLInputElement>();
const deviceTokenNotice = ref('');
const deviceForm = reactive({
  deviceCode: '',
  name: '现场核销设备',
});
const canExecute = session.can('event.checkin.execute');
const canManageDevices = session.can('event.checkin.manage');
const offlineMode = ref(!navigator.onLine);
const currentEventId = session.activeEventId.value;
if (!currentEventId) throw new Error('现场签到缺少已验证的大会上下文');
clearLegacyCheckInStorage(localStorage);
const storageKeys = {
  offlineQueue: checkInStorageKey(currentEventId, 'offlineQueue'),
  batchKey: checkInStorageKey(currentEventId, 'batchKey'),
  deviceCode: checkInStorageKey(currentEventId, 'deviceCode'),
  deviceToken: checkInStorageKey(currentEventId, 'deviceToken'),
  device: checkInStorageKey(currentEventId, 'device'),
};
function loadOfflineQueue() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKeys.offlineQueue) ?? '[]') as unknown;
    return Array.isArray(value)
      ? (value as Array<{ localId: string; ticketCode: string; checkedInAt: string }>)
      : [];
  } catch {
    return [];
  }
}
const offlineQueue =
  ref<Array<{ localId: string; ticketCode: string; checkedInAt: string }>>(loadOfflineQueue());
const offlineBatchKey = ref(
  localStorage.getItem(storageKeys.batchKey) ?? `offline-${crypto.randomUUID()}`,
);
const offlineDeviceCode = ref(localStorage.getItem(storageKeys.deviceCode) ?? 'GATE-A-01');
const offlineDeviceToken = ref(localStorage.getItem(storageKeys.deviceToken) ?? '');
const deviceId =
  localStorage.getItem(storageKeys.device) ?? `desk-${crypto.randomUUID().slice(0, 8)}`;
localStorage.setItem(storageKeys.device, deviceId);

const resultTitle = computed(() => {
  if (result.value?.result === 'accepted') return '核销成功';
  if (result.value?.result === 'duplicate') return '该票已核销';
  if (result.value?.result === 'invalid') return '无效电子票';
  return '等待扫码';
});

onMounted(async () => {
  input.value?.focus();
  try {
    devices.value = canManageDevices ? await conferenceApi.getDevices() : [];
  } catch {
    devices.value = [];
  }
});

function persistOfflineQueue() {
  localStorage.setItem(storageKeys.offlineQueue, JSON.stringify(offlineQueue.value));
  localStorage.setItem(storageKeys.batchKey, offlineBatchKey.value);
}

async function checkIn() {
  if (!ticketCode.value.trim()) return;
  if (offlineMode.value) {
    const queuedAt = new Date().toISOString();
    offlineQueue.value.push({
      localId: crypto.randomUUID(),
      ticketCode: ticketCode.value.trim(),
      checkedInAt: queuedAt,
    });
    persistOfflineQueue();
    result.value = {
      result: 'manual_review',
      checkedInAt: queuedAt,
      message: '离线记录已保存，恢复网络后请同步到服务器',
    };
    ticketCode.value = '';
    return;
  }
  pending.value = true;
  try {
    result.value = await conferenceApi.checkIn({ ticketCode: ticketCode.value.trim(), deviceId });
    recent.value.unshift(result.value);
    recent.value = recent.value.slice(0, 8);
  } catch (error) {
    result.value = {
      result: 'invalid',
      checkedInAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : '核销请求失败',
    };
  } finally {
    ticketCode.value = '';
    pending.value = false;
    await nextTick();
    input.value?.focus();
  }
}

async function prepareOfflineSync() {
  if (!offlineQueue.value.length) return;
  if (!offlineDeviceToken.value) {
    showOfflineAuth.value = true;
    await nextTick();
    offlineTokenInput.value?.focus();
    return;
  }
  showOfflineSyncConfirm.value = true;
}

async function authorizeAndSync() {
  offlineDeviceToken.value = offlineDeviceToken.value.trim();
  if (!offlineDeviceToken.value) return;
  localStorage.setItem(storageKeys.deviceToken, offlineDeviceToken.value);
  showOfflineAuth.value = false;
  showOfflineSyncConfirm.value = true;
}

async function syncOffline() {
  pending.value = true;
  try {
    await conferenceApi.syncOfflineCheckins(
      {
        deviceCode: offlineDeviceCode.value,
        batchKey: offlineBatchKey.value,
        records: offlineQueue.value,
      },
      offlineDeviceToken.value,
    );
    offlineQueue.value = [];
    offlineBatchKey.value = `offline-${crypto.randomUUID()}`;
    persistOfflineQueue();
    offlineMode.value = false;
    result.value = {
      result: 'accepted',
      checkedInAt: new Date().toISOString(),
      message: '离线核销批次已同步完成',
    };
  } catch (error) {
    result.value = {
      result: 'invalid',
      checkedInAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : '离线批次同步失败',
    };
  } finally {
    pending.value = false;
  }
}

function openDeviceEditor() {
  deviceForm.deviceCode = `GATE-${devices.value.length + 1}`;
  deviceForm.name = '现场核销设备';
  deviceTokenNotice.value = '';
  errorMessage.value = '';
  showDeviceEditor.value = true;
}

async function registerDevice() {
  const deviceCode = deviceForm.deviceCode.trim();
  const name = deviceForm.name.trim();
  if (!deviceCode || !name) return;
  pending.value = true;
  errorMessage.value = '';
  try {
    const registered = await conferenceApi.registerDevice({ deviceCode, name });
    offlineDeviceCode.value = String(registered.device.deviceCode ?? deviceCode);
    offlineDeviceToken.value = registered.token;
    localStorage.setItem(storageKeys.deviceCode, offlineDeviceCode.value);
    localStorage.setItem(storageKeys.deviceToken, offlineDeviceToken.value);
    deviceTokenNotice.value = registered.token;
    showDeviceEditor.value = false;
    devices.value = await conferenceApi.getDevices();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备注册失败';
  } finally {
    pending.value = false;
  }
}

async function copyDeviceToken() {
  await navigator.clipboard.writeText(deviceTokenNotice.value);
  errorMessage.value = '';
}
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">ONSITE OPERATIONS</p>
      <h1>主入口扫码核销</h1>
      <p>扫描电子票二维码，或手动输入票号完成签到。</p>
    </div>
    <div class="admin-head-actions">
      <button
        v-if="canExecute"
        class="button secondary"
        type="button"
        @click="offlineMode = !offlineMode"
      >
        {{ offlineMode ? '切换在线' : '切换离线' }}
      </button><button
        v-if="canManageDevices"
        class="button secondary"
        type="button"
        @click="openDeviceEditor"
      >
        注册设备
      </button><span class="status-badge">DEVICE / {{ deviceId }}</span>
    </div>
  </header>

  <p v-if="errorMessage" class="admin-error" role="alert">{{ errorMessage }}</p>
  <section
    v-if="showDeviceEditor"
    class="admin-panel editor-panel device-editor"
    aria-labelledby="device-editor-title"
  >
    <header class="admin-panel-header">
      <div>
        <h2 id="device-editor-title">注册核销设备</h2>
        <p>设备代码用于离线批次识别，保存后会生成一次性令牌</p>
      </div>
      <button class="button secondary compact" type="button" @click="showDeviceEditor = false">
        关闭
      </button>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="registerDevice">
      <div class="form-grid">
        <div class="form-field">
          <label for="checkin-device-code">设备代码</label>
          <input
            id="checkin-device-code"
            v-model="deviceForm.deviceCode"
            required
            pattern="[A-Za-z0-9_-]+"
            maxlength="60"
          />
          <small>可使用字母、数字、下划线和短横线</small>
        </div>
        <div class="form-field">
          <label for="checkin-device-name">设备名称</label>
          <input id="checkin-device-name" v-model="deviceForm.name" required maxlength="100" />
        </div>
      </div>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="showDeviceEditor = false">
          取消
        </button>
        <button class="button" type="submit" :disabled="pending">
          {{ pending ? '注册中…' : '注册并生成令牌' }}
        </button>
      </div>
    </form>
  </section>

  <section
    v-if="deviceTokenNotice"
    class="admin-panel editor-panel device-token-notice"
    aria-labelledby="device-token-title"
  >
    <header class="admin-panel-header">
      <div>
        <h2 id="device-token-title">保存设备令牌</h2>
        <p>该令牌仅展示一次，请立即复制到对应核销设备</p>
      </div>
      <button class="button secondary compact" type="button" @click="deviceTokenNotice = ''">
        已保存
      </button>
    </header>
    <div class="token-notice-body">
      <code>{{ deviceTokenNotice }}</code>
      <button class="button secondary" type="button" @click="copyDeviceToken">复制令牌</button>
    </div>
  </section>

  <section
    v-if="showOfflineAuth"
    class="admin-panel editor-panel offline-auth-editor"
    aria-labelledby="offline-auth-title"
  >
    <header class="admin-panel-header">
      <div>
        <h2 id="offline-auth-title">授权离线批次同步</h2>
        <p>输入该设备登记时生成的一次性令牌</p>
      </div>
      <button class="button secondary compact" type="button" @click="showOfflineAuth = false">
        关闭
      </button>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="authorizeAndSync">
      <div class="form-field">
        <label for="offline-device-token">设备令牌</label>
        <input
          id="offline-device-token"
          ref="offlineTokenInput"
          v-model="offlineDeviceToken"
          type="password"
          autocomplete="off"
          required
        />
      </div>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="showOfflineAuth = false">
          取消
        </button>
        <button class="button" type="submit" :disabled="pending">授权并检查批次</button>
      </div>
    </form>
  </section>

  <div class="checkin-layout">
    <section v-if="canExecute" class="admin-panel reveal is-visible">
      <header class="admin-panel-header">
        <div>
          <h2>核销终端</h2>
          <p>扫码枪可直接输入，回车后自动提交</p>
        </div>
        <span class="status-badge" :class="{ warning: offlineMode }">{{
          offlineMode ? '离线模式' : '在线模式'
        }}</span>
      </header>
      <div class="checkin-console">
        <div class="scan-frame"><span>将电子票二维码对准扫描区域</span></div>
        <form class="checkin-input-wrap" @submit.prevent="checkIn">
          <input
            ref="input"
            v-model="ticketCode"
            class="checkin-input"
            aria-label="电子票票号"
            placeholder="例：TOK-T-A1B2C3D4E5F6G7H8"
            autocomplete="off"
          />
          <button class="button" type="submit" :disabled="pending">
            {{ pending ? '核销中…' : '确认核销' }}
          </button>
        </form>
      </div>
    </section>

    <div class="dashboard-stack">
      <section v-if="canExecute" class="admin-panel reveal is-visible">
        <header class="admin-panel-header">
          <div>
            <h2>核销结果</h2>
            <p>当前识别状态</p>
          </div>
        </header>
        <div class="checkin-result">
          <span class="result-mark" :class="result?.result">
            {{
              result?.result === 'accepted'
                ? '✓'
                : result?.result === 'duplicate'
                  ? '!'
                  : result
                    ? '×'
                    : '◌'
            }}
          </span>
          <h2>{{ resultTitle }}</h2>
          <p>{{ result?.message ?? '请扫描或输入电子票号' }}</p>
          <template v-if="result?.ticket">
            <div class="summary-row">
              <span>参会人</span><strong>{{ result.ticket.attendeeName }}</strong>
            </div>
            <div class="summary-row">
              <span>票种</span><strong>{{ result.ticket.ticketTypeName }}</strong>
            </div>
            <div class="summary-row">
              <span>票号</span><strong class="mono-code">{{ result.ticket.code }}</strong>
            </div>
            <div class="summary-row">
              <span>时间</span><strong>{{ dateTime(result.checkedInAt) }}</strong>
            </div>
          </template>
        </div>
      </section>

      <section v-if="canExecute" class="admin-panel reveal is-visible">
        <header class="admin-panel-header">
          <div>
            <h2>本机最近核销</h2>
            <p>仅显示当前终端操作</p>
          </div>
          <span class="status-badge">{{ recent.length }}</span>
        </header>
        <ul class="status-list">
          <li v-for="item in recent" :key="`${item.checkedInAt}-${item.ticket?.code}`">
            <i
              class="status-dot"
              :class="{ red: item.result === 'invalid', gold: item.result === 'duplicate' }"
            ></i><span><strong>{{ item.ticket?.attendeeName ?? '未识别参会人' }}</strong><small>{{ item.message }}</small></span><b>{{ item.result === 'accepted' ? 'OK' : '!' }}</b>
          </li>
        </ul>
        <div v-if="!recent.length" class="admin-empty">本机尚无核销记录。</div>
      </section>

      <section class="admin-panel reveal is-visible">
        <header class="admin-panel-header">
          <div>
            <h2>离线队列与设备</h2>
            <p>{{ devices.length }} 台设备已登记</p>
          </div>
          <span class="status-badge">{{ offlineQueue.length }} 条待同步</span>
        </header>
        <div class="checkin-result">
          <p>离线模式会把扫码结果保存在本机，批次同步使用固定幂等键。</p>
          <button
            v-if="canExecute"
            class="button secondary"
            type="button"
            :disabled="pending || !offlineQueue.length"
            @click="prepareOfflineSync"
          >
            同步离线记录
          </button>
        </div>
      </section>
    </div>
  </div>

  <AdminConfirmDialog
    :open="showOfflineSyncConfirm"
    :event-name="session.activeEvent.value?.name"
    title="确认同步离线签到批次？"
    description="本机保存的离线扫码记录将提交到当前大会，服务端会按批次幂等处理。"
    confirm-label="确认同步"
    :details="[
      { label: '待同步记录', value: `${offlineQueue.length} 条` },
      { label: '核销设备', value: offlineDeviceCode },
    ]"
    :busy="pending"
    @cancel="showOfflineSyncConfirm = false"
    @confirm="
      showOfflineSyncConfirm = false;
      syncOffline();
    "
  />
</template>
