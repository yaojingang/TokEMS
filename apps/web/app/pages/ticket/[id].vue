<script setup lang="ts">
import QrcodeVue from 'qrcode.vue';
import { publicEventHomePath, publicEventScopedPath, type Ticket } from '@conference/contracts';
import {
  activeFlowStep,
  enabledFlowSteps,
  resolveEventExperience,
} from '~/composables/useEventExperience';

const route = useRoute();
const api = useConferenceApi();
const ticket = ref<Ticket>();
const checkout = ref(api.readCheckout());
const event = api.eventState;
const loading = ref(true);
const errorMessage = ref('');
const invoiceAccess = ref(api.readInvoiceAccess());
const ticketStatus = computed(() =>
  ticket.value?.refundPending
    ? '退款处理中，暂停使用'
    : { valid: '有效票', used: '已核销', cancelled: '已取消' }[ticket.value?.status ?? 'valid'],
);
const dateRange = computed(() => {
  const format = new Intl.DateTimeFormat('zh-CN', {
    timeZone: event.value.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return `${format.format(new Date(event.value.startsAt))} 至 ${format.format(new Date(event.value.endsAt))}`;
});
const homeHref = computed(() => api.resolveConferenceUrl(publicEventHomePath(event.value.slug)));
const paymentSurface = computed(() => api.isPaymentSurface());
const paymentRequired = computed(
  () => checkout.value?.order.amount !== 0 && checkout.value?.order.paymentMethod !== 'free',
);
const experience = computed(() => resolveEventExperience(event.value));
const flowSteps = computed(() =>
  enabledFlowSteps(event.value, {
    paymentRequired: paymentRequired.value,
    invoiceRequired: Boolean(invoiceAccess.value),
  }),
);
const interactiveFlowSteps = computed(() =>
  flowSteps.value.map((step) => {
    if (
      !experience.value.registrationFlow.branches.successActions ||
      !ticket.value ||
      ticket.value.status === 'cancelled'
    ) {
      return step.title;
    }
    if (step.type === 'member-profile') {
      return {
        title: step.title,
        to: api.resolveConferenceUrl(
          publicEventScopedPath(
            `/account/registrations/${encodeURIComponent(ticket.value.registrationId)}/showcase`,
            event.value.slug,
          ),
        ),
        hint: '去完善 →',
      };
    }
    if (step.type === 'attendee-needs') {
      return {
        title: step.title,
        to: api.resolveConferenceUrl(
          publicEventScopedPath(
            `/account/registrations/${encodeURIComponent(ticket.value.registrationId)}/needs`,
            event.value.slug,
          ),
        ),
        hint: '去提交 →',
      };
    }
    return step.title;
  }),
);
const activeStep = computed(() => activeFlowStep(flowSteps.value, 'success-ticket'));
const invoiceHref = computed(() =>
  invoiceAccess.value
    ? publicEventScopedPath(`/invoice/${invoiceAccess.value.id}`, event.value.slug)
    : '',
);
const organizerHref = computed(() => {
  if (!ticket.value) return '';
  const path = publicEventScopedPath('/account', event.value.slug, {
    registration: ticket.value.registrationId,
    service: 'organizer_contact',
  });
  return api.resolveConferenceUrl(path);
});
useHead(() => ({ title: `电子票 · ${ticket.value?.eventName ?? event.value.name}` }));

onMounted(async () => {
  try {
    checkout.value = api.readCheckout();
    invoiceAccess.value = api.readInvoiceAccess();
    const eventSlug = new URL(window.location.href).searchParams.get('event') ?? '';
    if (eventSlug) event.value = await api.getEvent(eventSlug);
    const identifier = String(route.params.id);
    ticket.value = await api.getTicket(identifier);
    if (ticket.value) api.saveTicket(ticket.value);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '电子票读取失败。';
  } finally {
    loading.value = false;
  }
});

function printTicket() {
  window.print();
}
</script>

<template>
  <div class="flow-page">
    <FlowHeader />
    <main class="flow-shell" id="main-content">
      <div class="state-panel">
        <div class="state-icon" aria-hidden="true">
          {{ ticket?.status === 'cancelled' ? '!' : '✓' }}
        </div>
        <p class="flow-eyebrow" style="justify-content: center">REGISTRATION CONFIRMED</p>
        <h1>{{ ticket?.status === 'cancelled' ? '电子票已取消' : '电子票已签发' }}</h1>
        <p v-if="ticket?.status === 'cancelled'">
          该票当前不可用于入场，请联系大会运营方核对订单。
        </p>
        <p v-else>请在入场时出示下方二维码。建议截图保存，弱网环境下也可完成验票。</p>
      </div>
      <FlowStepper
        :active="activeStep"
        :payment-required="paymentRequired"
        :steps="interactiveFlowSteps"
        :variant="experience.registrationFlow.progressVariant"
      />

      <article v-if="ticket" class="ticket-paper">
        <section class="ticket-paper__main">
          <span class="ticket-status" :data-status="ticket.status">{{ ticketStatus }}</span>
          <h1>{{ ticket.eventName }}</h1>
          <dl class="ticket-meta">
            <div>
              <dt>参会人</dt>
              <dd>{{ ticket.attendeeName }}</dd>
            </div>
            <div>
              <dt>票种</dt>
              <dd>{{ ticket.ticketTypeName }}</dd>
            </div>
            <div>
              <dt>时间</dt>
              <dd>{{ dateRange }}</dd>
            </div>
            <div>
              <dt>地点</dt>
              <dd>{{ event.city }} · {{ event.venue }}</dd>
            </div>
          </dl>
          <div class="ticket-code">TICKET / {{ ticket.code }}</div>
        </section>
        <aside class="ticket-paper__aside">
          <div>
            <QrcodeVue
              v-if="!ticket.refundPending && ticket.status !== 'cancelled'"
              class="ticket-qr"
              :value="ticket.qrPayload"
              :size="184"
              level="H"
            />
            <strong>{{
              ticket.refundPending
                ? '退款处理中，票券暂停使用'
                : ticket.status === 'cancelled'
                  ? '票券已取消'
                  : '现场扫码签到'
            }}</strong>
            <small style="color: var(--conference-ink-muted)">一人一码 · 仅限使用一次</small>
          </div>
        </aside>
      </article>

      <div v-else-if="loading" class="flow-card flow-card__body" style="text-align: center">
        正在读取电子票…
      </div>
      <div v-else class="form-error" style="max-width: 720px; margin-inline: auto">
        {{ errorMessage || '未找到电子票，请通过订单页重新查询。' }}
      </div>

      <div
        v-if="ticket && experience.registrationFlow.branches.successActions"
        class="ticket-actions"
      >
        <NuxtLink v-if="invoiceHref" class="flow-action" :to="invoiceHref"> 填写发票信息 </NuxtLink>
        <button class="flow-action" type="button" @click="printTicket">打印 / 导出电子票</button>
        <a v-if="paymentSurface" class="flow-action is-secondary" :href="homeHref">返回大会首页</a>
        <NuxtLink v-else class="flow-action is-secondary" :to="homeHref">返回大会首页</NuxtLink>
        <div v-if="ticket.status !== 'cancelled'" class="ticket-organizer-action">
          <NuxtLink class="flow-action is-organizer" :to="organizerHref"> 添加大会组织者 </NuxtLink>
          <small>添加后，等待邀请进入会员群</small>
        </div>
      </div>
    </main>
  </div>
</template>
