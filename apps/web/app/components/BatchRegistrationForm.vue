<script setup lang="ts">
import { nextTick, toRaw, watch } from 'vue';
import type {
  CreateRegistrationBatch,
  EventPurchaseContext,
  PublicEvent,
  RegistrationBatchQuote,
} from '@conference/contracts';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  useBatchPurchase,
  batchErrorMessage,
  batchErrorStatus,
} from '~/composables/useBatchPurchase';
import { resolveEventExperience } from '~/composables/useEventExperience';
import { removeRegistrationDraftVersions } from '~/utils/registration-draft';
import { browserLocalStorage, browserSessionStorage } from '~/utils/browser-storage';
import {
  batchCardHasData,
  batchDraftKey,
  createBatchDraftCard,
  migrateSingleRegistrationDraft,
  normalizedRegistrationMobile,
  pruneBatchDrafts,
  readBatchDraft,
  removeBatchDraft,
  sanitizeBatchCards,
  writeBatchDraft,
  type BatchDraftCard,
  type BatchDraftScope,
} from '~/utils/batch-registration-draft';

const props = defineProps<{
  event: PublicEvent;
  ticketTypeId: string;
  purchaseIntentId: string;
  initialPurchaseFor: 'self' | 'other';
  purchaseContext: EventPurchaseContext | null;
  ready: boolean;
}>();
const emit = defineEmits<{ ticket: [id: string]; complete: []; refresh: [] }>();
const customer = useCustomerSession();
const batch = useBatchPurchase();
const api = useConferenceApi();
const router = useRouter();
const cards = ref<BatchDraftCard[]>([]);
const quote = ref<RegistrationBatchQuote | null>(null);
const quoting = ref(false);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const storageUnavailable = ref(false);
const termsAccepted = ref(true);
const termsOpen = ref(false);
const quoteNeedsConfirmation = ref(false);
const collapsed = ref(new Set<string>());
const fieldErrors = ref<Record<string, Record<string, string>>>({});
const removeCount = ref(0);
const removalSelection = ref<string[]>([]);
const removedCards = ref<{ card: BatchDraftCard; index: number }[]>([]);
const submittedInput = ref<CreateRegistrationBatch | null>(null);
const fields = computed(() =>
  (props.event.registrationForm?.fields ?? []).filter((field) => field.enabled !== false),
);
const ticket = computed(
  () =>
    props.event.tickets.find((item) => item.id === props.ticketTypeId) ?? props.event.tickets[0],
);
const quantity = computed(() => cards.value.length || 1);
const hasSelf = computed(() => cards.value.some((card) => card.isSelf));
const selfUnavailable = computed(() => props.purchaseContext?.selfRegistrationState === 'active');
const hasProxy = computed(() => cards.value.some((card) => !card.isSelf));
const manualReview = computed(
  () => quote.value?.manualReview ?? experience.value.registrationFlow.branches.manualReview,
);
const additionalAllowed = computed(
  () =>
    quote.value?.additionalPurchaseEnabled ?? props.event.registration.additionalPurchaseEnabled,
);
const quoteMatches = computed(
  () => quote.value?.quantity === quantity.value && quote.value.ticketTypeId === ticket.value?.id,
);
const maxQuantity = computed(() =>
  Math.max(
    0,
    Math.min(
      additionalAllowed.value ? 20 : 1,
      quote.value?.remainingSeatCount ??
        props.purchaseContext?.remainingSeatCount ??
        props.event.registration.maxActiveSeatsPerPurchaser,
      quote.value?.availableQuantity ?? ticket.value?.remaining ?? 0,
    ),
  ),
);
const total = computed(() =>
  quoteMatches.value ? quote.value!.amount : (ticket.value?.price ?? 0) * quantity.value,
);
const unitPrice = computed(() =>
  quoteMatches.value ? quote.value!.unitPrice : (ticket.value?.price ?? 0),
);
const currency = computed(() =>
  quoteMatches.value ? quote.value!.currency : (ticket.value?.currency ?? 'CNY'),
);
const activeSeats = computed(
  () => quote.value?.activeSeatCount ?? props.purchaseContext?.activeSeatCount ?? 0,
);
const cap = computed(
  () =>
    quote.value?.maxActiveSeatsPerPurchaser ?? props.event.registration.maxActiveSeatsPerPurchaser,
);
const pendingOrderId = computed(
  () => quote.value?.pendingOrderId ?? props.purchaseContext?.resumePaymentOrderId,
);
const registrationAvailable = computed(
  () => props.event.status === 'registration_open' && props.event.registration.registrationOpen,
);
const experience = computed(() => resolveEventExperience(props.event));
const waiting = computed(() =>
  Boolean(
    ticket.value &&
    ticket.value.remaining < 1 &&
    experience.value.registrationFlow.branches.waitlist &&
    quantity.value === 1 &&
    hasSelf.value,
  ),
);
const locked = computed(() => pending.value || Boolean(submittedInput.value));
const blocked = computed(() => {
  if (pendingOrderId.value) return '请先处理已有订单，再提交新的购买。';
  if (!registrationAvailable.value) return '当前大会已暂停报名。';
  if (!additionalAllowed.value && (quantity.value > 1 || !hasSelf.value))
    return '主办方已关闭多人和代报名。本次资料已保留，当前仅可提交本人一个名额。';
  if (!waiting.value && quantity.value > maxQuantity.value)
    return `当前最多可购买 ${maxQuantity.value} 个名额，请调整数量。`;
  return waiting.value ? '' : (quote.value?.blockedReason ?? '');
});
const completeCount = computed(
  () => cards.value.filter((card) => !Object.keys(validateCard(card)).length).length,
);
const money = (amount: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: currency.value,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount / 100);
const termsVersion = computed(() => props.event.registrationForm?.termsVersion ?? '');
const formVersion = computed(() => props.event.registrationForm?.version ?? 1);
let activeScope: BatchDraftScope | null = null;
let completed = false;
let disposed = false;
let quoteSequence = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let quoteTimer: ReturnType<typeof setTimeout> | undefined;
let touchedBeforeRestore = false;

