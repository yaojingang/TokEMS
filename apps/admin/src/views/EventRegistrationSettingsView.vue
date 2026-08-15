<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import type {
  CustomerAccountMode,
  EventExperience,
  EventPaymentMode,
  PublicEvent,
} from '@conference/contracts';
import { normalizeConferenceTemplateDefinition } from '@conference/contracts';
import { isPublicEventStatus } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, session } from '../lib/api';
import { money } from '../lib/format';
import { eventSettingsEffectDescription } from '../lib/event-settings-effect';

interface InventoryRow {
  id: string;
  name: string;
  capacity: number;
  sold: number;
  reserved: number;
  available: number;
}

const event = ref<PublicEvent>();
const experience = ref<EventExperience>();
const inventory = ref<InventoryRow[]>([]);
const archivedTickets = ref<
  Array<{ id: string; code: string; name: string; price: number; capacity: number }>
>([]);
const settingsPending = ref(false);
const ticketPending = ref(false);
const flowPending = ref(false);
const message = ref('');
const errorMessage = ref('');
const showTicketEditor = ref(false);
const editingTicketId = ref('');
const confirmation = shallowRef<{
  title: string;
  description: string;
  confirmLabel?: string;
  tone: 'primary' | 'danger';
  details: Array<{ label: string; value: string }>;
  action: () => Promise<void>;
}>();
const settingsForm = reactive({
  paymentMode: 'ticketed' as EventPaymentMode,
  registrationOpen: true,
  accountMode: 'mobile_otp_required' as CustomerAccountMode,
  additionalPurchaseEnabled: false,
  maxActiveSeatsPerPurchaser: 5,
});
const ticketForm = reactive({
  code: '',
  name: '',
  description: '',
  priceYuan: 0,
  capacity: 100,
  recommended: false,
  benefits: '',
});
const flowForm = reactive({
  preset: 'standard' as 'standard' | 'quick' | 'free',
  progressVariant: 'steps' as 'steps' | 'compact' | 'minimal',
  waitlist: true,
  invoiceAfterPayment: true,
  manualReview: false,
});

const isFree = computed(() => settingsForm.paymentMode === 'free');
const settingsEffectDescription = computed(() =>
  eventSettingsEffectDescription(event.value?.status),
);
const canManageRegistration = computed(() =>
  session.canAny(['event.manage', 'event.registration.manage']),
);
const canReadInventory = computed(() =>
  session.canAny(['event.inventory.read', 'event.inventory.manage']),
);
const canManageTickets = computed(() => session.can('event.inventory.manage'));
const canReadFlow = computed(() => session.can('event.site.read'));
const canManageFlow = computed(() => session.can('event.content.manage'));

function hydrateFlow(value: EventExperience) {
  const definition = normalizeConferenceTemplateDefinition(value.definition);
  experience.value = { ...value, definition };
  Object.assign(flowForm, {
    preset: definition.registrationFlow.preset,
    progressVariant: definition.registrationFlow.progressVariant,
    waitlist: definition.registrationFlow.branches.waitlist,
    invoiceAfterPayment: definition.registrationFlow.branches.invoiceAfterPayment,
    manualReview: definition.registrationFlow.branches.manualReview,
  });
}

async function load(preserveSettings = false, preserveFlow = false) {
  errorMessage.value = '';
  try {
    const [loaded, loadedInventory, loadedArchivedTickets, loadedExperience] = await Promise.all([
      conferenceApi.getEvent(),
      canReadInventory.value ? conferenceApi.getInventory() : Promise.resolve([]),
      canManageTickets.value ? conferenceApi.getArchivedTicketTypes() : Promise.resolve([]),
      canReadFlow.value && (!preserveFlow || !experience.value)
        ? conferenceApi.getEventExperience()
        : Promise.resolve(experience.value),
    ]);
    event.value = loaded;
    inventory.value = loadedInventory;
    archivedTickets.value = loadedArchivedTickets;
    if (!preserveSettings) {
      settingsForm.paymentMode = loaded.registration.paymentMode;
      settingsForm.registrationOpen = loaded.registration.registrationOpen;
      settingsForm.accountMode = loaded.registration.accountMode;
      settingsForm.additionalPurchaseEnabled = loaded.registration.additionalPurchaseEnabled;
      settingsForm.maxActiveSeatsPerPurchaser =
        loaded.registration.maxActiveSeatsPerPurchaser;
    }
    if (loadedExperience && (!preserveFlow || !experience.value)) hydrateFlow(loadedExperience);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名设置读取失败';
  }
}

