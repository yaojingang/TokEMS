<script setup lang="ts">
import { nextTick, toRaw, watch } from 'vue';
import {
  publicEventScopedPath,
  type CustomerOrderDetail,
  type CustomerRefundApplication,
  type PurchasedOrderItem,
  type RefundApplicationView,
  type RefundContext,
  type RegistrationField,
  type UpdatePurchasedOrderAttendee,
} from '@conference/contracts';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  useBatchPurchase,
  batchErrorMessage,
  batchErrorStatus,
} from '~/composables/useBatchPurchase';
import { browserLocalStorage, browserSessionStorage } from '~/utils/browser-storage';
import {
  createRegistrationIntent,
  registrationIntentStorageKey,
  storedRegistrationIntent,
} from '~/utils/purchase-journey';
import { normalizedRegistrationMobile, writeBatchDraft } from '~/utils/batch-registration-draft';

const route = useRoute();
const router = useRouter();
const api = useConferenceApi();
const customer = useCustomerSession();
const batch = useBatchPurchase();
const orderId = computed(() => String(route.params.orderId));
const detail = ref<CustomerOrderDetail | null>(null);
const refund = ref<RefundContext | null>(null);
const loading = ref(true);
const pending = ref('');
const errorMessage = ref('');
const message = ref('');
const refundError = ref('');
const selectedRefund = ref<string[]>([]);
const selectedFree = ref<string[]>([]);
const refundReason = ref('');
const refundAcknowledged = ref(false);
const refundRequest = ref<{ key: string; input: CustomerRefundApplication } | null>(null);
const invitationLinks = ref<
  Record<string, { url: string; expiresAt: string; visibleUntil: number }>
>({});
const invitationRequests = new Map<
  string,
  { key: string; expectedVersion: number; notify: boolean }
>();
const editingItem = ref<PurchasedOrderItem | null>(null);
const editingAnswers = reactive<Record<string, string>>({});
const editingErrors = ref<Record<string, string>>({});
const editingConflicts = ref<string[]>([]);
const editingUnavailable = ref(false);
const editingRequest = ref<{
  key: string;
  version: number;
  input: UpdatePurchasedOrderAttendee;
} | null>(null);
const editableKeys = ['name', 'mobile', 'email', 'company', 'title', 'city'] as const;
const editingFields = computed<RegistrationField[]>(() => {
  const rules = editingItem.value?.registrationEditFields ?? [];
  return [
    ...rules.filter(
      (field) =>
        field.key !== 'mobile' &&
        editableKeys.includes(field.key as (typeof editableKeys)[number]) &&
        field.enabled !== false,
    ),
    { key: 'mobile', label: '手机号', type: 'tel', required: true },
  ];
});
let cancelRequest: { key: string; version: number } | null = null;
let pageActive = true;
let contextRevision = 0;
let loadSequence = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const activeRefund = computed(() =>
  refund.value?.applications.find(
    (application) =>
      ['pending_review', 'approved'].includes(application.reviewStatus) &&
      application.fulfillmentStatus !== 'completed',
  ),
);
const refundAmount = computed(
  () =>
    refund.value?.items.reduce(
      (amount, item) =>
        amount +
        (selectedRefund.value.includes(item.id) && item.eligible ? item.refundableAmount : 0),
      0,
    ) ?? 0,
);
const activeCount = computed(
  () => detail.value?.items.filter((item) => item.state === 'active').length ?? 0,
);
const canApplyRefund = computed(() =>
  Boolean(
    refund.value?.eligible &&
    !activeRefund.value &&
    selectedRefund.value.length &&
    refundAcknowledged.value,
  ),
);
const financialTotal = computed(() => detail.value?.order.amount ?? 0);
const canReadInvoice = computed(() =>
  Boolean(
    detail.value &&
    (detail.value.invoiceId ||
      (detail.value.order.amount > 0 &&
        ['paid', 'partially_refunded', 'refunded'].includes(detail.value.order.status))),
  ),
);
const heading = computed(() => {
  if (!detail.value) return '订单详情';
  return {
    review: '等待整批报名审核',
    payment: '名额已保留，等待统一支付',
    confirming: '支付结果确认中',
    complete: '报名与名额管理',
    closed: '订单已关闭',
  }[detail.value.nextAction];
});
const money = (amount: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: detail.value?.order.currency ?? 'CNY',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount / 100);
const date = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value))
    : '';
const eventPath = (path: string) =>
  detail.value ? publicEventScopedPath(path, detail.value.eventSlug) : path;
function participantData(item: PurchasedOrderItem) {
  const standardLabels: Record<string, string> = {
    mobile: '手机号',
    email: '邮箱',
    company: '公司 / 机构',
    title: '职位',
    city: '城市',
  };
  const historical = item.registrationFields ?? [];
  const keys = [
    ...new Set([...Object.keys(standardLabels), ...historical.map((field) => field.key)]),
  ];
  return keys
    .filter((key) => key !== 'name')
    .map((key) => ({
      key,
      label: historical.find((field) => field.key === key)?.label ?? standardLabels[key] ?? key,
      value:
        item.registration.formAnswers?.[key] ??
        (item.registration.attendee as Record<string, string>)[key] ??
        '',
    }))
    .filter((field) => field.value !== '');
}
useHead(() => ({
  title: `${heading.value} · ${detail.value?.eventName ?? '个人中心'}`,
  meta: [{ name: 'referrer', content: 'no-referrer' }],
}));