function scope(): BatchDraftScope | null {
  if (!import.meta.client || !props.purchaseIntentId) return null;
  return {
    organizationId: props.event.organizationId,
    eventId: props.event.id,
    ownerId: customer.session.value
      ? `customer:${customer.session.value.customer.id}`
      : 'anonymous',
    purchaseIntentId: props.purchaseIntentId,
  };
}
function store(owner: BatchDraftScope['ownerId']) {
  return String(owner).startsWith('customer:') ? browserLocalStorage : browserSessionStorage;
}
function storageWorks(owner: BatchDraftScope['ownerId']) {
  try {
    const storage = String(owner).startsWith('customer:')
      ? window.localStorage
      : window.sessionStorage;
    const key = 'conference.batchDraftStorageProbe';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
function saveDraft() {
  if (!activeScope || completed || !cards.value.length) return;
  storageUnavailable.value = !storageWorks(activeScope.ownerId);
  writeBatchDraft(
    store(activeScope.ownerId),
    activeScope,
    { formVersion: formVersion.value, ticketTypeId: props.ticketTypeId, cards: cards.value },
    fields.value,
  );
}
function prefill() {
  const session = customer.session.value;
  const self = cards.value.find((card) => card.isSelf);
  if (!session || !self) return;
  const values: Record<string, string> = {
    name: session.customer.profile.realName || session.customer.profile.nickname || '',
    mobile: session.customer.mobile,
    email: session.customer.profile.email || '',
    company: session.customer.profile.company || '',
    title: session.customer.profile.title || '',
    city: session.customer.profile.city || '',
  };
  for (const field of fields.value) {
    if (field.key === 'mobile') self.answers.mobile = session.customer.mobile;
    else if (!self.editedKeys.includes(field.key) && !self.answers[field.key] && values[field.key])
      self.answers[field.key] = values[field.key]!;
  }
}
function initialCards() {
  return [createBatchDraftCard(props.initialPurchaseFor === 'self' && !selfUnavailable.value)];
}
function restoreDraft() {
  const next = scope();
  if (!next || completed || (activeScope && batchDraftKey(next) === batchDraftKey(activeScope)))
    return;
  const previous = activeScope;
  if (previous) saveDraft();
  const login = previous?.ownerId === 'anonymous' && next.ownerId !== 'anonymous';
  const accountChanged = previous && previous.ownerId !== next.ownerId && !login;
  if (previous && !login) termsAccepted.value = true;
  if (accountChanged) {
    cards.value = initialCards();
    touchedBeforeRestore = false;
    fieldErrors.value = {};
    collapsed.value.clear();
    removedCards.value = [];
    submittedInput.value = null;
    quote.value = null;
    termsOpen.value = false;
    quoteNeedsConfirmation.value = false;
    removeCount.value = 0;
    removalSelection.value = [];
    errorMessage.value = '';
    message.value = '';
  }
  activeScope = next;
  // A session expiry clears the visible form. Its private draft can be restored after reauthentication.
  if (accountChanged && next.ownerId === 'anonymous') return;
  const storage = store(next.ownerId);
  const saved =
    readBatchDraft(storage, next, fields.value) ??
    migrateSingleRegistrationDraft(
      storage,
      { ...next, purchaseFor: props.initialPurchaseFor },
      formVersion.value,
      props.ticketTypeId,
      fields.value,
    );
  if (saved && !((!previous || login) && touchedBeforeRestore)) {
    cards.value = saved.cards;
    if (props.event.tickets.some((item) => item.id === saved.ticketTypeId))
      emit('ticket', saved.ticketTypeId);
    message.value = `已恢复 ${saved.cards.length} 位参会人的资料，请核对后继续。`;
  } else if (!cards.value.length || (previous && !login && !accountChanged))
    cards.value = initialCards();
  if (selfUnavailable.value)
    for (const card of cards.value)
      if (card.isSelf) {
        card.isSelf = false;
        card.answers = {};
        card.editedKeys = [];
      }
  prefill();
  saveDraft();
  if (login && previous) removeBatchDraft(store(previous.ownerId), previous);
  if (saved)
    removeRegistrationDraftVersions(storage, { ...next, purchaseFor: props.initialPurchaseFor });
}
function completeDraft() {
  completed = true;
  if (saveTimer) clearTimeout(saveTimer);
  if (activeScope) {
    removeBatchDraft(store(activeScope.ownerId), activeScope);
    removeBatchDraft(browserSessionStorage, { ...activeScope, ownerId: 'anonymous' });
    for (const purchaseFor of ['self', 'other'] as const)
      removeRegistrationDraftVersions(store(activeScope.ownerId), { ...activeScope, purchaseFor });
  }
  emit('complete');
}
function clearDraft() {
  if (!window.confirm('清空本次所有参会人资料？')) return;
  cards.value = initialCards();
  prefill();
  termsAccepted.value = true;
  removedCards.value = [];
  fieldErrors.value = {};
  message.value = '本次草稿已清空。';
  touchedBeforeRestore = true;
  saveDraft();
}
function edit(card: BatchDraftCard, key: string) {
  if (!card.editedKeys.includes(key)) card.editedKeys.push(key);
  touchedBeforeRestore = true;
  if (fieldErrors.value[card.clientId]?.[key]) delete fieldErrors.value[card.clientId]![key];
}
function setSelf(value: boolean) {
  if (locked.value || (value && selfUnavailable.value)) return;
  const first = cards.value.find((card) => card.isSelf) ?? cards.value[0];
  if (!first) return;
  if (
    batchCardHasData(first) &&
    !window.confirm(
      value
        ? '第一位将改为本人，原第一位资料将替换为登录账号资料。其他参会人资料保留。'
        : '取消包含本人后，第一位需要重新填写实际参会人的资料。',
    )
  )
    return;
  first.isSelf = value;
  first.answers = {};
  first.editedKeys = [];
  prefill();
  touchedBeforeRestore = true;
}
function requestQuantity(value: number) {
  if (locked.value) return;
  const next = Math.max(1, Math.min(20, Math.trunc(value)));
  if (!Number.isFinite(value)) return;
  if (next > quantity.value) {
    if (next > maxQuantity.value) {
      errorMessage.value = `当前最多可购买 ${maxQuantity.value} 个名额。`;
      return;
    }
    cards.value.push(
      ...Array.from({ length: next - cards.value.length }, () => createBatchDraftCard()),
    );
    removedCards.value = [];
  } else if (next < quantity.value) {
    const count = quantity.value - next;
    const empty = cards.value.filter((card) => !batchCardHasData(card) && !card.isSelf).reverse();
    if (empty.length >= count) removeCards(empty.slice(0, count).map((card) => card.clientId));
    else {
      removeCount.value = count;
      removalSelection.value = empty.map((card) => card.clientId);
      message.value = `请选择要移除的 ${count} 位参会人，确认后可撤销。`;
    }
  }
  touchedBeforeRestore = true;
}
function removeCards(ids: string[]) {
  if (locked.value || ids.length >= cards.value.length) return;
  removedCards.value = cards.value.flatMap((card, index) =>
    ids.includes(card.clientId) ? [{ card: structuredClone(toRaw(card)), index }] : [],
  );
  cards.value = cards.value.filter((card) => !ids.includes(card.clientId));
  removeCount.value = 0;
  removalSelection.value = [];
  message.value = `已移除 ${ids.length} 位参会人。`;
}
function removeCard(card: BatchDraftCard) {
  if (locked.value || cards.value.length < 2) return;
  if (
    batchCardHasData(card) &&
    !window.confirm(`确认移除 ${card.answers.name || '这位参会人'}？已填写资料可通过撤销恢复。`)
  )
    return;
  removeCards([card.clientId]);
}
function undoRemoval() {
  if (locked.value || quantity.value + removedCards.value.length > 20) return;
  for (const removed of removedCards.value) cards.value.splice(removed.index, 0, removed.card);
  removedCards.value = [];
  message.value = '已恢复参会人资料，请核对当前可购买数量。';
}
function copyCompany(index: number) {
  const previous = cards.value[index - 1];
  const card = cards.value[index];
  if (!card || !previous?.answers.company || card.answers.company) return;
  card.answers.company = previous.answers.company;
  edit(card, 'company');
}
function fieldMaximum(key: string) {
  return (
    ({ name: 80, mobile: 24, company: 120, title: 80, city: 60 } as Record<string, number>)[key] ??
    2000
  );
}
function validateCard(card: BatchDraftCard) {
  const errors: Record<string, string> = {};
  for (const field of fields.value) {
    const value = (card.answers[field.key] ?? '').trim();
    if (field.required && !value) errors[field.key] = `请填写${field.label}`;
    else if (value.length > fieldMaximum(field.key))
      errors[field.key] = `${field.label}最多填写 ${fieldMaximum(field.key)} 个字符`;
    else if (
      value &&
      field.key === 'mobile' &&
      !/^1\d{10}$/.test(normalizedRegistrationMobile(value))
    )
      errors[field.key] = '请填写有效的中国大陆手机号';
    else if (
      value &&
      field.type === 'tel' &&
      field.key !== 'mobile' &&
      (value.length < 7 || value.length > 32)
    )
      errors[field.key] = `请填写有效的${field.label}`;
    else if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      errors[field.key] = '请填写有效的邮箱地址';
    else if (value && field.type === 'select' && !field.options?.includes(value))
      errors[field.key] = `请重新选择${field.label}`;
  }
  const mobile = normalizedRegistrationMobile(card.answers.mobile ?? '');
  if (
    mobile &&
    cards.value.filter(
      (candidate) => normalizedRegistrationMobile(candidate.answers.mobile ?? '') === mobile,
    ).length > 1
  )
    errors.mobile = '本次报名的手机号不能重复';
  if (
    !card.isSelf &&
    mobile &&
    mobile === normalizedRegistrationMobile(customer.session.value?.customer.mobile ?? '')
  )
    errors.mobile = '本人手机号请通过“包含本人参会”填写';
  return errors;
}
function fieldId(card: BatchDraftCard, key: string) {
  return `batch-${card.clientId}-${key}`;
}
async function focusError() {
  const card = cards.value.find(
    (item) => Object.keys(fieldErrors.value[item.clientId] ?? {}).length,
  );
  if (!card) return;
  collapsed.value.delete(card.clientId);
  await nextTick();
  const key = Object.keys(fieldErrors.value[card.clientId] ?? {})[0];
  const element = document.getElementById(fieldId(card, key!));
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ block: 'center', behavior: 'auto' });
}
async function refreshQuote(explicit = false) {
  if (!customer.session.value || !ticket.value || !props.ready) return null;
  const sequence = ++quoteSequence;
  const identity = customer.session.value.customer.id;
  const input = {
    eventId: props.event.id,
    ticketTypeId: ticket.value.id,
    quantity: quantity.value,
  };
  quoting.value = true;
  try {
    const result = await batch.quote(input);
    if (
      disposed ||
      sequence !== quoteSequence ||
      customer.session.value?.customer.id !== identity ||
      input.quantity !== quantity.value ||
      input.ticketTypeId !== ticket.value?.id
    )
      return null;
    const previous = quote.value;
    const displayed =
      previous?.ticketTypeId === result.ticketTypeId
        ? previous
        : {
            unitPrice: ticket.value?.price,
            currency: ticket.value?.currency,
            formVersion: formVersion.value,
            termsVersion: termsVersion.value,
            manualReview: result.manualReview,
          };
    if (
      displayed.unitPrice !== result.unitPrice ||
      displayed.currency !== result.currency ||
      displayed.formVersion !== result.formVersion ||
      displayed.termsVersion !== result.termsVersion ||
      displayed.manualReview !== result.manualReview ||
      (explicit &&
        previous?.quantity === result.quantity &&
        previous.ticketTypeId === result.ticketTypeId &&
        previous.quoteFingerprint !== result.quoteFingerprint)
    ) {
      quoteNeedsConfirmation.value = true;
      termsAccepted.value = false;
      message.value = '票价或报名规则已更新，请核对当前金额和条款后重新确认。';
    }
    quote.value = result;
    return result;
  } catch (error) {
    if (sequence !== quoteSequence || customer.session.value?.customer.id !== identity) return null;
    if (batchErrorStatus(error) === 401) {
      saveDraft();
      await customer.refresh(true).catch(() => null);
      if (customer.session.value && customer.session.value.customer.id !== identity) return null;
      customer.openLogin();
      errorMessage.value = '登录已过期，请重新验证手机号。当前账号的资料已经保留。';
    } else if (
      batchErrorStatus(error) === 403 &&
      (error as { data?: { details?: { reason?: string } } }).data?.details?.reason ===
        'customer_csrf_invalid'
    ) {
      await customer.refresh(true).catch(() => null);
      if (customer.session.value?.customer.id === identity)
        errorMessage.value = '登录验证已更新，请重新确认购买。';
    } else errorMessage.value = batchErrorMessage(error, '暂时无法确认购买额度，请重试。');
    return null;
  } finally {
    if (sequence === quoteSequence) quoting.value = false;
  }
}
function scheduleQuote() {
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => void refreshQuote(), 180);
}
async function submit() {
  errorMessage.value = '';
  if (!customer.session.value) {
    saveDraft();
    customer.openLogin();
    return;
  }
  if (pending.value || !props.ready) return;
  if (!submittedInput.value) {
    fieldErrors.value = Object.fromEntries(
      cards.value.map((card) => [card.clientId, validateCard(card)]),
    );
    if (cards.value.some((card) => Object.keys(fieldErrors.value[card.clientId] ?? {}).length)) {
      errorMessage.value = '请完善标记的参会人信息，其他资料已保留。';
      await focusError();
      return;
    }
    if (!termsAccepted.value) {
      errorMessage.value = '请阅读并同意报名条款后继续。';
      document.getElementById('batch-terms-accepted')?.focus();
      return;
    }
    if (quoteNeedsConfirmation.value) {
      termsAccepted.value = false;
      errorMessage.value = '请先确认更新后的金额和规则。';
      return;
    }
  }
  pending.value = true;
  const owner = customer.session.value.customer.id;
  try {
    if (waiting.value && !submittedInput.value) {
      if (pendingOrderId.value) {
        errorMessage.value = '请先处理已有订单。';
        return;
      }
      const first = cards.value[0]!;
      const entry = await api.joinWaitlist({
        eventId: props.event.id,
        ticketTypeId: props.ticketTypeId,
        name: first.answers.name?.trim() ?? '',
        email: first.answers.email?.trim() ?? '',
        mobile: customer.session.value.customer.mobile,
      });
      if (customer.session.value?.customer.id !== owner) return;
      completeDraft();
      message.value = `候补申请已提交，当前位于第 ${entry.position} 位。名额释放后将发送报名邀请。`;
      return;
    }
    if (!submittedInput.value) {
      const fresh = await refreshQuote(true);
      if (!fresh || quoteNeedsConfirmation.value) return;
      if (blocked.value) {
        errorMessage.value = blocked.value;
        return;
      }
      if (fresh.formVersion !== formVersion.value || fresh.termsVersion !== termsVersion.value) {
        errorMessage.value = '报名表或条款已更新，资料已保留，请刷新页面后核对。';
        return;
      }
      submittedInput.value = {
        eventId: props.event.id,
        ticketTypeId: props.ticketTypeId,
        quantity: quantity.value,
        purchaseIntentId: props.purchaseIntentId,
        formVersion: formVersion.value,
        termsVersion: termsVersion.value,
        termsAccepted: true,
        proxyAuthorizationAccepted: hasProxy.value,
        quoteFingerprint: fresh.quoteFingerprint,
        attendees: cards.value.map((card) => {
          const value = (key: string) =>
            fields.value.some((field) => field.key === key)
              ? String(card.answers[key] ?? '').trim()
              : '';
          return {
            clientId: card.clientId,
            isSelf: card.isSelf,
            attendee: {
              name: value('name'),
              mobile: card.isSelf ? customer.session.value!.customer.mobile : value('mobile'),
              email: value('email'),
              company: value('company'),
              title: value('title'),
              city: value('city'),
            },
            formAnswers: Object.fromEntries(
              fields.value.map((field) => [field.key, value(field.key)]),
            ),
            marketingConsent: false,
          };
        }),
      };
    }
    const checkout = await batch.create(submittedInput.value);
    if (customer.session.value?.customer.id !== owner) return;
    completeDraft();
    if (checkout.nextAction !== 'payment') {
      await router.push(`/account/orders/${encodeURIComponent(checkout.order.id)}`);
      return;
    }
    const href = api.resolvePaymentCheckoutUrl(
      checkout.order.id,
      props.event.slug,
      checkout.orderAccessToken,
    );
    if (/^https?:\/\//i.test(href)) window.location.assign(href);
    else await router.push(href);
  } catch (error) {
    if (customer.session.value?.customer.id !== owner) return;
    const status = batchErrorStatus(error);
    if (status && status >= 400 && status < 500) submittedInput.value = null;
    if (status === 401) {
      saveDraft();
      await customer.refresh(true).catch(() => null);
      customer.openLogin();
      errorMessage.value = '登录已过期，请重新验证手机号。当前账号的资料已经保留。';
    } else {
      errorMessage.value = batchErrorMessage(error, '提交结果尚未确认，请使用原资料重试。');
      const details = (
        error as {
          data?: {
            details?: {
              clientId?: string;
              field?: string;
              errors?: Array<{ clientId?: string; field?: string; message?: string }>;
              issues?: Array<{ path?: Array<string | number>; message?: string }>;
            };
          };
        }
      ).data?.details;
      const failures = details?.errors ?? (details?.clientId ? [details] : []);
      for (const failure of failures)
        if (failure.clientId)
          fieldErrors.value[failure.clientId] = {
            ...fieldErrors.value[failure.clientId],
            [failure.field ?? 'mobile']:
              'message' in failure && typeof failure.message === 'string'
                ? failure.message
                : errorMessage.value,
          };
      for (const issue of details?.issues ?? []) {
        const path = issue.path ?? [];
        if (path[0] !== 'attendees' || typeof path[1] !== 'number') continue;
        const card = cards.value[path[1]];
        const field = fields.value.find((candidate) => candidate.key === path[3]);
        if (!card || !field || !['attendee', 'formAnswers'].includes(String(path[2]))) continue;
        fieldErrors.value[card.clientId] = {
          ...fieldErrors.value[card.clientId],
          [field.key]: issue.message || `请检查${field.label}`,
        };
      }
      if (status === 409) {
        quoteNeedsConfirmation.value = true;
        termsAccepted.value = false;
        await refreshQuote();
        emit('refresh');
      }
      if (!status || status >= 500) {
        await refreshQuote();
        emit('refresh');
      }
    }
  } finally {
    pending.value = false;
    if (!disposed && customer.session.value?.customer.id === owner && !submittedInput.value)
      await focusError();
  }
}

watch(
  () => [props.purchaseIntentId, props.event.id, customer.session.value?.customer.id],
  () => {
    restoreDraft();
    scheduleQuote();
  },
);
watch(
  () => [
    props.ticketTypeId,
    quantity.value,
    props.ready,
    props.event.registrationForm?.version,
    props.event.registrationForm?.termsVersion,
  ],
  () => {
    cards.value = sanitizeBatchCards(cards.value, fields.value) ?? initialCards();
    scheduleQuote();
  },
);
watch([formVersion, termsVersion], () => {
  termsAccepted.value = false;
});
watch(() => customer.session.value, prefill);
watch(selfUnavailable, (unavailable) => {
  if (!unavailable) return;
  const self = cards.value.find((card) => card.isSelf);
  if (self) {
    self.isSelf = false;
    self.answers = {};
    self.editedKeys = [];
    message.value = '你已有本场大会名额，本次请填写其他参会人的资料。';
  }
});
watch(
  cards,
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 350);
  },
  { deep: true },
);
onMounted(() => {
  cards.value = initialCards();
  pruneBatchDrafts(browserLocalStorage);
  pruneBatchDrafts(browserSessionStorage);
  restoreDraft();
  prefill();
  scheduleQuote();
  window.addEventListener('pagehide', saveDraft);
});
onBeforeUnmount(() => {
  saveDraft();
  disposed = true;
  quoteSequence += 1;
  if (saveTimer) clearTimeout(saveTimer);
  if (quoteTimer) clearTimeout(quoteTimer);
  window.removeEventListener('pagehide', saveDraft);
});
</script>