onMounted(load);

function savedMessage(subject = '已保存') {
  return event.value && isPublicEventStatus(event.value.status)
    ? `${subject}，前台已生效`
    : `${subject}，大会上线时生效`;
}

function requestSaveSettings() {
  const current = event.value?.registration;
  const changesBusinessFlow =
    current &&
    (current.paymentMode !== settingsForm.paymentMode ||
      current.registrationOpen !== settingsForm.registrationOpen ||
      current.additionalPurchaseEnabled !== settingsForm.additionalPurchaseEnabled ||
      current.maxActiveSeatsPerPurchaser !== settingsForm.maxActiveSeatsPerPurchaser);
  if (!changesBusinessFlow) {
    void saveSettings();
    return;
  }
  confirmation.value = {
    title: settingsForm.registrationOpen ? '确认更新报名方式？' : '确认暂停前台报名？',
    description: settingsForm.registrationOpen
      ? `已有订单和电子票继续保留原记录。${settingsEffectDescription.value}`
      : `前台页面继续保留。${settingsEffectDescription.value}`,
    confirmLabel: settingsForm.registrationOpen ? '确认并生效' : '确认暂停报名',
    tone: settingsForm.registrationOpen ? 'primary' : 'danger',
    details: [
      {
        label: '报名模式',
        value: settingsForm.paymentMode === 'free' ? '免费报名' : '按票种收费',
      },
      { label: '前台报名', value: settingsForm.registrationOpen ? '开放' : '暂停' },
      {
        label: '追加名额',
        value: settingsForm.additionalPurchaseEnabled
          ? `开放，每位购票人最多 ${settingsForm.maxActiveSeatsPerPurchaser} 个有效名额`
          : '关闭',
      },
    ],
    action: saveSettings,
  };
}

async function confirmImportantChange() {
  const current = confirmation.value;
  if (!current) return;
  await current.action();
  if (!errorMessage.value) confirmation.value = undefined;
}

async function saveSettings() {
  const maxActiveSeats = Math.round(Number(settingsForm.maxActiveSeatsPerPurchaser));
  if (!Number.isInteger(maxActiveSeats) || maxActiveSeats < 1 || maxActiveSeats > 20) {
    errorMessage.value = '每位购票人的有效名额上限需要设置为 1 到 20。';
    return;
  }
  if (isFree.value && event.value?.tickets.some((ticket) => ticket.price > 0)) {
    errorMessage.value = '免费报名模式下，所有票种价格需要设为 0 元。';
    return;
  }
  settingsPending.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    event.value = await conferenceApi.updateEvent({
      settings: {
        registration: {
          paymentMode: settingsForm.paymentMode,
          currency: 'CNY',
          registrationOpen: settingsForm.registrationOpen,
          accountMode: settingsForm.accountMode,
          additionalPurchaseEnabled: settingsForm.additionalPurchaseEnabled,
          maxActiveSeatsPerPurchaser: maxActiveSeats,
        },
      },
    });
    message.value = savedMessage();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名方式保存失败';
  } finally {
    settingsPending.value = false;
  }
}

function resetTicketForm() {
  editingTicketId.value = '';
  Object.assign(ticketForm, {
    code: '',
    name: '',
    description: '',
    priceYuan: 0,
    capacity: 100,
    recommended: false,
    benefits: '',
  });
}