function requestGuard() {
  const revision = contextRevision;
  const owner = customer.session.value?.customer.id;
  const requestedOrder = orderId.value;
  return () =>
    pageActive &&
    contextRevision === revision &&
    customer.session.value?.customer.id === owner &&
    orderId.value === requestedOrder;
}
function validResponse(sequence: number, owner: number | undefined, requestedOrder: string) {
  return (
    pageActive &&
    sequence === loadSequence &&
    customer.session.value?.customer.id === owner &&
    requestedOrder === orderId.value
  );
}
async function refresh() {
  const sequence = ++loadSequence;
  const owner = customer.session.value?.customer.id;
  const requestedOrder = orderId.value;
  if (!owner) return;
  const next = await batch.detail(requestedOrder);
  if (!validResponse(sequence, owner, requestedOrder)) return;
  detail.value = next;
  for (const [itemId, link] of Object.entries(invitationLinks.value)) {
    const item = next.items.find((candidate) => candidate.id === itemId);
    if (!item?.canGenerateInvitation || link.visibleUntil <= Date.now())
      delete invitationLinks.value[itemId];
  }
  if (next.order.amount > 0) {
    try {
      const context = await customer.refundContext(requestedOrder);
      if (!validResponse(sequence, owner, requestedOrder)) return;
      refund.value = context;
      refundError.value = '';
      selectedRefund.value = selectedRefund.value.filter((id) =>
        context.items.some((item) => item.id === id && item.eligible),
      );
    } catch (error) {
      if (validResponse(sequence, owner, requestedOrder)) {
        refund.value = null;
        refundError.value = batchErrorMessage(error, '退款资格暂时无法读取，请刷新重试。');
      }
    }
  } else refund.value = null;
  selectedFree.value = selectedFree.value.filter((id) =>
    next.items.some((item) => item.id === id && item.canCancelFree),
  );
}
async function load() {
  const isCurrent = requestGuard();
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!isCurrent()) return;
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '订单读取失败，请确认登录的是购票账号。');
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