<template>
  <div
    class="flow-grid batch-registration"
    :class="{ 'is-single-column': !experience.registrationFlow.summaryCardEnabled }"
  >
    <form class="flow-card" novalidate @submit.prevent="submit">
      <div class="flow-card__head">
        <h2>选择名额并填写资料</h2>
        <p>每位参会人一份资料，所有名额统一支付。</p>
      </div>
      <div class="flow-card__body">
        <fieldset :disabled="locked" class="batch-fieldset">
          <legend class="form-section-title batch-first-title">选择票种</legend>
          <div class="ticket-options">
            <label
              v-for="option in event.tickets"
              :key="option.id"
              class="ticket-option"
              :class="{ 'is-selected': ticketTypeId === option.id }"
            >
              <input
                type="radio"
                name="batch-ticket"
                :value="option.id"
                :checked="ticketTypeId === option.id"
                @change="emit('ticket', option.id)"
              />
              <span><span class="ticket-option__name">{{ option.name }}</span><span class="ticket-option__desc">{{ option.description }}</span><span class="ticket-option__stock">剩余 {{ option.remaining }} 席</span></span>
              <strong class="ticket-option__price">{{ option.price === 0 ? '免费' : money(option.price)
              }}<small v-if="option.price"> / 人</small></strong>
            </label>
          </div>
          <section class="quantity-section" aria-labelledby="batch-quantity-title">
            <div class="quantity-heading">
              <h3 id="batch-quantity-title">本次购买</h3>
              <span>{{ ticket?.name }} · {{ money(unitPrice) }} / 人</span>
            </div>
            <div class="quantity-controls">
              <div class="quantity-stepper">
                <button
                  type="button"
                  aria-label="减少一个名额"
                  :disabled="quantity <= 1"
                  @click="requestQuantity(quantity - 1)"
                >
                  −
                </button>
                <input
                  id="batch-quantity"
                  :value="quantity"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  :max="Math.max(1, maxQuantity)"
                  step="1"
                  aria-label="本次购买名额数量"
                  @change="
                    requestQuantity(Number(($event.target as HTMLInputElement).value));
                    ($event.target as HTMLInputElement).value = String(quantity);
                  "
                />
                <button
                  type="button"
                  aria-label="增加一个名额"
                  :disabled="quantity >= maxQuantity"
                  @click="requestQuantity(quantity + 1)"
                >
                  +
                </button>
              </div>
              <div class="quick-quantities" aria-label="快速选择数量">
                <button
                  v-for="count in [1, 2, 3, 5].filter((n) => n <= Math.max(1, maxQuantity))"
                  :key="count"
                  type="button"
                  :aria-pressed="quantity === count"
                  @click="requestQuantity(count)"
                >
                  {{ count }} 位
                </button>
              </div>
            </div>
            <p class="batch-help" aria-live="polite">
              {{
                customer.session.value
                  ? `本账号已占用 ${activeSeats} / ${cap} 个名额，当前最多可购买 ${maxQuantity} 个。`
                  : `本场每位购票人最多 ${cap} 个名额，登录后确认剩余额度。`
              }}
            </p>
            <p v-if="quantity > 1 && (ticket?.remaining ?? 0) < 1" class="batch-help">
              候补仅限本人一个名额。请先保存或调整参会人资料，再提交候补。
            </p>
          </section>
        </fieldset>
        <div v-if="pendingOrderId" class="batch-notice" role="status">
          <strong>已有一笔订单待处理</strong>
          <p>原订单的数量和金额已固定，可继续办理，或取消后重新选择。</p>
          <NuxtLink :to="`/account/orders/${pendingOrderId}`">查看订单并继续 →</NuxtLink>
        </div>
        <section v-if="removeCount" class="remove-selection" aria-labelledby="remove-title">
          <h3 id="remove-title">选择移除 {{ removeCount }} 位</h3>
          <p>已填写资料会保留至本次撤销操作结束。</p>
          <label v-for="(card, index) in cards" :key="card.clientId"><input
            v-model="removalSelection"
            type="checkbox"
            :value="card.clientId"
            :disabled="locked"
          />参会人 {{ index + 1 }} · {{ card.answers.name || '尚未填写'
          }}{{ card.isSelf ? '（本人）' : '' }}</label>
          <div class="inline-actions">
            <button
              type="button"
              class="batch-button"
              :disabled="locked || removalSelection.length !== removeCount"
              @click="removeCards(removalSelection)"
            >
              确认移除 {{ removeCount }} 位
            </button><button type="button" class="batch-button" @click="removeCount = 0">
              保留当前人数
            </button>
          </div>
        </section>
        <p v-if="message" class="batch-notice" role="status">
          {{ message }}
          <button
            v-if="removedCards.length"
            class="text-button"
            type="button"
            :disabled="locked"
            @click="undoRemoval"
          >
            撤销移除
          </button>
        </p>
        <div class="batch-auth">
          <p v-if="customer.session.value">
            购票账号：<strong>{{ customer.session.value.customer.maskedMobile }}</strong><br /><span>订单和发票归入此账号，每人分别领取电子票。</span>
          </p>
          <p v-else>验证购票人的手机号后，可以一次为多位参会人报名。</p>
          <button
            v-if="!customer.session.value"
            class="batch-button"
            type="button"
            @click="customer.openLogin"
          >
            登录 / 注册
          </button>
        </div>
        <label class="batch-self"><input
          type="checkbox"
          :checked="hasSelf"
          :disabled="locked || selfUnavailable"
          @change="
            setSelf(($event.target as HTMLInputElement).checked);
            ($event.target as HTMLInputElement).checked = hasSelf;
          "
        /><span>{{
          selfUnavailable ? '你已拥有本人参会名额，本次为他人购票' : '本次包含本人参会'
        }}</span></label>
        <div class="people-heading">
          <h3>参会人资料</h3>
          <span aria-live="polite">已完成 {{ completeCount }} / {{ quantity }} 位</span>
        </div>
        <article
          v-for="(card, index) in cards"
          :key="card.clientId"
          class="attendee-card"
          :class="{ 'has-errors': Object.keys(fieldErrors[card.clientId] ?? {}).length }"
          :data-card-id="card.clientId"
        >
          <header>
            <button
              class="attendee-heading"
              type="button"
              :aria-expanded="!collapsed.has(card.clientId)"
              :aria-controls="`fields-${card.clientId}`"
              @click="
                collapsed.has(card.clientId)
                  ? collapsed.delete(card.clientId)
                  : collapsed.add(card.clientId)
              "
            >
              <span class="person-number">{{ index + 1 }}</span><span><strong>{{ card.answers.name || `参会人 ${index + 1}`
              }}<small v-if="card.isSelf">本人</small></strong><span class="attendee-caption">{{ Object.keys(validateCard(card)).length ? '待完善资料' : '资料已填写'
              }}{{
                card.answers.mobile
                  ? ` · 尾号 ${normalizedRegistrationMobile(card.answers.mobile).slice(-4)}`
                  : ''
              }}</span></span><span class="fold-label">{{
                collapsed.has(card.clientId) ? '展开' : '收起'
              }}</span>
            </button><button
              v-if="cards.length > 1"
              class="text-button remove-person"
              type="button"
              :disabled="locked"
              :aria-label="`移除参会人 ${index + 1}`"
              @click="removeCard(card)"
            >
              移除
            </button>
          </header>
          <fieldset
            v-show="!collapsed.has(card.clientId)"
            :id="`fields-${card.clientId}`"
            class="batch-fieldset attendee-fields"
            :disabled="locked"
          >
            <legend class="sr-only">参会人 {{ index + 1 }} 的资料</legend>
            <button
              v-if="
                index > 0 &&
                  fields.some((field) => field.key === 'company') &&
                  cards[index - 1]?.answers.company &&
                  !card.answers.company
              "
              type="button"
              class="text-button copy-company"
              @click="copyCompany(index)"
            >
              沿用上一位的公司 / 机构
            </button>
            <div class="form-grid">
              <div v-for="field in fields" :key="field.key" class="form-field">
                <label :for="fieldId(card, field.key)">{{ field.label }}<em v-if="field.required">*</em></label>
                <select
                  v-if="field.type === 'select'"
                  :id="fieldId(card, field.key)"
                  v-model="card.answers[field.key]"
                  class="form-input"
                  :required="field.required"
                  :aria-invalid="Boolean(fieldErrors[card.clientId]?.[field.key])"
                  :aria-describedby="
                    fieldErrors[card.clientId]?.[field.key]
                      ? `${fieldId(card, field.key)}-error`
                      : undefined
                  "
                  @change="edit(card, field.key)"
                >
                  <option value="">{{ field.placeholder || `请选择${field.label}` }}</option>
                  <option v-for="option in field.options" :key="option" :value="option">
                    {{ option }}
                  </option>
                </select>
                <input
                  v-else
                  :id="fieldId(card, field.key)"
                  v-model="card.answers[field.key]"
                  class="form-input"
                  :type="field.type"
                  :inputmode="
                    field.type === 'tel' ? 'tel' : field.type === 'email' ? 'email' : 'text'
                  "
                  :required="field.required"
                  :readonly="card.isSelf && field.key === 'mobile'"
                  :autocomplete="
                    card.isSelf
                      ? (
                        {
                          name: 'name',
                          mobile: 'tel',
                          email: 'email',
                          company: 'organization',
                          title: 'organization-title',
                          city: 'address-level2',
                        } as Record<string, string>
                      )[field.key] || 'off'
                      : 'off'
                  "
                  :placeholder="field.placeholder || `请填写${field.label}`"
                  :aria-invalid="Boolean(fieldErrors[card.clientId]?.[field.key])"
                  :aria-describedby="
                    fieldErrors[card.clientId]?.[field.key]
                      ? `${fieldId(card, field.key)}-error`
                      : undefined
                  "
                  :maxlength="fieldMaximum(field.key)"
                  @input="edit(card, field.key)"
                />
                <p
                  v-if="fieldErrors[card.clientId]?.[field.key]"
                  :id="`${fieldId(card, field.key)}-error`"
                  class="field-error"
                >
                  {{ fieldErrors[card.clientId]?.[field.key] }}
                </p>
              </div>
            </div>
          </fieldset>
        </article>
        <div class="draft-actions">
          <p>
            {{
              storageUnavailable
                ? '浏览器暂不支持保存，刷新后将无法恢复本次填写。'
                : '资料仅在此浏览器保存 30 天，提交成功后清除。'
            }}
          </p>
          <button type="button" class="text-button" :disabled="locked" @click="clearDraft">
            清空草稿
          </button>
        </div>
        <div v-if="quoteNeedsConfirmation" class="batch-notice" role="alert">
          <strong>请核对更新后的报名信息</strong>
          <p>{{ quantity }} 位 · {{ money(unitPrice) }} / 人 · 合计 {{ money(total) }}</p>
          <p v-if="manualReview">本次报名需要整批审核，请确认后提交。</p>
          <button class="batch-button" type="button" @click="quoteNeedsConfirmation = false">
            我已核对当前金额和报名规则
          </button>
        </div>
        <label class="batch-agreement"><input
          id="batch-terms-accepted"
          v-model="termsAccepted"
          type="checkbox"
          :disabled="locked"
        /><span>我已阅读并同意
          <button type="button" class="text-button" @click.prevent="termsOpen = true">
            报名条款</button>（版本 {{ termsVersion }}）<template v-if="hasProxy">，并已获得所有代报名参会人的授权，可提交其资料和接收订单通知</template>。</span></label>
        <p v-if="blocked" class="batch-help" role="status">{{ blocked }}</p>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <p v-if="manualReview && !waiting" class="batch-help batch-review-note">
          {{
            total === 0
              ? '提交后将审核整批参会人资料，审核通过后统一出票。'
              : '提交后将审核整批参会人资料，审核通过后再统一支付。'
          }}
        </p>
        <div class="batch-submit">
          <div>
            <span>{{ waiting ? '本人候补' : `${quantity} 位参会人 · 统一支付` }}</span><strong>{{ waiting ? '待名额释放' : money(total) }}</strong>
          </div>
          <button
            class="flow-action"
            type="submit"
            :disabled="pending || !ready || completed || (!submittedInput && Boolean(blocked))"
          >
            {{
              pending
                ? '正在确认…'
                : submittedInput
                  ? '使用原资料重试'
                  : !customer.session.value
                    ? '登录后继续'
                    : waiting
                      ? '加入本人候补'
                      : manualReview
                        ? `提交 ${quantity} 位整批审核`
                        : total === 0
                          ? `确认 ${quantity} 位免费报名`
                          : `确认并支付 ${money(total)}`
            }}<span aria-hidden="true">→</span>
          </button>
        </div>
        <p v-if="submittedInput && !pending" class="batch-help">
          提交结果尚未确认，已暂时锁定本次资料。重试会核对原订单，避免重复购买。
        </p>
      </div>
    </form>
    <aside
      v-if="experience.registrationFlow.summaryCardEnabled"
      class="flow-card summary-card batch-summary"
    >
      <div class="summary-event">
        <div class="summary-event__label">本次报名</div>
        <h3>{{ event.name }}</h3>
        <p>{{ event.venue }} · {{ event.city }}</p>
      </div>
      <div class="summary-body">
        <div class="summary-row">
          <span>票种</span><strong>{{ ticket?.name }}</strong>
        </div>
        <div class="summary-row">
          <span>购买数量</span><strong>{{ quantity }} 个名额</strong>
        </div>
        <div class="summary-row">
          <span>单价 × 数量</span><strong>{{ money(unitPrice) }} × {{ quantity }}</strong>
        </div>
        <div class="summary-row is-total">
          <span>{{ quoteMatches ? '应付总额' : '预计总额' }}</span><strong>{{ money(total) }}</strong>
        </div>
        <p class="summary-note">
          {{
            quote?.manualReview
              ? '整批资料审核通过后，再统一支付。审核结果会显示在此订单中。'
              : total === 0
                ? '提交后为每位参会人分别签发电子票。'
                : '一次支付，分别出票。提交后为全部名额保留 15 分钟，请在有效期内完成支付。'
          }}
        </p>
        <p v-if="quoting" class="batch-help" role="status">正在核对金额和剩余额度…</p>
      </div>
    </aside>
    <RegistrationTermsDialog
      :open="termsOpen"
      :version="termsVersion"
      :content="event.registrationForm?.termsContent ?? ''"
      :event-name="event.name"
      @close="termsOpen = false"
    />
  </div>