function createTicket() {
  resetTicketForm();
  showTicketEditor.value = true;
}

function editTicket(ticket: PublicEvent['tickets'][number]) {
  const stock = inventory.value.find((item) => item.id === ticket.id);
  editingTicketId.value = ticket.id;
  Object.assign(ticketForm, {
    code: '',
    name: ticket.name,
    description: ticket.description,
    priceYuan: ticket.price / 100,
    capacity: stock?.capacity ?? stock?.sold ?? ticket.remaining,
    recommended: ticket.recommended,
    benefits: ticket.benefits.join('\n'),
  });
  showTicketEditor.value = true;
}

function requestSaveTicket() {
  const currentTicket = event.value?.tickets.find((ticket) => ticket.id === editingTicketId.value);
  const currentInventory = inventory.value.find((item) => item.id === editingTicketId.value);
  const nextPrice = Math.round(Number(ticketForm.priceYuan) * 100);
  const nextCapacity = Number(ticketForm.capacity);
  if (
    currentTicket &&
    (currentTicket.price !== nextPrice ||
      (currentInventory !== undefined && nextCapacity < currentInventory.capacity))
  ) {
    confirmation.value = {
      title: `确认更新“${currentTicket.name}”的售卖条件？`,
      description: '保存成功后新订单会立即采用新的价格和容量，已有订单与电子票继续保留原记录。',
      tone: nextCapacity < (currentInventory?.capacity ?? nextCapacity) ? 'danger' : 'primary',
      details: [
        {
          label: '票价',
          value: `${money(currentTicket.price)} → ${money(nextPrice)}`,
        },
        {
          label: '容量',
          value: `${currentInventory?.capacity ?? currentTicket.remaining} → ${nextCapacity}`,
        },
      ],
      action: saveTicket,
    };
    return;
  }
  void saveTicket();
}

async function saveTicket() {
  ticketPending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    const payload = {
      ...(editingTicketId.value ? {} : { code: ticketForm.code.trim().toUpperCase() }),
      name: ticketForm.name.trim(),
      description: ticketForm.description.trim(),
      price: Math.round(Number(ticketForm.priceYuan) * 100),
      currency: 'CNY',
      capacity: Number(ticketForm.capacity),
      recommended: ticketForm.recommended,
      benefits: ticketForm.benefits
        .split(/\n|；|;/)
        .map((item) => item.trim())
        .filter(Boolean),
    };
    if (isFree.value && payload.price > 0) {
      throw new Error('免费报名模式下，票种价格需要设为 0 元。');
    }
    if (editingTicketId.value) {
      await conferenceApi.updateTicketType(editingTicketId.value, payload);
    } else {
      await conferenceApi.createTicketType({
        ...payload,
        code: ticketForm.code.trim().toUpperCase(),
      });
    }
    await load(true, true);
    showTicketEditor.value = false;
    resetTicketForm();
    message.value = savedMessage();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '票种保存失败';
  } finally {
    ticketPending.value = false;
  }
}

function requestRemoveTicket(ticket: PublicEvent['tickets'][number]) {
  confirmation.value = {
    title: `确认下架“${ticket.name}”？`,
    description: '前台将立即停止展示和售卖该票种，已有订单和电子票不受影响。',
    confirmLabel: '确认下架',
    tone: 'danger',
    details: [
      { label: '当前票价', value: money(ticket.price) },
      { label: '剩余名额', value: String(ticket.remaining) },
    ],
    action: () => removeTicket(ticket),
  };
}

async function removeTicket(ticket: PublicEvent['tickets'][number]) {
  errorMessage.value = '';
  try {
    await conferenceApi.deleteTicketType(ticket.id);
    await load(true, true);
    message.value = savedMessage('票种已下架');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '票种删除失败';
  }
}