async function handleError(error: unknown, fallback: string) {
  const isCurrent = requestGuard();
  const owner = customer.session.value?.customer.id;
  const requestedOrder = orderId.value;
  errorMessage.value = batchErrorMessage(error, fallback);
  if (batchErrorStatus(error) === 401) {
    detail.value = null;
    refund.value = null;
    invitationLinks.value = {};
    await customer.refresh(true).catch(() => null);
    if (
      !pageActive ||
      orderId.value !== requestedOrder ||
      (customer.session.value && customer.session.value.customer.id !== owner)
    )
      return;
    customer.openLogin();
  }
  const reason = (error as { data?: { details?: { reason?: string } } }).data?.details?.reason;
  if (reason === 'customer_csrf_invalid') {
    await customer.refresh(true).catch(() => null);
    if (isCurrent()) errorMessage.value = '登录验证已更新，当前填写已保留，请重新操作。';
    return;
  }
  if (reason === 'reauthentication_required' || reason === 'recent_authentication_required')
    customer.requestReauthentication();
}
async function pay() {
  if (!detail.value || pending.value) return;
  pending.value = 'pay';
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    const access = await customer.createOrderPaymentAccess(orderId.value);
    if (!isCurrent()) return;
    const href = api.resolvePaymentCheckoutUrl(
      orderId.value,
      detail.value.eventSlug,
      access.orderAccessToken,
    );
    if (/^https?:\/\//i.test(href)) window.location.assign(href);
    else await router.push(href);
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '支付入口暂时不可用，请刷新订单状态。');
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

function normalizedEditValue(key: string, value: string) {
  return key === 'mobile'
    ? normalizedRegistrationMobile(value)
    : key === 'email'
      ? value.trim().toLowerCase()
      : value.trim();
}
function currentEditingValue(key: string) {
  return editingItem.value
    ? ((editingItem.value.registration.attendee as Record<string, string>)[key] ?? '')
    : '';
}
function openAttendeeEditor(item: PurchasedOrderItem) {
  if (!item.canEditAttendee || item.isSelf || item.attendeeClaimed || pending.value) return;
  if (editingItem.value && !window.confirm('结束当前名额编辑并打开另一位？尚未保存的修改会清除。'))
    return;
  editingItem.value = structuredClone(toRaw(item));
  for (const key of editableKeys) editingAnswers[key] = item.registration.attendee[key] ?? '';
  editingErrors.value = {};
  editingConflicts.value = [];
  editingUnavailable.value = false;
  editingRequest.value = null;
}
function closeAttendeeEditor() {
  if (pending.value) return;
  editingItem.value = null;
  for (const key of Object.keys(editingAnswers)) delete editingAnswers[key];
  editingRequest.value = null;
  editingErrors.value = {};
  editingConflicts.value = [];
}
function attendeePatch(): UpdatePurchasedOrderAttendee {
  const current = editingItem.value;
  if (!current) return {};
  return Object.fromEntries(
    editingFields.value
      .map((field) => [field.key, String(editingAnswers[field.key] ?? '').trim()] as const)
      .filter(
        ([key, value]) =>
          normalizedEditValue(key, value) !==
          normalizedEditValue(
            key,
            (current.registration.attendee as Record<string, string>)[key] ?? '',
          ),
      ),
  );
}
function reconcileAttendeeEditor() {
  const previous = editingItem.value;
  const latest = detail.value?.items.find((item) => item.id === previous?.id);
  if (!previous || !latest) return;
  if (!latest.canEditAttendee || latest.attendeeClaimed || latest.isSelf) {
    editingUnavailable.value = true;
    message.value = '该名额当前已无法修改。你的输入仍保留在下方，可核对后联系主办方。';
    return;
  }
  const conflicts: string[] = [];
  for (const key of editableKeys) {
    const oldValue = previous.registration.attendee[key] ?? '';
    const latestValue = latest.registration.attendee[key] ?? '';
    const mine = editingAnswers[key] ?? '';
    if (normalizedEditValue(key, mine) === normalizedEditValue(key, oldValue))
      editingAnswers[key] = latestValue;
    else if (
      normalizedEditValue(key, latestValue) !== normalizedEditValue(key, oldValue) &&
      normalizedEditValue(key, latestValue) !== normalizedEditValue(key, mine)
    )
      conflicts.push(key);
  }
  editingItem.value = structuredClone(toRaw(latest));
  editingConflicts.value = conflicts;
  message.value = conflicts.length
    ? '资料已在其他操作中更新，请逐项选择需要保留的内容。'
    : '已读取最新版本并保留本次修改，请核对后再次保存。';
}
function resolveEditConflict(key: string, source: 'current' | 'draft') {
  if (source === 'current' && editingItem.value)
    editingAnswers[key] =
      (editingItem.value.registration.attendee as Record<string, string>)[key] ?? '';
  editingConflicts.value = editingConflicts.value.filter((field) => field !== key);
}
async function saveAttendee() {
  const item = editingItem.value;
  if (!item || pending.value || editingUnavailable.value || editingConflicts.value.length) return;
  editingErrors.value = {};
  if (!editingRequest.value) {
    for (const field of editingFields.value) {
      const value = (editingAnswers[field.key] ?? '').trim();
      if (!value && field.required) editingErrors.value[field.key] = `请填写${field.label}`;
      else if (field.key === 'mobile' && !/^1\d{10}$/.test(normalizedRegistrationMobile(value)))
        editingErrors.value[field.key] = '请填写有效的中国大陆手机号';
      else if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        editingErrors.value[field.key] = '请填写有效的邮箱';
      else if (value && field.type === 'select' && !field.options?.includes(value))
        editingErrors.value[field.key] = '请选择本次报名允许的选项';
    }
    const firstError = Object.keys(editingErrors.value)[0];
    if (firstError) {
      await nextTick();
      document.getElementById(`item-edit-${item.id}-${firstError}`)?.focus();
      return;
    }
    const input = attendeePatch();
    if (!Object.keys(input).length) {
      message.value = '参会资料未发生变化。';
      return;
    }
    editingRequest.value = {
      key: crypto.randomUUID(),
      version: item.version,
      input: { ...input, expectedRegistrationVersion: item.registrationEditVersion },
    };
  }
  pending.value = 'edit';
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    const result = await batch.updateAttendee(
      orderId.value,
      item.id,
      editingRequest.value.version,
      editingRequest.value.input,
      editingRequest.value.key,
    );
    if (!isCurrent()) return;
    detail.value = result;
    delete invitationLinks.value[item.id];
    invitationRequests.delete(item.id);
    editingItem.value = null;
    editingRequest.value = null;
    for (const key of Object.keys(editingAnswers)) delete editingAnswers[key];
    message.value = '参会资料已保存。联系方式变化时，原邀请失效，请使用新的认领邀请。';
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '保存结果尚未确认，请使用相同修改重试。');
    if (!isCurrent()) return;
    const status = batchErrorStatus(error);
    if (status && status >= 400 && status < 500) editingRequest.value = null;
    if (status === 409) {
      await refresh().catch(() => undefined);
      if (!isCurrent()) return;
      reconcileAttendeeEditor();
    }
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function rebuildDraft(closed: CustomerOrderDetail) {
  const session = customer.session.value;
  if (!session || closed.nextAction !== 'closed') return;
  const owner = session.customer.id;
  const isCurrent = requestGuard();
  const event = await api.getEvent(closed.eventSlug);
  if (!isCurrent()) return;
  const intent = createRegistrationIntent();
  const scope = {
    organizationId: session.customer.organizationId,
    eventId: closed.eventId,
    ownerId: `customer:${owner}`,
    purchaseIntentId: intent,
  };
  const includesSelf = closed.items.some((item) => item.isSelf);
  const purchaseFor = includesSelf ? 'self' : 'other';
  storedRegistrationIntent(
    browserSessionStorage,
    registrationIntentStorageKey(scope.organizationId, scope.eventId, scope.ownerId, purchaseFor),
    intent,
  );
  const ticketTypeId = closed.items[0]?.registration.ticketType.id ?? event.tickets[0]?.id ?? '';
  const fields = event.registrationForm?.fields ?? [];
  writeBatchDraft(
    browserLocalStorage,
    scope,
    {
      formVersion: event.registrationForm?.version ?? 1,
      ticketTypeId,
      cards: closed.items.map((item) => ({
        clientId: item.clientId ?? crypto.randomUUID(),
        isSelf: item.isSelf,
        answers: Object.fromEntries(
          fields
            .filter((field) => field.enabled !== false)
            .map((field) => [
              field.key,
              String(
                item.registration.formAnswers?.[field.key] ??
                  (item.registration.attendee as Record<string, string>)[field.key] ??
                  '',
              ),
            ]),
        ),
        editedKeys: fields.filter((field) => field.enabled !== false).map((field) => field.key),
      })),
    },
    fields,
  );
  await router.push(
    publicEventScopedPath('/register', closed.eventSlug, {
      ticket: ticketTypeId,
      ...(purchaseFor === 'other' ? { purchaseFor } : {}),
    }),
  );
}
async function rebuild(closed: CustomerOrderDetail) {
  const isCurrent = requestGuard();
  if (pending.value && pending.value !== 'cancel') return;
  const previousPending = pending.value;
  pending.value = 'rebuild';
  try {
    await rebuildDraft(closed);
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '暂时无法带回报名资料，请稍后重试。');
  } finally {
    if (isCurrent()) pending.value = previousPending;
  }
}

