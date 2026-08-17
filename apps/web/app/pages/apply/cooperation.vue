<script setup lang="ts">
import {
  COOPERATION_TYPE_OPTIONS,
  CreateCooperationRequestSchema,
  publicEventHomePath,
  type CooperationType,
  type CreateCooperationRequest,
  type PublicCooperationRequestResult,
  type PublicEvent,
  type PublicSiteConfiguration,
} from '@conference/contracts';
import { createError, useAsyncData } from '#imports';
import { nextTick } from 'vue';

const api = useConferenceApi();
const route = useRoute();
const eventSlug = computed(() => {
  const value = Array.isArray(route.query.event) ? route.query.event[0] : route.query.event;
  return typeof value === 'string' ? value.trim() : '';
});
const { data: event, error: eventError } = await useAsyncData<PublicEvent>(
  () => `cooperation-event-${eventSlug.value || 'homepage'}`,
  () => (eventSlug.value ? api.getEvent(eventSlug.value) : api.getHomepageEvent()),
  { deep: false, watch: [eventSlug] },
);
const { data: siteConfiguration } = await useAsyncData<PublicSiteConfiguration>(
  'public-site-configuration',
  () => api.getSiteConfiguration(),
  { deep: false },
);
if (eventError.value || !event.value) {
  const failure = eventError.value as { statusCode?: number; status?: number } | null;
  throw createError({
    statusCode: failure?.statusCode ?? failure?.status ?? 503,
    statusMessage:
      (failure?.statusCode ?? failure?.status) === 404
        ? '大会不存在或尚未公开'
        : '大会合作申请暂时不可用',
  });
}

useHead(() => ({ title: `合作申请 · ${event.value?.name ?? '大会'}` }));

const form = reactive({
  cooperationTypes: [] as CooperationType[],
  companyName: '',
  contactName: '',
  contactTitle: '',
  mobile: '',
  email: '',
  wechatId: '',
  message: '',
  consentAccepted: false,
});
const fieldErrors = reactive<Record<string, string>>({});
const submitError = ref('');
const pending = ref(false);
const result = ref<PublicCooperationRequestResult | null>(null);
const requestKey = ref('');
const homeHref = computed(() => publicEventHomePath(event.value!.slug));
const privacyUrl = computed(() => siteConfiguration.value?.customerAccounts.privacyUrl ?? '');

function clearField(field: string) {
  delete fieldErrors[field];
  submitError.value = '';
}

function toggleDirection(direction: CooperationType) {
  const index = form.cooperationTypes.indexOf(direction);
  if (index >= 0) form.cooperationTypes.splice(index, 1);
  else if (form.cooperationTypes.length < 3) form.cooperationTypes.push(direction);
  clearField('cooperationTypes');
}

function validate(): CreateCooperationRequest | null {
  Object.keys(fieldErrors).forEach((key) => delete fieldErrors[key]);
  const parsed = CreateCooperationRequestSchema.safeParse({
    eventId: event.value!.id,
    ...form,
  });
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? 'form');
    fieldErrors[field] ||= issue.message;
  }
  return null;
}

function failureMessage(error: unknown) {
  const failure = error as {
    status?: number;
    statusCode?: number;
    data?: { message?: string };
  };
  const status = failure.statusCode ?? failure.status;
  if (status === 429) return '提交较频繁，请稍候一分钟再试。表单内容已为你保留。';
  return failure.data?.message ?? '提交暂时失败，请检查网络后重试。表单内容已为你保留。';
}