</template>

<style scoped>
.batch-registration {
  align-items: start;
}
.batch-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.batch-first-title {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.quantity-section {
  margin-top: 28px;
  padding-block: 22px;
  border-block: 1px solid #e3e7ef;
}
.quantity-heading,
.quantity-controls,
.people-heading,
.inline-actions,
.batch-auth,
.draft-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.quantity-heading h3,
.people-heading h3 {
  margin: 0;
  color: #172033;
  font-size: 17px;
}
.quantity-heading > span,
.people-heading > span {
  color: #657080;
  font-size: 13px;
}
.quantity-controls {
  justify-content: flex-start;
  margin-top: 16px;
}
.quantity-stepper {
  display: grid;
  grid-template-columns: 44px 64px 44px;
  border: 1px solid #aebbc9;
  border-radius: 7px;
  overflow: hidden;
}
.quantity-stepper button,
.quantity-stepper input {
  min-width: 0;
  height: 44px;
  text-align: center;
  border: 0;
  background: #fff;
  font: inherit;
  color: #172033;
}
.quantity-stepper button {
  font-size: 22px;
  cursor: pointer;
  background: #f3f5f8;
}
.quantity-stepper input {
  appearance: textfield;
  -moz-appearance: textfield;
  font-weight: 750;
}
.quantity-stepper input::-webkit-inner-spin-button {
  appearance: none;
}
.quick-quantities {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.quick-quantities button,
.batch-button {
  min-height: 44px;
  padding: 9px 13px;
  border: 1px solid #c4ccd7;
  border-radius: 6px;
  background: #fff;
  color: #244d7c;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.quick-quantities button[aria-pressed='true'] {
  color: var(--conference-primary, #244d7c);
  background: #edf3fa;
  border-color: currentColor;
}
.batch-help,
.draft-actions p {
  color: #626f80;
  font-size: 12px;
  line-height: 1.7;
  margin: 12px 0 0;
}
.batch-notice,
.remove-selection {
  padding: 16px;
  margin: 18px 0;
  background: #eef3f8;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.7;
  color: #244d7c;
}
.batch-notice p {
  margin: 5px 0 10px;
}
.batch-notice a {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  font-weight: 700;
  text-decoration: underline;
}
.batch-auth {
  margin-top: 22px;
  font-size: 14px;
  line-height: 1.7;
}
.batch-auth p {
  margin: 0;
}
.batch-auth span {
  color: #657080;
  font-size: 12px;
}
.batch-self,
.batch-agreement {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 20px 0;
  line-height: 1.75;
  font-size: 14px;
}
.batch-self input,
.batch-agreement input,
.remove-selection input {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 4px;
  accent-color: var(--conference-primary, #244d7c);
}
.people-heading {
  margin: 26px 0 14px;
}
.attendee-card {
  margin-bottom: 16px;
  border: 1px solid #d8dfe8;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.attendee-card.has-errors {
  border-color: #bd4c41;
}
.attendee-card header {
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 8px;
  background: #f7f9fb;
}
.attendee-heading {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  padding: 12px 0;
  text-align: left;
  color: #172033;
}
.person-number {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 30px;
  height: 30px;
  background: #e7edf5;
  border-radius: 50%;
  color: #244d7c;
  font-size: 13px;
  font-weight: 750;
}
.attendee-heading > span:nth-child(2) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.attendee-heading strong {
  display: block;
  font-size: 15px;
}
.attendee-heading small {
  font-size: 11px;
  margin-left: 8px;
  color: #47688c;
  font-weight: 500;
}
.attendee-caption {
  display: block;
  font-size: 12px;
  color: #697586;
  margin-top: 4px;
}
.fold-label {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  color: #546b87;
}
.attendee-fields {
  padding: 18px;
}
.text-button {
  display: inline;
  min-height: 36px;
  padding: 4px 0;
  color: var(--conference-primary, #244d7c);
  text-decoration: underline;
  text-underline-offset: 3px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.remove-person {
  min-width: 40px;
  color: #78625f;
}
.copy-company {
  margin-bottom: 12px;
}
.field-error {
  margin: 5px 0 0;
  color: #a1352d;
  font-size: 12px;
  line-height: 1.6;
}
.form-input[aria-invalid='true'] {
  border-color: #ad453b;
}
.form-input[readonly] {
  background: #f3f5f8;
  color: #516073;
}
.draft-actions {
  align-items: baseline;
  margin-bottom: 20px;
}
.draft-actions p {
  margin: 0;
}
.batch-agreement {
  padding-top: 18px;
  border-top: 1px solid #e3e7ef;
  font-size: 13px;
}
.batch-agreement .text-button {
  min-height: 0;
  padding: 0;
}
.batch-submit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid #dfe5ed;
}
.batch-submit > div {
  display: grid;
  gap: 5px;
}
.batch-submit > div span {
  color: #697586;
  font-size: 12px;
}
.batch-submit > div strong {
  color: var(--conference-primary, #244d7c);
  font-size: 24px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.batch-submit .flow-action {
  flex-shrink: 0;
  min-height: 48px;
}
.remove-selection h3 {
  margin: 0;
  font-size: 16px;
}
.remove-selection > label {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
}
.remove-selection .inline-actions {
  margin-top: 12px;
  justify-content: flex-start;
}
.ticket-option__price small {
  color: #657080;
  font-size: 11px;
  font-weight: 500;
}
button:active {
  transform: translateY(1px);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
a:focus-visible {
  outline: 3px solid #82aada;
  outline-offset: 3px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 640px) {
  .attendee-card header {
    padding-inline: 12px;
  }
  .attendee-fields {
    padding: 16px 12px;
  }
  .attendee-heading {
    gap: 8px;
  }
  .batch-submit {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .batch-submit > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .batch-submit .flow-action {
    width: 100%;
    white-space: normal;
  }
  .batch-summary {
    display: none;
  }
  .quantity-stepper {
    grid-template-columns: 44px 52px 44px;
  }
  .quantity-controls {
    gap: 12px;
  }
}
</style>