async function cancel(restart: boolean) {
  if (!detail.value?.canCancel || pending.value) return;
  if (
    !cancelRequest &&
    !window.confirm(
      restart
        ? '取消整笔未支付订单，释放全部名额，并带回资料重新选择数量？'
        : '确认取消整笔未支付订单并释放全部名额？',
    )
  )
    return;
  cancelRequest ??= { key: crypto.randomUUID(), version: detail.value.order.version ?? 1 };
  pending.value = 'cancel';
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    const result = await batch.cancel(orderId.value, cancelRequest.version, cancelRequest.key);
    if (!isCurrent()) return;
    detail.value = result;
    cancelRequest = null;
    if (result.nextAction === 'closed') {
      message.value = '原订单已关闭，历史金额和订单号保留。';
      if (restart) await rebuild(result);
      if (!isCurrent()) return;
    } else message.value = '原订单状态已更新。请根据最新结果继续办理。';
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '关单结果暂未确认，请刷新原订单后重试。');
    if (!isCurrent()) return;
    await refresh().catch(() => undefined);
    if (!isCurrent()) return;
    if (
      detail.value?.nextAction === 'closed' ||
      ['complete', 'confirming'].includes(detail.value?.nextAction ?? '')
    )
      cancelRequest = null;
    else if ([400, 409].includes(batchErrorStatus(error) ?? 0)) cancelRequest = null;
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function cancelFree() {
  if (!detail.value || pending.value || !selectedFree.value.length) return;
  const selected = detail.value.items.filter(
    (item) => selectedFree.value.includes(item.id) && item.canCancelFree,
  );
  if (
    !selected.length ||
    !window.confirm(
      `确认取消 ${selected.length} 位免费参会名额？这些电子票将失效，其余名额继续有效。`,
    )
  )
    return;
  pending.value = 'free';
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    const result = await batch.cancelFree(
      orderId.value,
      {
        expectedVersion: detail.value.order.version ?? 1,
        items: selected.map((item) => ({ id: item.id, version: item.version })),
      },
      crypto.randomUUID(),
    );
    if (!isCurrent()) return;
    detail.value = result;
    selectedFree.value = [];
    message.value = `已取消 ${selected.length} 位免费名额，其余名额状态保持有效。`;
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '取消结果尚未确认，请刷新查看。');
    if (!isCurrent()) return;
    await refresh().catch(() => undefined);
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function submitRefund() {
  if (!refund.value || pending.value || (!refundRequest.value && !canApplyRefund.value)) return;
  refundRequest.value ??= {
    key: crypto.randomUUID(),
    input: {
      selectedItemIds: [...selectedRefund.value],
      contextVersion: refund.value.contextVersion,
      policyVersion: refund.value.policyVersion,
      reason: refundReason.value.trim(),
    },
  };
  pending.value = 'refund';
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    await customer.applyRefund(orderId.value, refundRequest.value.input, refundRequest.value.key);
    if (!isCurrent()) return;
    refundRequest.value = null;
    selectedRefund.value = [];
    refundAcknowledged.value = false;
    message.value = '退款申请已提交。审核期间所选票券仍可使用，审核通过后暂停所选名额。';
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '退款申请结果暂未确认，请刷新进度后重试。');
    if (!isCurrent()) return;
    await refresh().catch(() => undefined);
    if (!isCurrent()) return;
    if (activeRefund.value || [400, 409].includes(batchErrorStatus(error) ?? 0)) {
      refundRequest.value = null;
      refundAcknowledged.value = false;
    }
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function withdrawRefund(application: RefundApplicationView) {
  const isCurrent = requestGuard();
  if (pending.value || !window.confirm('确认撤回这次退款申请？')) return;
  pending.value = 'withdraw';
  try {
    await customer.withdrawRefund(application.id, application.version, crypto.randomUUID());
    if (!isCurrent()) return;
    message.value = '退款申请已撤回。';
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '撤回结果暂未确认，请刷新进度。');
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function invitation(item: PurchasedOrderItem, notify: boolean) {
  if (pending.value || !item.canGenerateInvitation) return;
  const previous = invitationRequests.get(item.id);
  if (
    !previous &&
    !window.confirm(
      notify
        ? `为 ${item.registration.attendee.name} 重新生成并补发邀请？此名额的旧邀请将失效。`
        : `为 ${item.registration.attendee.name} 重新生成认领链接？此名额的旧邀请将失效。`,
    )
  )
    return;
  const request = previous ?? { key: crypto.randomUUID(), expectedVersion: item.version, notify };
  invitationRequests.set(item.id, request);
  pending.value = item.id;
  errorMessage.value = '';
  const isCurrent = requestGuard();
  try {
    const result = await batch.invitation(
      orderId.value,
      item.id,
      { expectedVersion: request.expectedVersion, notify: request.notify },
      request.key,
    );
    if (!isCurrent()) return;
    if (result.claimUrl)
      invitationLinks.value[item.id] = {
        url: new URL(api.resolveConferenceUrl(result.claimUrl), window.location.origin).href,
        expiresAt: result.expiresAt,
        visibleUntil: Date.now() + 10 * 60_000,
      };
    else delete invitationLinks.value[item.id];
    message.value = result.claimUrl
      ? request.notify
        ? '新的认领邀请已安排补发，也可以复制链接交给本人。'
        : '已生成新的认领链接，请单独交给对应参会人。'
      : '该次邀请已处理，链接当前不可再次读取。请刷新后按可用操作重新生成。';
    invitationRequests.delete(item.id);
    await refresh();
  } catch (error) {
    if (!isCurrent()) return;
    await handleError(error, '邀请生成结果尚未确认，重试会核对同一次操作。');
    if (!isCurrent()) return;
    if ([400, 409, 429].includes(batchErrorStatus(error) ?? 0)) invitationRequests.delete(item.id);
  } finally {
    if (isCurrent()) pending.value = '';
  }
}

async function copyInvitation(itemId: string) {
  const isCurrent = requestGuard();
  const link = invitationLinks.value[itemId];
  if (!link || link.visibleUntil <= Date.now()) {
    delete invitationLinks.value[itemId];
    return;
  }
  try {
    await navigator.clipboard.writeText(link.url);
    if (!isCurrent()) return;
    message.value = '已复制认领链接，请仅发送给对应参会人。';
  } catch {
    if (!isCurrent()) return;
    message.value = '浏览器无法自动复制，请选中下方链接后复制。';
  }
}

function itemStatus(item: PurchasedOrderItem) {
  if (item.state === 'cancelled') return '名额已取消';
  if (item.ticketStatus === 'used') return '已核销';
  if (item.unavailableReason?.includes('退款')) return '退款处理中';
  if (item.state === 'pending') return detail.value?.nextAction === 'review' ? '待审核' : '待支付';
  return item.attendeeClaimed ? '已领取名额' : '待本人认领';
}
function refundStatus(application: RefundApplicationView) {
  if (application.reviewStatus === 'withdrawn') return '已撤回';
  if (application.reviewStatus === 'rejected') return '审核未通过';
  if (application.fulfillmentStatus === 'completed') return '退款完成';
  if (application.reviewStatus === 'pending_review') return '等待退款审核';
  return application.fulfillmentStatus === 'manual_required'
    ? '主办方正在处理'
    : '审核通过，退款处理中';
}
watch(
  () => [orderId.value, customer.session.value?.customer.id],
  (next, previous) => {
    if (next[0] === previous[0] && next[1] === previous[1]) return;
    loadSequence += 1;
    contextRevision += 1;
    pending.value = '';
    errorMessage.value = '';
    detail.value = null;
    refund.value = null;
    invitationLinks.value = {};
    invitationRequests.clear();
    editingItem.value = null;
    for (const key of Object.keys(editingAnswers)) delete editingAnswers[key];
    editingErrors.value = {};
    editingConflicts.value = [];
    editingRequest.value = null;
    selectedRefund.value = [];
    selectedFree.value = [];
    refundReason.value = '';
    refundAcknowledged.value = false;
    refundRequest.value = null;
    cancelRequest = null;
    message.value = '';
    if (next[1]) void load();
  },
  { flush: 'sync' },
);
onMounted(() => {
  void load();
  timer = setInterval(() => {
    for (const [id, link] of Object.entries(invitationLinks.value))
      if (link.visibleUntil <= Date.now()) delete invitationLinks.value[id];
    if (
      document.visibilityState === 'visible' &&
      customer.session.value &&
      !pending.value &&
      (['payment', 'confirming', 'review'].includes(detail.value?.nextAction ?? '') ||
        activeRefund.value)
    )
      void refresh().catch(() => undefined);
  }, 15_000);
});
onBeforeUnmount(() => {
  pageActive = false;
  loadSequence += 1;
  invitationLinks.value = {};
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="flow-page batch-order-page">
    <FlowHeader />
    <main id="main-content" class="batch-order-shell">
      <NuxtLink class="back-link" :to="eventPath('/account')">← 我的购买记录</NuxtLink>
      <header class="order-heading">
        <p class="flow-eyebrow">ORDER DETAILS</p>
        <h1>{{ heading }}</h1>
        <p v-if="detail">{{ detail.eventName }}</p>
      </header>
      <p v-if="loading" role="status">正在读取订单与名额…</p>
      <section v-else-if="!customer.session.value" class="order-surface">
        <h2>登录后查看订单</h2>
        <p>请使用购买这笔订单的账号登录。</p>
        <button type="button" class="primary-button" @click="customer.openLogin">
          登录个人中心
        </button>
      </section>
      <p v-if="errorMessage" class="notice error" role="alert">
        {{ errorMessage }}
        <button type="button" class="text-button" :disabled="Boolean(pending)" @click="load">
          刷新状态
        </button>
      </p>
      <p v-if="message" class="notice" role="status">{{ message }}</p>
      <template v-if="detail && customer.session.value">
        <section class="order-surface order-overview" aria-labelledby="order-number-title">
          <div>
            <p id="order-number-title" class="order-number">订单 {{ detail.order.orderNo }}</p>
            <h2>
              {{ detail.items[0]?.registration.ticketType.name }} · {{ detail.items.length }} 个名额
            </h2>
            <p>创建于 {{ date(detail.order.createdAt) }}</p>
            <p v-if="detail.nextAction === 'complete'">
              当前有效 {{ activeCount }} 位，已取消 {{ detail.items.length - activeCount }} 位。
            </p>
            <p v-else-if="detail.nextAction === 'review'">
              {{ detail.order.amount === 0 ? '整批资料一起审核，审核通过后统一出票。' : '整批资料一起审核。审核通过后，按原订单总额统一支付。' }}
            </p>
            <p v-else-if="detail.nextAction === 'payment'">
              支付截止 {{ date(detail.order.expiresAt) }}。如已付款，请进入支付页查询确认。
            </p>
            <p v-else-if="detail.nextAction === 'confirming'">
              系统正在确认原交易，请保留此订单并稍后刷新。
            </p>
            <p v-else>名额已释放。再次购买将使用新的订单和当前报名规则。</p>
          </div>
          <dl>
            <div>
              <dt>订单总额</dt>
              <dd>{{ money(financialTotal) }}</dd>
            </div>
            <div v-if="detail.refundedAmount">
              <dt>已退款</dt>
              <dd>{{ money(detail.refundedAmount) }}</dd>
            </div>
            <div>
              <dt>
                {{
                  ['payment', 'review'].includes(detail.nextAction)
                    ? '待付金额'
                    : detail.nextAction === 'complete'
                      ? '名额净额'
                      : '原订单金额'
                }}
              </dt>
              <dd class="total-amount">{{ money(financialTotal - detail.refundedAmount) }}</dd>
            </div>
          </dl>
          <div class="order-actions">
            <button
              v-if="detail.nextAction === 'payment'"
              class="primary-button"
              type="button"
              :disabled="Boolean(pending)"
              @click="pay"
            >
              {{
                pending === 'pay' ? '正在打开支付…' : `统一支付 ${money(detail.order.amount)}`
              }}
            </button><button
              v-if="detail.nextAction === 'confirming'"
              type="button"
              :disabled="Boolean(pending)"
              @click="load"
            >
              刷新支付结果
            </button><button
              v-if="detail.canCancel"
              type="button"
              :disabled="Boolean(pending)"
              @click="cancel(true)"
            >
              {{ pending === 'cancel' ? '正在核对并关闭…' : '取消原单并调整人数' }}
            </button><button
              v-if="detail.canCancel"
              type="button"
              class="text-button"
              :disabled="Boolean(pending)"
              @click="cancel(false)"
            >
              取消整笔订单
            </button><button
              v-if="detail.nextAction === 'closed'"
              type="button"
              :disabled="Boolean(pending)"
              @click="rebuild(detail)"
            >
              带回资料重新报名
            </button><NuxtLink
              v-if="canReadInvoice"
              :to="eventPath(`/account/invoices/${detail.order.id}`)"
            >
              {{ detail.invoiceId ? '查看发票' : '申请整单发票' }}
            </NuxtLink>
          </div>
        </section>
        <section class="order-surface" aria-labelledby="order-attendees-title">
          <div class="section-heading">
            <h2 id="order-attendees-title">参会人名单</h2>
            <span>{{ detail.items.length }} 位 · 每人独立电子票</span>
          </div>
          <p class="section-help">
            购票人可管理允许修改的资料。参会人使用对应手机号登录后，领取自己的电子票。
          </p>
          <article v-for="item in detail.items" :key="item.id" class="order-person">
            <header>
              <div class="person-title">
                <span class="person-index">{{ item.position }}</span>
                <h3>
                  {{ item.registration.attendee.name || '参会人' }}
                  <small v-if="item.isSelf">本人</small>
                </h3>
              </div>
              <span class="status" :class="{ ended: item.state === 'cancelled' }">{{
                itemStatus(item)
              }}</span>
            </header>
            <dl class="person-data">
              <div v-for="field in participantData(item)" :key="field.key">
                <dt>{{ field.label }}</dt>
                <dd>{{ field.value }}</dd>
              </div>
              <div>
                <dt>名额金额</dt>
                <dd>
                  {{ money(item.allocatedAmount)
                  }}<span v-if="item.refundedAmount"> · 已退 {{ money(item.refundedAmount) }}</span>
                </dd>
              </div>
            </dl>
            <p v-if="item.unavailableReason" class="section-help">{{ item.unavailableReason }}</p>
            <div class="person-actions">
              <NuxtLink
                v-if="item.isSelf && item.state === 'active'"
                :to="eventPath(`/account/registrations/${item.registrationId}`)"
              >
                查看本人电子票与参会服务
              </NuxtLink><NuxtLink
                v-if="item.canEditAttendee && item.isSelf"
                :to="eventPath(`/account/registrations/${item.registrationId}/edit`)"
              >
                修改参会资料
              </NuxtLink><button
                v-if="item.canEditAttendee && !item.isSelf && !item.attendeeClaimed"
                type="button"
                :disabled="Boolean(pending)"
                @click="openAttendeeEditor(item)"
              >
                修改参会资料
              </button><button
                v-if="item.canGenerateInvitation"
                type="button"
                :disabled="Boolean(pending)"
                @click="invitation(item, false)"
              >
                {{
                  pending === item.id
                    ? '正在处理…'
                    : invitationRequests.has(item.id)
                      ? '重试本次邀请'
                      : '重新生成认领链接'
                }}
              </button><button
                v-if="item.canGenerateInvitation"
                type="button"
                :disabled="Boolean(pending)"
                @click="invitation(item, true)"
              >
                补发邀请
              </button><label v-if="item.canCancelFree" class="select-seat"><input
                v-model="selectedFree"
                type="checkbox"
                :value="item.id"
                :disabled="Boolean(pending)"
              />选择取消此免费名额</label>
            </div>
            <form
              v-if="editingItem?.id === item.id"
              class="attendee-editor"
              @submit.prevent="saveAttendee"
            >
              <h4>修改 {{ item.registration.attendee.name }} 的资料</h4>
              <p>仅更新此名额。修改手机号或邮箱后，原认领邀请失效，系统生成新的邀请。</p>
              <p v-if="editingUnavailable" class="notice">
                该名额当前无法修改，以下保留本次填写。请联系主办方处理。
              </p>
              <fieldset
                :disabled="Boolean(pending) || Boolean(editingRequest) || editingUnavailable"
              >
                <legend class="sr-only">参会人资料编辑</legend>
                <div class="editor-fields">
                  <div v-for="field in editingFields" :key="field.key" class="editor-field">
                    <label :for="`item-edit-${item.id}-${field.key}`">{{ field.label }}<em v-if="field.required"> *</em></label>
                    <select
                      v-if="field.type === 'select'"
                      :id="`item-edit-${item.id}-${field.key}`"
                      v-model="editingAnswers[field.key]"
                      :required="field.required"
                      :aria-invalid="Boolean(editingErrors[field.key])"
                    >
                      <option value="">请选择{{ field.label }}</option>
                      <option v-for="option in field.options" :key="option" :value="option">
                        {{ option }}
                      </option>
                    </select>
                    <input
                      v-else
                      :id="`item-edit-${item.id}-${field.key}`"
                      v-model="editingAnswers[field.key]"
                      :type="field.type"
                      :required="field.required"
                      :maxlength="
                        (
                          {
                            name: 120,
                            mobile: 32,
                            email: 254,
                            company: 160,
                            title: 100,
                            city: 80,
                          } as Record<string, number>
                        )[field.key] ?? 2000
                      "
                      :aria-invalid="Boolean(editingErrors[field.key])"
                      autocomplete="off"
                    />
                    <p v-if="editingErrors[field.key]" class="editor-error">
                      {{ editingErrors[field.key] }}
                    </p>
                    <div
                      v-if="editingConflicts.includes(field.key)"
                      class="edit-conflict"
                      role="alert"
                    >
                      <p>
                        最新资料：{{ currentEditingValue(field.key) || '空白' }}<br />本次填写：{{
                          editingAnswers[field.key] || '空白'
                        }}
                      </p>
                      <div>
                        <button type="button" @click="resolveEditConflict(field.key, 'current')">
                          使用最新资料
                        </button><button type="button" @click="resolveEditConflict(field.key, 'draft')">
                          保留本次填写
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </fieldset>
              <div class="person-actions">
                <button
                  type="submit"
                  class="primary-button"
                  :disabled="
                    Boolean(pending) || editingUnavailable || Boolean(editingConflicts.length)
                  "
                >
                  {{
                    pending === 'edit'
                      ? '正在保存…'
                      : editingRequest
                        ? '核对并重试原修改'
                        : '保存此名额资料'
                  }}
                </button><button type="button" :disabled="Boolean(pending)" @click="closeAttendeeEditor">
                  结束编辑
                </button>
              </div>
            </form>
            <div v-if="invitationLinks[item.id]" class="invitation-result">
              <label :for="`invitation-${item.id}`">{{ item.registration.attendee.name }} 的认领链接</label>
              <div>
                <input
                  :id="`invitation-${item.id}`"
                  readonly
                  :value="invitationLinks[item.id]?.url"
                  autocomplete="off"
                  @focus="($event.target as HTMLInputElement).select()"
                /><button type="button" @click="copyInvitation(item.id)">复制链接</button>
              </div>
              <p>
                邀请有效至
                {{
                  date(invitationLinks[item.id]?.expiresAt)
                }}；此页暂时显示链接，刷新或离开后需重新获取。每位参会人的邀请单独使用。
              </p>
            </div>
          </article>
          <div
            v-if="detail.order.amount === 0 && detail.items.some((item) => item.canCancelFree)"
            class="selection-footer"
          >
            <p>已选择 {{ selectedFree.length }} 位，取消后仅所选电子票失效。</p>
            <button
              type="button"
              :disabled="Boolean(pending) || !selectedFree.length"
              @click="cancelFree"
            >
              取消所选 {{ selectedFree.length }} 位免费名额
            </button>
          </div>
        </section>
        <section
          v-if="detail.order.amount > 0"
          class="order-surface"
          aria-labelledby="order-refunds-title"
        >
          <h2 id="order-refunds-title">按名额申请退款</h2>
          <p v-if="refundError" class="notice error">
            {{ refundError }}
            <button class="text-button" type="button" @click="load">重新读取</button>
          </p>
          <template v-if="refund">
            <p class="section-help">
              申请金额按所选名额的可退金额汇总。退款退回原付款账户。{{
                refund.deadline ? `申请截止 ${date(refund.deadline)}。` : ''
              }}
            </p>
            <article
              v-for="application in refund.applications"
              :key="application.id"
              class="refund-history"
            >
              <div class="section-heading">
                <h3>{{ refundStatus(application) }}</h3>
                <strong>{{ money(application.amount) }}</strong>
              </div>
              <p>
                {{
                  application.selectedItemIds
                    .map(
                      (id) =>
                        detail?.items.find((item) => item.id === id)?.registration.attendee.name ||
                        '参会名额',
                    )
                    .join('、')
                }}
              </p>
              <p>
                提交于 {{ date(application.createdAt)
                }}<template v-if="application.completedAmount">
                  · 已确认退款 {{ money(application.completedAmount) }}
                </template>
              </p>
              <p v-if="application.reviewReason">处理说明：{{ application.reviewReason }}</p>
              <p
                v-if="
                  application.reviewStatus === 'approved' &&
                    application.fulfillmentStatus !== 'completed'
                "
              >
                所选名额已暂停，系统会继续处理退款。其余名额按各自状态使用。
              </p>
              <button
                v-if="application.reviewStatus === 'pending_review'"
                type="button"
                :disabled="Boolean(pending)"
                @click="withdrawRefund(application)"
              >
                撤回这次申请
              </button>
            </article>
            <form v-if="refund.eligible && !activeRefund" @submit.prevent="submitRefund">
              <fieldset
                :disabled="Boolean(pending) || Boolean(refundRequest)"
                class="refund-selection"
              >
                <legend>选择需要退票的参会人</legend>
                <label
                  v-for="item in refund.items"
                  :key="item.id"
                  :class="{ unavailable: !item.eligible }"
                ><input
                  v-model="selectedRefund"
                  type="checkbox"
                  :value="item.id"
                  :disabled="!item.eligible"
                /><span><strong>{{ item.name }}</strong><small>{{ item.blockedReason || '可申请退票' }}</small></span><strong>{{ money(item.refundableAmount) }}</strong></label><label class="reason-label">退款说明（选填）<textarea
                  v-model="refundReason"
                  rows="3"
                  maxlength="1000"
                  placeholder="可补充需要主办方了解的信息"
                /></label><label class="refund-ack"><input v-model="refundAcknowledged" type="checkbox" /><span>我已了解：审核期间所选票券仍可使用，使用后会影响退票审核；审核通过后所选名额暂停，退款完成后取消。</span></label>
              </fieldset>
              <div class="selection-footer">
                <p>
                  已选 {{ selectedRefund.length }} 位，申请退款
                  <strong>{{ money(refundAmount) }}</strong>
                </p>
                <button
                  class="primary-button"
                  type="submit"
                  :disabled="Boolean(pending) || (!refundRequest && !canApplyRefund)"
                >
                  {{
                    pending === 'refund'
                      ? '正在提交…'
                      : refundRequest
                        ? '核对并重试原申请'
                        : `提交 ${money(refundAmount)} 退款申请`
                  }}
                </button>
              </div>
            </form>
            <p v-else-if="!activeRefund" class="section-help">
              {{ refund.blockedReason }}
            </p>
          </template>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.batch-order-page {
  color: #172033;
}
.batch-order-shell {
  width: min(100% - 40px, 880px);
  margin-inline: auto;
  padding: 24px 0 80px;
}
.back-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: #536577;
  font-size: 14px;
  text-decoration: none;
}
.order-heading {
  margin: 20px 0 28px;
}
.order-heading h1 {
  margin: 10px 0;
  font-size: clamp(27px, 4.5vw, 38px);
  line-height: 1.25;
  letter-spacing: -0.02em;
}
.order-heading > p:last-child {
  color: #5e6977;
  line-height: 1.6;
}
.order-surface {
  margin-bottom: 22px;
  padding: 28px;
  border: 1px solid #dfe3e9;
  border-radius: 12px;
  background: #fff;
}
.order-surface h2 {
  margin: 0 0 12px;
  font-size: 21px;
  line-height: 1.5;
}
.order-surface p {
  line-height: 1.7;
  color: #5c6877;
}
.order-number {
  overflow-wrap: anywhere;
  font-size: 13px;
  margin: 0 0 12px;
}
.order-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.65fr);
  gap: 24px;
}
.order-overview > div > p {
  font-size: 13px;
}
.order-overview dl {
  margin: 0;
  align-self: start;
}
.order-overview dl > div {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 15px;
}
dt {
  color: #697586;
  font-size: 13px;
}
dd {
  margin: 0;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.order-overview dd {
  font-size: 18px;
  font-weight: 650;
}
.order-overview dd.total-amount {
  color: var(--conference-primary, #244d7c);
  font-size: 27px;
}
.order-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid #e4e8ef;
}
button,
.order-actions a,
.person-actions a {
  min-height: 44px;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  padding: 10px 14px;
  border: 1px solid #c0cad6;
  border-radius: 6px;
  background: #fff;
  color: #244d7c;
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  text-decoration: none;
  cursor: pointer;
}
button.primary-button {
  background: var(--conference-primary, #244d7c);
  border-color: transparent;
  color: #fff;
  font-weight: 650;
}
button.text-button {
  min-height: 36px;
  border: 0;
  background: transparent;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.section-heading > span {
  color: #697586;
  font-size: 12px;
}
.section-help {
  font-size: 13px;
}
.order-person {
  padding: 24px 0;
  border-top: 1px solid #e5e9ef;
}
.order-person:last-child {
  padding-bottom: 0;
}
.order-person > header,
.person-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.order-person > header {
  justify-content: space-between;
  flex-wrap: wrap;
}
.person-title {
  min-width: 0;
}
.person-title h3 {
  margin: 0;
  font-size: 17px;
  overflow-wrap: anywhere;
}
.person-title small {
  color: #627b96;
  font-size: 12px;
  font-weight: normal;
}
.person-index {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  flex-shrink: 0;
  background: #edf2f7;
  color: #244d7c;
  border-radius: 50%;
  font-size: 12px;
}
.status {
  padding: 4px 9px;
  color: #315a7b;
  background: #edf3f8;
  border-radius: 4px;
  font-size: 12px;
}
.status.ended {
  background: #f1f2f4;
  color: #6f7680;
}
.person-data {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 24px;
  margin: 18px 0;
}
.person-data dt {
  margin-bottom: 4px;
}
.person-data dd span {
  color: #727b88;
}
.person-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
}
.select-seat {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  font-size: 13px;
}
input[type='checkbox'] {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  accent-color: var(--conference-primary, #244d7c);
}
.attendee-editor {
  margin-top: 18px;
  padding: 18px;
  border: 1px solid #c8d3e1;
  border-radius: 7px;
  background: #f7f9fc;
}
.attendee-editor h4 {
  margin: 0;
  font-size: 16px;
}
.attendee-editor > p {
  margin: 10px 0 16px;
  font-size: 12px;
}
.attendee-editor fieldset {
  min-width: 0;
  margin: 0 0 18px;
  padding: 0;
  border: 0;
}
.editor-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.editor-field label {
  display: block;
  margin-bottom: 7px;
  font-size: 13px;
  font-weight: 650;
}
.editor-field em {
  color: #a33e34;
  font-style: normal;
}
.editor-field input,
.editor-field select {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px;
  border: 1px solid #b9c6d5;
  border-radius: 5px;
  background: #fff;
  color: #172033;
  font: inherit;
  font-size: 14px;
}
.editor-field [aria-invalid='true'] {
  border-color: #a33e34;
}
.editor-field p.editor-error {
  margin: 6px 0 0;
  color: #a33e34;
  font-size: 12px;
}
.edit-conflict {
  margin-top: 10px;
  padding: 12px;
  background: #fff3e3;
  border-radius: 5px;
}
.edit-conflict p {
  margin: 0 0 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.edit-conflict > div {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.invitation-result {
  margin-top: 16px;
  padding: 14px;
  background: #f2f6fa;
  border-radius: 6px;
  font-size: 12px;
}
.invitation-result > div {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.invitation-result input {
  flex: 1;
  min-width: 0;
  width: 0;
  border: 1px solid #c2ccda;
  border-radius: 5px;
  padding: 10px;
  font-size: 12px;
}
.invitation-result p {
  margin: 8px 0 0;
}
.selection-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 16px;
  margin-top: 16px;
  border-top: 1px solid #e4e8ef;
}
.selection-footer p {
  margin: 0;
  font-size: 14px;
}
.refund-history {
  padding: 20px 0;
  border-top: 1px solid #e3e8ef;
}
.refund-history h3 {
  margin: 0;
  font-size: 16px;
}
.refund-history p {
  margin: 8px 0;
  font-size: 13px;
}
.refund-selection {
  min-width: 0;
  margin: 24px 0 0;
  border: 0;
  padding: 0;
}
.refund-selection legend {
  padding: 0 0 12px;
  font-size: 16px;
  font-weight: 650;
}
.refund-selection > label {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 66px;
  border-top: 1px solid #e6eaf0;
  padding: 12px 0;
  font-size: 14px;
}
.refund-selection > label > span {
  flex: 1;
  min-width: 0;
}
.refund-selection > label > strong {
  flex-shrink: 0;
}
.refund-selection small {
  display: block;
  margin-top: 4px;
  color: #697586;
  font-size: 12px;
  line-height: 1.6;
}
.refund-selection .unavailable {
  color: #7a828e;
}
.refund-selection > label.reason-label {
  display: grid;
  gap: 10px;
  padding-top: 20px;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid #bbc7d4;
  border-radius: 6px;
  font: inherit;
  resize: vertical;
}
.refund-selection > label.refund-ack {
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.7;
}
.refund-ack input {
  margin-top: 3px;
}
.notice {
  padding: 16px;
  background: #edf3f8;
  border-radius: 6px;
  color: #244d7c;
  line-height: 1.7;
  font-size: 14px;
}
.notice.error {
  background: #fff0ee;
  color: #913c32;
}
button:active,
a:active {
  transform: translateY(1px);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 3px solid #82aada;
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .batch-order-shell {
    width: calc(100% - 24px);
    padding-top: 16px;
  }
  .order-surface {
    padding: 20px 16px;
  }
  .order-overview {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .order-overview dl {
    padding-top: 16px;
    border-top: 1px solid #e5e9ef;
  }
  .order-actions > .primary-button,
  .selection-footer > button {
    width: 100%;
  }
  .person-data {
    grid-template-columns: 1fr;
  }
  .editor-fields {
    grid-template-columns: 1fr;
  }
  .attendee-editor {
    padding: 16px 12px;
  }
  .person-actions {
    align-items: stretch;
  }
  .invitation-result > div {
    flex-direction: column;
  }
  .invitation-result input {
    width: 100%;
    min-height: 44px;
  }
}
</style>
