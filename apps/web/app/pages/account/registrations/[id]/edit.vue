<script setup lang="ts">
import { navigateTo } from '#app';
import { onBeforeUnmount, watch } from 'vue';
import {
  publicEventScopedPath,
  type CustomerRegistrationDetail,
  type UpdatePurchasedOrderAttendee,
} from '@conference/contracts';
import { useCustomerSession } from '~/composables/useCustomerSession';

const route = useRoute();
const customer = useCustomerSession();
const detail = ref<CustomerRegistrationDetail | null>(null);
const loading = ref(true);
const saving = ref(false);
const errorMessage = ref('');
const editingCustomerId = ref<number | null>(null);
const needsLogin = ref(false);
const checkingLatest = ref(false);
const canCheckLatest = ref(false);
const conflicts = ref<{ key: FieldKey; label: string; draft: string; latest: string }[]>([]);
const unavailableDraft = ref<{ label: string; value: string }[]>([]);
let pageActive = true;
let itemEditRequest: { fingerprint: string; key: string } | null = null;
onBeforeUnmount(() => {
  pageActive = false;
});
const fields = [
  { key: 'name', label: '参会人姓名', maxlength: 120, autocomplete: 'name' },
  { key: 'company', label: '公司', maxlength: 160, autocomplete: 'organization' },
  { key: 'email', label: '邮箱', maxlength: 254, autocomplete: 'email' },
  { key: 'title', label: '职位', maxlength: 100, autocomplete: 'organization-title' },
  { key: 'city', label: '城市', maxlength: 80, autocomplete: 'address-level2' },
] as const;
type FieldKey = (typeof fields)[number]['key'];
type AttendeePatch = Partial<Record<FieldKey, string>>;
const form = reactive({ name: '', company: '', email: '', title: '', city: '' });
function fieldIsEditable(current: CustomerRegistrationDetail | null, key: FieldKey) {
  return (
    !current?.canManageOrder ||
    !current.orderItemId ||
    current.registrationEditFields.some((rule) => rule.key === key && rule.enabled !== false)
  );
}
const editableFields = computed(() =>
  fields
    .filter((field) => fieldIsEditable(detail.value, field.key))
    .map((field) => ({
      ...field,
      rule: detail.value?.canManageOrder
        ? detail.value.registrationEditFields.find((rule) => rule.key === field.key)
        : undefined,
    })),
);
const detailHref = computed(() => {
  const path = `/account/registrations/${encodeURIComponent(String(route.params.id))}`;
  return detail.value ? publicEventScopedPath(path, detail.value.eventSlug) : path;
});
function stillOnEditor(customerId: number, registrationId: string) {
  return (
    pageActive &&
    String(route.params.id) === registrationId &&
    customer.session.value?.customer.id === customerId
  );
}
function normalizedValue(key: FieldKey, value: string) {
  const trimmed = value.trim();
  return key === 'email' ? trimmed.toLowerCase() : trimmed;
}
function draftPatch(current: CustomerRegistrationDetail): AttendeePatch {
  return Object.fromEntries(
    fields
      .filter(({ key }) => fieldIsEditable(current, key))
      .map(({ key }) => [key, form[key].trim()] as const)
      .filter(
        ([key, value]) =>
          normalizedValue(key, value) !== normalizedValue(key, current.attendee[key]),
      ),
  );
}
function patchIsSaved(latest: CustomerRegistrationDetail, patch: AttendeePatch) {
  return (
    Object.keys(patch).length > 0 &&
    fields.every(
      ({ key }) =>
        patch[key] === undefined ||
        normalizedValue(key, latest.attendee[key]) === normalizedValue(key, patch[key]!),
    )
  );
}
function showSaved(current: CustomerRegistrationDetail) {
  return navigateTo(
    publicEventScopedPath(
      `/account/registrations/${encodeURIComponent(current.id)}`,
      current.eventSlug,
      { updated: '1' },
    ),
  );
}
async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!pageActive) return;
    const session = customer.session.value;
    if (!session) {
      customer.openLogin();
      return;
    }
    const id = String(route.params.id);
    const loaded = await customer.registration(id);
    if (!stillOnEditor(session.customer.id, id)) return;
    detail.value = loaded;
    editingCustomerId.value = session.customer.id;
    for (const { key } of fields) form[key] = loaded.attendee[key];
  } catch (error) {
    if (!pageActive) return;
    const failure = error as { status?: number; statusCode?: number; data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '报名信息加载失败，请稍后重试。';
    if ((failure.statusCode ?? failure.status) === 401) customer.requestReauthentication();
  } finally {
    loading.value = false;
  }
}
async function checkLatest() {
  const current = detail.value;
  const customerId = customer.session.value?.customer.id;
  if (!current || !customerId || checkingLatest.value || saving.value) return;
  const patch = draftPatch(current);
  checkingLatest.value = true;
  try {
    const latest = await customer.registration(current.id);
    if (!stillOnEditor(customerId, current.id)) return;
    if (patchIsSaved(latest, patch)) {
      await showSaved(latest);
      return;
    }
    conflicts.value = [];
    unavailableDraft.value = [];
    for (const { key, label } of fields) {
      form[key] = latest.attendee[key];
      const draft = patch[key];
      if (draft === undefined) continue;
      if (!latest.canEditRegistrationInfo || !fieldIsEditable(latest, key)) {
        unavailableDraft.value.push({ label, value: draft });
        continue;
      }
      if (
        normalizedValue(key, latest.attendee[key]) !==
          normalizedValue(key, current.attendee[key]) &&
        normalizedValue(key, latest.attendee[key]) !== normalizedValue(key, draft)
      ) {
        conflicts.value.push({ key, label, draft, latest: latest.attendee[key] });
      } else form[key] = draft;
    }
    detail.value = latest;
    canCheckLatest.value = false;
    errorMessage.value = latest.canEditRegistrationInfo
      ? conflicts.value.length
        ? '报名信息有更新，请逐项核对后保存。'
        : '已读取最新报名信息，填写内容已保留，请核对后保存。'
      : '当前报名状态已变化，暂时无法继续修改。';
  } catch (error) {
    if (!stillOnEditor(customerId, current.id)) return;
    const failure = error as { status?: number; statusCode?: number; data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '最新信息读取失败，填写内容已保留，请稍后重试。';
    if ((failure.statusCode ?? failure.status) === 401) {
      needsLogin.value = true;
      customer.requestReauthentication();
    }
  } finally {
    checkingLatest.value = false;
  }
}
function resolveConflict(key: FieldKey, keepDraft: boolean) {
  const conflict = conflicts.value.find((field) => field.key === key);
  if (!conflict) return;
  form[key] = keepDraft ? conflict.draft : conflict.latest;
  conflicts.value = conflicts.value.filter((field) => field.key !== key);
}
async function save() {
  const current = detail.value;
  if (
    !current?.canEditRegistrationInfo ||
    !current.canManageOrder ||
    saving.value ||
    checkingLatest.value ||
    conflicts.value.length
  )
    return;
  const session = customer.session.value;
  if (!session) {
    customer.openLogin();
    return;
  }
  const customerId = session.customer.id;
  const patch = draftPatch(current);
  saving.value = true;
  errorMessage.value = '';
  canCheckLatest.value = false;
  try {
    if (!Object.keys(patch).length) {
      await navigateTo(detailHref.value);
      return;
    }
    const input: UpdatePurchasedOrderAttendee = {
      ...patch,
      expectedRegistrationVersion: current.registrationEditVersion ?? undefined,
    };
    if (current.orderItemId && !current.orderItemVersion) {
      canCheckLatest.value = true;
      errorMessage.value = '请先核对最新报名信息后保存。';
      return;
    }
    if (current.orderItemId) {
      const fingerprint = JSON.stringify({
        orderId: current.orderId,
        itemId: current.orderItemId,
        version: current.orderItemVersion,
        input,
      });
      if (itemEditRequest?.fingerprint !== fingerprint)
        itemEditRequest = { fingerprint, key: crypto.randomUUID() };
    }
    await customer.updatePurchasedOrderAttendee(
      current.orderId,
      input,
      current.orderItemId
        ? { id: current.orderItemId, version: current.orderItemVersion! }
        : undefined,
      itemEditRequest?.key,
    );
    if (stillOnEditor(customerId, current.id)) await showSaved(current);
  } catch (error) {
    if (!stillOnEditor(customerId, current.id)) return;
    const failure = error as {
      status?: number;
      statusCode?: number;
      data?: { message?: string; details?: { reason?: string } };
    };
    const status = failure.statusCode ?? failure.status;
    if (status === 401) {
      needsLogin.value = true;
      errorMessage.value = '登录已过期，填写内容已保留。请使用原手机号重新登录后保存。';
      customer.requestReauthentication();
    } else if (status === 403 && failure.data?.details?.reason === 'customer_csrf_invalid') {
      try {
        const refreshed = await customer.refresh(true);
        if (!pageActive || String(route.params.id) !== current.id) return;
        if (!refreshed) {
          needsLogin.value = true;
          customer.openLogin();
        } else if (refreshed.customer.id === customerId)
          errorMessage.value = '登录状态已更新，填写内容已保留，请再次保存。';
      } catch {
        if (stillOnEditor(customerId, current.id))
          errorMessage.value = '登录状态更新失败，填写内容已保留，请稍后再保存。';
      }
    } else if (!status || status >= 500) {
      try {
        const latest = await customer.registration(current.id);
        if (!stillOnEditor(customerId, current.id)) return;
        if (patchIsSaved(latest, patch)) {
          await showSaved(latest);
          return;
        }
      } catch {
        /* Keep the draft until the customer can read the persisted result. */
      }
      if (!stillOnEditor(customerId, current.id)) return;
      canCheckLatest.value = true;
      errorMessage.value = '暂时无法确认保存结果，填写内容已保留。请核对最新信息后继续。';
    } else {
      canCheckLatest.value = status === 409;
      errorMessage.value = failure.data?.message ?? '保存失败，填写内容已保留，请稍后重试。';
    }
  } finally {
    saving.value = false;
  }
}
onMounted(load);
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (!id || id === previous || loading.value) return;
    if (detail.value && id === editingCustomerId.value) {
      needsLogin.value = false;
      errorMessage.value = '登录已恢复，填写内容已保留，请确认后保存。';
    } else {
      detail.value = null;
      itemEditRequest = null;
      needsLogin.value = false;
      conflicts.value = [];
      unavailableDraft.value = [];
      canCheckLatest.value = false;
      for (const { key } of fields) form[key] = '';
      void load();
    }
  },
);
useHead({ title: '修改报名信息' });
</script>