async function submit() {
  if (pending.value) return;
  const input = validate();
  if (!input) {
    submitError.value = '请检查标注的内容后再提交。';
    await nextTick();
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    return;
  }
  pending.value = true;
  submitError.value = '';
  requestKey.value ||= `cooperation-${crypto.randomUUID()}`;
  try {
    result.value = await api.createCooperationRequest(input, requestKey.value);
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  } catch (error) {
    submitError.value = failureMessage(error);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="conference-page cooperation-page">
    <nav id="nav" class="scrolled cooperation-nav" aria-label="合作申请页导航">
      <div class="nav-inner">
        <NuxtLink :to="homeHref" class="logo" aria-label="返回大会首页">
          <span class="logo-mark">G</span>
          <span>{{ event?.shortName || event?.name || '大会官网' }}</span>
          <span class="logo-sub">合作申请</span>
        </NuxtLink>
        <div class="nav-cta">
          <NuxtLink class="btn btn-outline cooperation-home-link" :to="homeHref">
            <span class="cooperation-home-link__desktop">返回大会首页</span>
            <span class="cooperation-home-link__mobile">首页</span>
          </NuxtLink>
          <CustomerAccountAction />
        </div>
      </div>
    </nav>

    <main
      v-if="result"
      id="main-content"
      class="flow-shell cooperation-success"
      aria-labelledby="success-title"
    >
      <section class="state-panel">
        <div class="state-icon" aria-hidden="true">✓</div>
        <p class="flow-eyebrow">REQUEST RECEIVED</p>
        <h1 id="success-title">合作想法已收到</h1>
        <p>{{ result.eventName }} 大会团队将根据你留下的联系方式推进沟通。请保留以下申请编号。</p>
        <dl class="cooperation-receipt">
          <div>
            <dt>申请编号</dt>
            <dd>{{ result.requestNo }}</dd>
          </div>
          <div>
            <dt>提交时间</dt>
            <dd>{{ new Date(result.submittedAt).toLocaleString('zh-CN') }}</dd>
          </div>
        </dl>
        <NuxtLink class="flow-action" :to="homeHref">返回大会首页</NuxtLink>
      </section>
    </main>

    <main v-else id="main-content" class="flow-shell cooperation-shell" tabindex="-1">
      <header class="cooperation-intro">
        <div>
          <p class="flow-eyebrow">PARTNERSHIP</p>
          <h1 class="flow-title">一起把好内容带到现场</h1>
          <p class="flow-lead">
            申请与
            {{ event?.name }}
            展开品牌、媒体、内容、社群或团队购票合作。先告诉我们你的设想，大会团队会据此安排后续沟通。
          </p>
        </div>
        <div class="cooperation-brief" aria-label="申请说明">
          <span>01</span>
          <p><strong>选择方向</strong>最多选择 3 项</p>
          <span>02</span>
          <p><strong>留下设想</strong>说明资源与合作目标</p>
          <span>03</span>
          <p><strong>团队跟进</strong>提交后进入大会后台</p>
        </div>
      </header>

      <form
        id="cooperation-form"
        class="flow-card cooperation-form"
        novalidate
        @submit.prevent="submit"
      >
        <div class="flow-card__head">
          <h2>合作申请</h2>
          <p><em>*</em> 为必填项。手机、邮箱、微信号至少填写一项。</p>
        </div>
        <div class="flow-card__body">
          <fieldset
            class="direction-fieldset"
            :aria-invalid="Boolean(fieldErrors.cooperationTypes)"
            :aria-describedby="fieldErrors.cooperationTypes ? 'cooperation-types-error' : undefined"
          >
            <legend>
              合作方向 <em>*</em><small>已选 {{ form.cooperationTypes.length }} / 3</small>
            </legend>
            <div class="direction-options">
              <label
                v-for="option in COOPERATION_TYPE_OPTIONS"
                :key="option.value"
                class="direction-option"
                :class="{ 'is-selected': form.cooperationTypes.includes(option.value) }"
              >
                <input
                  type="checkbox"
                  :checked="form.cooperationTypes.includes(option.value)"
                  :disabled="
                    !form.cooperationTypes.includes(option.value) &&
                      form.cooperationTypes.length >= 3
                  "
                  @change="toggleDirection(option.value)"
                />
                <span>{{ option.label }}</span>
              </label>
            </div>
            <p v-if="fieldErrors.cooperationTypes" id="cooperation-types-error" class="field-error">
              {{ fieldErrors.cooperationTypes }}
            </p>
          </fieldset>

          <h3 class="form-section-title">机构与联系人</h3>
          <div class="form-grid">
            <div class="form-field is-wide">
              <label for="companyName">公司或机构名称 <em>*</em></label>
              <input
                id="companyName"
                v-model="form.companyName"
                class="form-input"
                autocomplete="organization"
                maxlength="160"
                placeholder="例如：深圳湾数字商业中心"
                :aria-invalid="Boolean(fieldErrors.companyName)"
                @input="clearField('companyName')"
              />
              <p v-if="fieldErrors.companyName" class="field-error">
                {{ fieldErrors.companyName }}
              </p>
            </div>
            <div class="form-field">
              <label for="contactName">联系人 <em>*</em></label>
              <input
                id="contactName"
                v-model="form.contactName"
                class="form-input"
                autocomplete="name"
                maxlength="80"
                placeholder="请输入姓名"
                :aria-invalid="Boolean(fieldErrors.contactName)"
                @input="clearField('contactName')"
              />
              <p v-if="fieldErrors.contactName" class="field-error">
                {{ fieldErrors.contactName }}
              </p>
            </div>
            <div class="form-field">
              <label for="contactTitle">职位</label>
              <input
                id="contactTitle"
                v-model="form.contactTitle"
                class="form-input"
                autocomplete="organization-title"
                maxlength="80"
                placeholder="例如：品牌合作负责人"
                @input="clearField('contactTitle')"
              />
            </div>
          </div>

          <h3 class="form-section-title">联系方式</h3>
          <div class="form-grid">
            <div class="form-field">
              <label for="mobile">手机</label>
              <input
                id="mobile"
                v-model="form.mobile"
                class="form-input"
                type="tel"
                autocomplete="tel"
                inputmode="tel"
                placeholder="中国大陆手机号"
                :aria-invalid="Boolean(fieldErrors.mobile)"
                @input="clearField('mobile')"
              />
              <p v-if="fieldErrors.mobile" class="field-error">{{ fieldErrors.mobile }}</p>
            </div>
            <div class="form-field">
              <label for="email">邮箱</label>
              <input
                id="email"
                v-model="form.email"
                class="form-input"
                type="email"
                autocomplete="email"
                maxlength="255"
                placeholder="name@company.com"
                :aria-invalid="Boolean(fieldErrors.email)"
                @input="
                  clearField('email');
                  clearField('mobile');
                "
              />
              <p v-if="fieldErrors.email" class="field-error">{{ fieldErrors.email }}</p>
            </div>
            <div class="form-field is-wide">
              <label for="wechatId">微信号</label>
              <input
                id="wechatId"
                v-model="form.wechatId"
                class="form-input"
                maxlength="80"
                placeholder="便于大会团队添加联系"
                :aria-invalid="Boolean(fieldErrors.wechatId)"
                @input="
                  clearField('wechatId');
                  clearField('mobile');
                "
              />
              <p v-if="fieldErrors.wechatId" class="field-error">{{ fieldErrors.wechatId }}</p>
            </div>
          </div>

          <h3 class="form-section-title">合作设想</h3>
          <div class="form-field">
            <label for="message">简单介绍你的资源、目标或初步想法 <em>*</em></label>
            <textarea
              id="message"
              v-model="form.message"
              class="form-input cooperation-message"
              maxlength="1000"
              placeholder="例如：希望联合发布行业白皮书，并在大会现场设置品牌体验区……"
              :aria-invalid="Boolean(fieldErrors.message)"
              @input="clearField('message')"
            ></textarea>
            <span class="character-count">{{ form.message.length }} / 1000</span>
            <p v-if="fieldErrors.message" class="field-error">{{ fieldErrors.message }}</p>
          </div>

          <label class="cooperation-consent" :class="{ 'has-error': fieldErrors.consentAccepted }">
            <input
              v-model="form.consentAccepted"
              type="checkbox"
              :aria-invalid="Boolean(fieldErrors.consentAccepted)"
              @change="clearField('consentAccepted')"
            />
            <span>
              我同意大会团队为处理本次合作申请使用上述信息
              <a v-if="privacyUrl" :href="privacyUrl" target="_blank" rel="noopener noreferrer">查看隐私说明</a>
            </span>
          </label>
          <p v-if="fieldErrors.consentAccepted" class="field-error">请确认信息使用说明后提交</p>

          <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
          <div class="cooperation-actions">
            <button class="flow-action" type="submit" :disabled="pending">
              {{ pending ? '正在提交…' : '提交合作申请' }}
            </button>
            <NuxtLink class="cooperation-back" :to="homeHref">返回大会首页</NuxtLink>
          </div>
        </div>
      </form>
    </main>
  </div>
</template>

<style scoped>
.cooperation-page {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
}

.cooperation-nav {
  box-shadow: 0 1px 0 rgb(23 23 23 / 2%);
}

.cooperation-home-link__mobile {
  display: none;
}

.cooperation-shell {
  width: 100%;
  max-width: var(--max-w);
  padding: 132px var(--pad) 84px;
}

.cooperation-intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: start;
  gap: clamp(48px, 6vw, 80px);
  margin-bottom: 42px;
  padding-bottom: 42px;
  border-bottom: 1px solid var(--line);
}

.cooperation-intro .flow-title {
  max-width: 720px;
  font-size: clamp(36px, 4.2vw, 52px);
  line-height: 1.06;
}

.cooperation-intro .flow-lead {
  max-width: 720px;
  margin-top: 20px;
  font-size: 16px;
  line-height: 1.8;
}

.cooperation-brief {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 18px 14px;
  padding: 22px 0 0;
  border-top: 2px solid var(--accent);
}

.cooperation-brief > span {
  color: var(--accent);
  font-family: var(--conference-font-mono);
  font-size: 12px;
}

.cooperation-brief p {
  display: grid;
  gap: 3px;
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
  line-height: 1.55;
}

.cooperation-brief strong {
  color: var(--ink);
  font-size: 14px;
}

.cooperation-form {
  width: 100%;
  overflow: hidden;
  border-color: var(--line);
  border-radius: 0 0 var(--radius) var(--radius);
  box-shadow: var(--shadow);
}

.cooperation-form .flow-card__head {
  padding: 26px 32px 22px;
}

.cooperation-form .flow-card__body {
  padding: 32px;
}

.flow-card__head em,
.direction-fieldset em {
  color: var(--conference-red);
  font-style: normal;
}

.direction-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.direction-fieldset legend {
  width: 100%;
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 700;
}

.direction-fieldset legend small {
  float: right;
  color: var(--conference-ink-muted);
  font-weight: 500;
}

.direction-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.direction-option {
  position: relative;
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  padding: 0 15px;
  border: 1px solid #d4d4d8;
  border-radius: 999px;
  background: #fff;
  color: var(--conference-ink-soft);
  cursor: pointer;
  font-size: 13px;
  transition:
    border-color 140ms ease,
    background 140ms ease,
    color 140ms ease,
    transform 140ms ease;
}

.direction-option:active {
  transform: scale(0.98);
}

.direction-option.is-selected {
  border-color: var(--conference-primary);
  background: var(--conference-primary-soft);
  color: var(--conference-primary-dark);
  font-weight: 700;
}

.direction-option:has(input:focus-visible) {
  outline: 3px solid rgb(37 99 235 / 18%);
  outline-offset: 2px;
}

.direction-option:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.45;
}