async function restoreTicket(ticket: (typeof archivedTickets.value)[number]) {
  errorMessage.value = '';
  try {
    await conferenceApi.restoreTicketType(ticket.id);
    await load(true, true);
    message.value = savedMessage('票种已恢复');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '票种恢复失败';
  }
}

async function saveFlow() {
  if (!experience.value) return;
  flowPending.value = true;
  errorMessage.value = '';
  message.value = '';
  try {
    const override = experience.value.overrides.registration_flow;
    const document = {
      $page: {
        preset: flowForm.preset,
        progressVariant: flowForm.progressVariant,
        branches: {
          ...experience.value.definition.registrationFlow.branches,
          waitlist: flowForm.waitlist,
          invoiceAfterPayment: flowForm.invoiceAfterPayment,
          manualReview: flowForm.manualReview,
        },
      },
    };
    const updated = await conferenceApi.saveEventExperience(
      'registration_flow',
      override.revision,
      document,
    );
    hydrateFlow(updated);
    message.value = savedMessage('报名流程已保存');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名流程保存失败';
  } finally {
    flowPending.value = false;
  }
}
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">EVENT SETTINGS / REGISTRATION</p>
      <h1>报名设置</h1>
      <p>统一维护报名方式、票种容量和前台报名流程。{{ settingsEffectDescription }}</p>
    </div>
    <span class="status-badge" :class="isFree ? 'paid' : 'draft'">
      {{ isFree ? 'FREE' : 'TICKETED' }}
    </span>
  </header>

  <SaveStatus :message="message" :error="errorMessage" />

  <section v-if="canManageRegistration" class="admin-panel">
    <header class="admin-panel-header">
      <div>
        <h2>报名方式</h2>
        <p>免费报名完成后直接出票，按票种收费会进入订单与支付</p>
      </div>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="requestSaveSettings">
      <div class="choice-card-grid">
        <label class="choice-card" :class="{ selected: settingsForm.paymentMode === 'free' }">
          <input v-model="settingsForm.paymentMode" type="radio" value="free" />
          <span>
            <strong>免费报名</strong>
            <small>票价统一为 0 元，提交后直接生成电子票</small>
          </span>
        </label>
        <label class="choice-card" :class="{ selected: settingsForm.paymentMode === 'ticketed' }">
          <input v-model="settingsForm.paymentMode" type="radio" value="ticketed" />
          <span>
            <strong>按票种收费</strong>
            <small>参会者选择票种，完成订单与支付后出票</small>
          </span>
        </label>
      </div>
      <label class="setting-toggle">
        <span>
          <strong>开放前台报名</strong>
          <small>关闭后保留前台页面，并暂停新的报名提交</small>
        </span>
        <input v-model="settingsForm.registrationOpen" type="checkbox" />
      </label>
      <div class="choice-card-grid registration-account-mode">
        <label
          class="choice-card"
          :class="{ selected: true }"
        >
          <input
            v-model="settingsForm.accountMode"
            type="radio"
            value="mobile_otp_required"
            disabled
          />
          <span>
            <strong>手机号验证码登录</strong>
            <small>所有大会统一登录后报名，报名记录、支付和发票归入同一用户中心</small>
          </span>
        </label>
      </div>
      <label class="setting-toggle">
        <span>
          <strong>允许购票人继续增加名额</strong>
          <small>开启后，已报名用户可继续为他人创建独立订单。{{ settingsEffectDescription }}</small>
        </span>
        <input v-model="settingsForm.additionalPurchaseEnabled" type="checkbox" />
      </label>
      <div v-if="settingsForm.additionalPurchaseEnabled" class="form-field additional-seat-limit">
        <label for="max-active-seats">每位购票人最多有效名额</label>
        <input
          id="max-active-seats"
          v-model.number="settingsForm.maxActiveSeatsPerPurchaser"
          type="number"
          min="1"
          max="20"
          step="1"
          required
        />
        <small>包含本人和代购名额，已关闭、已退款和已取消记录不计入。</small>
      </div>
      <div class="event-form-actions">
        <button class="button" type="submit" :disabled="settingsPending">
          {{ settingsPending ? '保存中…' : '保存报名设置' }}
        </button>
      </div>
    </form>
  </section>

  <section v-if="canReadInventory || canManageTickets" class="admin-panel ticket-settings-panel">
    <header class="admin-panel-header">
      <div>
        <h2>票种与容量</h2>
        <p>
          {{
            isFree
              ? '免费模式下保留票种，用于区分参会权益与容量'
              : '价格以人民币计价，容量包含已售与预留库存'
          }}
        </p>
      </div>
      <button
        v-if="canManageTickets"
        class="button secondary compact"
        type="button"
        @click="createTicket"
      >
        新建票种
      </button>
    </header>
    <div class="data-table-wrap">
      <table class="data-table">
        <caption class="sr-only">
          票种与容量
        </caption>
        <thead>
          <tr>
            <th>票种</th>
            <th>价格</th>
            <th>已售 / 容量</th>
            <th>剩余</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ticket in event?.tickets ?? []" :key="ticket.id">
            <td>
              <span class="row-title">{{ ticket.name }}</span>
              <span class="row-sub">{{ ticket.description }}</span>
            </td>
            <td>{{ ticket.price === 0 ? '免费' : money(ticket.price).replace('.00', '') }}</td>
            <td>
              {{ inventory.find((item) => item.id === ticket.id)?.sold ?? 0 }} /
              {{ inventory.find((item) => item.id === ticket.id)?.capacity ?? '未设置' }}
            </td>
            <td>{{ ticket.remaining }}</td>
            <td>
              <div v-if="canManageTickets" class="table-actions">
                <button class="button secondary compact" type="button" @click="editTicket(ticket)">
                  编辑
                </button>
                <button
                  class="button danger compact"
                  type="button"
                  @click="requestRemoveTicket(ticket)"
                >
                  下架
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!event?.tickets.length">
            <td colspan="5" class="admin-empty">暂无票种，请先创建一个可报名票种。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <details v-if="canManageTickets && archivedTickets.length" class="advanced-permissions">
      <summary>已下架票种（{{ archivedTickets.length }}）</summary>
      <ul class="operations-list">
        <li v-for="ticket in archivedTickets" :key="ticket.id">
          <div>
            <strong>{{ ticket.name }}</strong>
            <small>{{ ticket.code }} · {{ money(ticket.price) }} · 容量 {{ ticket.capacity }}</small>
          </div>
          <button class="button secondary compact" type="button" @click="restoreTicket(ticket)">
            恢复票种
          </button>
        </li>
      </ul>
    </details>
  </section>

  <section v-if="canManageTickets && showTicketEditor" class="admin-panel ticket-editor-panel">
    <header class="admin-panel-header">
      <div>
        <h2>{{ editingTicketId ? '编辑票种' : '新建票种' }}</h2>
        <p>票种配置保存后立即生效，历史订单继续保留原价格和票种快照。</p>
      </div>
      <button class="button secondary compact" type="button" @click="showTicketEditor = false">
        关闭
      </button>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="requestSaveTicket">
      <div class="form-grid">
        <div v-if="!editingTicketId" class="form-field">
          <label for="ticket-code">票种编码</label>
          <input
            id="ticket-code"
            v-model="ticketForm.code"
            required
            maxlength="40"
            pattern="[A-Za-z0-9_]+"
            placeholder="EARLY_BIRD"
          />
        </div>
        <div class="form-field">
          <label for="ticket-name">票种名称</label><input id="ticket-name" v-model="ticketForm.name" required maxlength="100" />
        </div>
        <div class="form-field">
          <label for="ticket-price">价格（元）</label>
          <input
            id="ticket-price"
            v-model.number="ticketForm.priceYuan"
            type="number"
            min="0"
            step="0.01"
            required
          />
        </div>
        <div class="form-field">
          <label for="ticket-capacity">总容量</label>
          <input
            id="ticket-capacity"
            v-model.number="ticketForm.capacity"
            type="number"
            min="1"
            step="1"
            required
          />
        </div>
        <div class="form-field full">
          <label for="ticket-description">票种说明</label>
          <textarea
            id="ticket-description"
            v-model="ticketForm.description"
            required
            maxlength="2000"
          ></textarea>
        </div>
        <div class="form-field full">
          <label for="ticket-benefits">权益清单（每行一项）</label>
          <textarea
            id="ticket-benefits"
            v-model="ticketForm.benefits"
            placeholder="大会两日通票&#10;午餐与茶歇"
          ></textarea>
        </div>
        <label class="ticket-recommended">
          <input v-model="ticketForm.recommended" type="checkbox" />
          <span>在前台标记为推荐票种</span>
        </label>
      </div>
      <div class="event-form-actions">
        <button class="button secondary" type="button" @click="showTicketEditor = false">
          取消
        </button>
        <button class="button" type="submit" :disabled="ticketPending">
          {{ ticketPending ? '保存中…' : '保存票种' }}
        </button>
      </div>
    </form>
  </section>

  <section v-if="experience" class="admin-panel admin-panel-spaced event-experience-panel">
    <header class="admin-panel-header">
      <div>
        <h2>前台报名流程</h2>
        <p>调整页面步骤和可选分支，库存、支付、出票和发票规则继续由服务端执行</p>
      </div>
    </header>
    <form class="event-form settings-form-spaced" @submit.prevent="saveFlow">
      <div class="form-grid">
        <div class="form-field">
          <label for="event-flow-preset">流程预设</label>
          <select id="event-flow-preset" v-model="flowForm.preset" :disabled="!canManageFlow">
            <option value="standard">标准四步</option>
            <option value="quick">快速三步</option>
            <option value="free">免费两步</option>
          </select>
        </div>
        <div class="form-field">
          <label for="event-progress-variant">进度展示</label>
          <select
            id="event-progress-variant"
            v-model="flowForm.progressVariant"
            :disabled="!canManageFlow"
          >
            <option value="steps">完整步骤</option>
            <option value="compact">紧凑进度</option>
            <option value="minimal">极简进度</option>
          </select>
        </div>
      </div>
      <div class="setting-toggle-grid">
        <label class="setting-toggle">
          <input v-model="flowForm.waitlist" type="checkbox" :disabled="!canManageFlow" />
          <span><strong>售罄候补</strong><small>票种售罄后展示候补入口</small></span>
        </label>
        <label class="setting-toggle">
          <input
            v-model="flowForm.invoiceAfterPayment"
            type="checkbox"
            :disabled="!canManageFlow"
          />
          <span><strong>支付后补发票资料</strong><small>付费且勾选发票意向时出现</small></span>
        </label>
        <label class="setting-toggle">
          <input v-model="flowForm.manualReview" type="checkbox" :disabled="!canManageFlow" />
          <span><strong>人工审核分支</strong><small>审核通过后进入支付</small></span>
        </label>
      </div>
      <div v-if="canManageFlow" class="event-form-actions">
        <button class="button" type="submit" :disabled="flowPending">
          {{ flowPending ? '保存中…' : '保存报名流程' }}
        </button>
      </div>
    </form>
  </section>

  <AdminConfirmDialog
    :open="Boolean(confirmation)"
    :event-name="session.activeEvent.value?.name"
    :title="confirmation?.title ?? ''"
    :description="confirmation?.description ?? ''"
    :confirm-label="confirmation?.confirmLabel ?? '确认并生效'"
    :tone="confirmation?.tone ?? 'primary'"
    :details="confirmation?.details ?? []"
    :busy="settingsPending || ticketPending || flowPending"
    :error="errorMessage"
    @cancel="confirmation = undefined"
    @confirm="confirmImportantChange"
  />
</template>