<template>
  <div class="flow-page">
    <FlowHeader />
    <main id="main-content" class="registration-edit-shell">
      <NuxtLink class="edit-back" :to="detailHref">← 返回报名详情</NuxtLink>
      <section class="flow-card edit-card">
        <header>
          <p class="flow-eyebrow">REGISTRATION</p>
          <h1>修改报名信息</h1>
          <p>{{ detail?.eventName || '请核对本次报名的信息' }}</p>
        </header>
        <div v-if="loading" class="edit-state" role="status">正在加载原报名信息…</div>
        <div v-else-if="!customer.session.value && !detail" class="edit-state">
          <p>请使用购票时的手机号登录后修改。</p>
          <button class="flow-action" type="button" @click="customer.openLogin()">
            登录后修改
          </button>
        </div>
        <form
          v-else-if="detail?.canManageOrder && detail.canEditRegistrationInfo"
          @submit.prevent="save"
        >
          <p class="edit-help">修改后保存即可继续支付，当前票种与订单金额保持不变。</p>
          <div class="edit-fields">
            <label v-for="field in editableFields" :key="field.key" :for="`edit-${field.key}`">
              <span>
                {{ field.label }}
                <small v-if="field.rule?.required" aria-hidden="true">（必填）</small>
              </span>
              <select
                v-if="field.rule?.type === 'select'"
                :id="`edit-${field.key}`"
                v-model="form[field.key]"
                :aria-label="field.label"
                :required="field.rule.required"
                :disabled="saving || checkingLatest"
              >
                <option value="">请选择{{ field.label }}</option>
                <option v-for="option in field.rule.options" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
              <input
                v-else
                :id="`edit-${field.key}`"
                v-model="form[field.key]"
                :aria-label="field.label"
                :required="field.rule?.required"
                :type="field.rule?.type ?? (field.key === 'email' ? 'email' : 'text')"
                :maxlength="field.maxlength"
                :autocomplete="field.autocomplete"
                :disabled="saving || checkingLatest"
              />
            </label>
            <div class="edit-mobile">
              <span>手机号</span>
              <strong>{{ detail.attendee.mobile }}</strong>
              <small>手机号关联登录与参会身份，如需更换请联系主办方处理。</small>
            </div>
          </div>
          <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
          <button
            v-if="canCheckLatest"
            class="flow-action is-secondary"
            type="button"
            :disabled="checkingLatest || saving"
            @click="checkLatest"
          >
            {{ checkingLatest ? '正在核对…' : '核对最新信息' }}
          </button>
          <section v-if="conflicts.length" class="edit-conflicts" aria-label="核对报名更新">
            <p>
              当前票种：{{ detail.ticketTypeName }} · 订单金额：¥{{
                (detail.amount / 100).toFixed(2)
              }}
            </p>
            <div
              v-for="field in conflicts"
              :key="field.key"
              role="group"
              :aria-label="`核对${field.label}`"
            >
              <strong>{{ field.label }}有更新</strong>
              <dl>
                <dt>最新内容</dt>
                <dd>{{ field.latest || '未填写' }}</dd>
                <dt>我的修改</dt>
                <dd>{{ field.draft || '未填写' }}</dd>
              </dl>
              <button
                type="button"
                class="flow-action is-secondary"
                @click="resolveConflict(field.key, false)"
              >
                使用最新内容
              </button>
              <button
                type="button"
                class="flow-action is-secondary"
                @click="resolveConflict(field.key, true)"
              >
                保留我的修改
              </button>
            </div>
          </section>
          <div v-if="unavailableDraft.length" class="edit-conflicts">
            <p>以下字段当前已不开放修改，本次填写已保留，可复制后联系主办方：</p>
            <dl v-for="field in unavailableDraft" :key="field.label">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value || '未填写' }}</dd>
            </dl>
          </div>
          <footer>
            <button
              v-if="needsLogin"
              class="flow-action"
              type="button"
              @click="customer.openLogin()"
            >
              重新登录后保存
            </button>
            <button
              v-else
              class="flow-action"
              type="submit"
              :disabled="saving || checkingLatest || conflicts.length > 0"
            >
              {{ saving ? '正在保存…' : '保存修改' }}
            </button>
            <NuxtLink v-if="!saving" class="flow-action is-secondary" :to="detailHref">
              取消，返回详情
            </NuxtLink>
          </footer>
        </form>
        <div v-else class="edit-state">
          <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
          <p v-else>当前报名状态不支持在此修改。请返回报名详情查看，或联系主办方协助处理。</p>
          <div v-if="unavailableDraft.length" class="edit-conflicts">
            <p>你刚才填写的内容已保留在下方，可复制后联系主办方：</p>
            <dl v-for="field in unavailableDraft" :key="field.label">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value || '未填写' }}</dd>
            </dl>
          </div>
          <NuxtLink class="flow-action is-secondary" :to="detailHref">返回报名详情</NuxtLink>
          <button v-if="!detail" class="flow-action is-secondary" type="button" @click="load">
            重新加载
          </button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.registration-edit-shell {
  width: min(100% - 40px, 880px);
  margin-inline: auto;
  padding: 44px 0 80px;
}
.edit-back {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--conference-ink-muted);
  font-size: 13px;
}
.edit-card {
  margin-top: 18px;
}
.edit-card header {
  padding: 30px;
  border-bottom: 1px solid var(--conference-line);
}
.edit-card h1 {
  margin: 0;
  font-size: clamp(26px, 4vw, 34px);
  letter-spacing: -0.03em;
}
.edit-card header > p:last-child,
.edit-help {
  color: var(--conference-ink-muted);
  font-size: 14px;
  line-height: 1.7;
}
.edit-card form,
.edit-state {
  padding: 24px 30px 30px;
}
.edit-help {
  margin: 0 0 24px;
}
.edit-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
}
.edit-fields label,
.edit-mobile {
  display: grid;
  align-content: start;
  gap: 8px;
  font-size: 13px;
  color: var(--conference-ink-muted);
}
.edit-fields input,
.edit-fields select {
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--conference-line);
  border-radius: 6px;
  background: #fff;
  color: var(--conference-ink);
  font: inherit;
}
.edit-fields input:focus-visible,
.edit-fields select:focus-visible {
  outline: 2px solid var(--conference-primary);
  outline-offset: 2px;
}
.edit-mobile strong {
  color: var(--conference-ink);
  font-size: 14px;
}
.edit-mobile small {
  line-height: 1.6;
}
.edit-conflicts {
  margin-top: 20px;
  padding: 18px;
  border: 1px solid var(--conference-line);
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.7;
}
.edit-conflicts [role='group'] + [role='group'] {
  border-top: 1px solid var(--conference-line);
  margin-top: 18px;
  padding-top: 18px;
}
.edit-conflicts dt {
  color: var(--conference-ink-muted);
}
.edit-conflicts dd {
  margin: 0 0 10px;
  overflow-wrap: anywhere;
}
.edit-conflicts button {
  margin: 4px 8px 4px 0;
}
.edit-card footer {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}
.edit-card button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.edit-back:active {
  transform: scale(0.98);
}
@media (max-width: 640px) {
  .registration-edit-shell {
    width: calc(100% - 28px);
    padding-top: 24px;
  }
  .edit-card header,
  .edit-card form,
  .edit-state {
    padding: 24px 20px;
  }
  .edit-fields {
    grid-template-columns: 1fr;
  }
  .edit-card footer > * {
    width: 100%;
    justify-content: center;
  }
}
</style>