.direction-option input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
}

.cooperation-message {
  min-height: 150px;
  resize: vertical;
  line-height: 1.7;
}

.character-count {
  justify-self: end;
  color: var(--conference-ink-muted);
  font-family: var(--conference-font-mono);
  font-size: 11px;
}

.field-error {
  margin: 0;
  color: #b91c1c;
  font-size: 12px;
  line-height: 1.5;
}

.form-input[aria-invalid='true'] {
  border-color: #ef4444;
}

.cooperation-consent {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 28px;
  color: var(--conference-ink-soft);
  font-size: 13px;
  line-height: 1.65;
}

.cooperation-consent input {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
  margin-top: 2px;
  accent-color: var(--conference-primary);
}

.cooperation-consent a {
  margin-left: 5px;
  color: var(--conference-primary);
}

.cooperation-actions {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 26px;
}

.cooperation-actions .flow-action:active {
  transform: scale(0.98);
}

.cooperation-back {
  color: var(--conference-ink-muted);
  font-size: 13px;
  text-underline-offset: 4px;
}

.cooperation-success {
  width: 100%;
  max-width: var(--max-w);
  padding: 148px var(--pad) 84px;
}

.cooperation-success .flow-eyebrow {
  justify-content: center;
}

.cooperation-receipt {
  max-width: 540px;
  margin: 0 auto 28px;
  border-top: 1px solid var(--conference-line);
  border-bottom: 1px solid var(--conference-line);
}

.cooperation-receipt > div {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 0;
}

.cooperation-receipt > div + div {
  border-top: 1px solid var(--conference-line);
}

.cooperation-receipt dt {
  color: var(--conference-ink-muted);
  font-size: 13px;
}

.cooperation-receipt dd {
  margin: 0;
  font-family: var(--conference-font-mono);
  font-size: 13px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .cooperation-intro {
    grid-template-columns: 1fr;
    gap: 30px;
  }

  .cooperation-brief {
    grid-template-columns: 34px minmax(0, 1fr) 34px minmax(0, 1fr) 34px minmax(0, 1fr);
    column-gap: 10px;
  }
}

@media (max-width: 640px) {
  .cooperation-shell {
    padding: 104px 20px 56px;
  }

  .cooperation-intro {
    gap: 26px;
    margin-bottom: 28px;
    padding-bottom: 30px;
  }

  .cooperation-intro .flow-title {
    font-size: clamp(28px, 8.5vw, 36px);
    line-height: 1.08;
    white-space: nowrap;
  }

  .cooperation-intro .flow-lead {
    margin-top: 16px;
    font-size: 15px;
    line-height: 1.75;
  }

  .cooperation-brief {
    grid-template-columns: 30px 1fr;
    gap: 14px 10px;
    padding-top: 18px;
  }

  .cooperation-brief > span,
  .cooperation-brief p {
    grid-row: auto;
  }

  .cooperation-form .flow-card__head,
  .cooperation-form .flow-card__body {
    padding: 22px 18px;
  }

  .direction-options {
    gap: 8px;
  }

  .direction-option {
    min-height: 40px;
    padding-inline: 13px;
  }

  .cooperation-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .cooperation-actions .flow-action {
    width: 100%;
  }

  .cooperation-back {
    text-align: center;
  }

  .cooperation-receipt > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }

  .cooperation-success {
    padding: 120px 20px 56px;
  }
}

@media (max-width: 420px) {
  .cooperation-home-link__desktop {
    display: none;
  }

  .cooperation-home-link__mobile {
    display: inline;
  }
}

@media (prefers-reduced-motion: reduce) {
  .direction-option,
  .cooperation-actions .flow-action {
    transition: none;
  }
}
</style>
