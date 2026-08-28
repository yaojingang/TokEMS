<script setup lang="ts">
import {
  ATTENDEE_NEED_CONSENT_VERSION,
  ATTENDEE_NEED_TOPIC_OPTIONS,
  UpdateAttendeeNeedsSchema,
  publicEventHomePath,
  publicEventScopedPath,
  type AttendeeNeedTagCode,
  type AttendeeNeedsProfile,
  type UpdateAttendeeNeeds,
} from '@conference/contracts';
import { nextTick, watch } from 'vue';
import { useCustomerSession } from '~/composables/useCustomerSession';
import {
  activeFlowStep,
  enabledFlowSteps,
  hasEnabledEventFlowStep,
  resolveEventExperience,
} from '~/composables/useEventExperience';

const route = useRoute();
const customer = useCustomerSession();
const conferenceApi = useConferenceApi();
const event = conferenceApi.eventState;
const registrationId = String(route.params.id);
const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const successDialogOpen = ref(false);
const savedResult = ref<AttendeeNeedsProfile | null>(null);
const saveButtonElement = ref<HTMLButtonElement>();
const fieldErrors = ref<Record<string, string>>({});
const profile = ref<AttendeeNeedsProfile | null>(null);

type EditableQuestion = {
  id?: string;
  content: string;
  tagCodes: AttendeeNeedTagCode[];
  adminEdited: boolean;
  adminEditReason: string | null;
  adminHidden: boolean;
  adminHiddenReason: string | null;
};

const form = reactive({
  questions: [] as EditableQuestion[],
  isPublic: true,
  isAnonymous: true,
  attributionName: '',
});

const flowSteps = computed(() =>
  enabledFlowSteps(event.value, {
    paymentRequired: true,
    invoiceRequired: false,
  }),
);
const activeStep = computed(() => activeFlowStep(flowSteps.value, 'attendee-needs'));
const attendeeNeedsFlowEnabled = computed(() =>
  hasEnabledEventFlowStep(event.value, 'attendee-needs'),
);
const accountHref = computed(() =>
  profile.value ? publicEventScopedPath('/account', profile.value.eventSlug) : '/account',
);
const ticketHref = computed(() =>
  profile.value?.ticketCode
    ? publicEventScopedPath(
        `/ticket/${encodeURIComponent(profile.value.ticketCode)}`,
        profile.value.eventSlug,
      )
    : publicEventScopedPath(
        `/account/registrations/${encodeURIComponent(registrationId)}`,
        profile.value?.eventSlug ?? String(route.query.event ?? ''),
      ),
);
const homeHref = computed(() => publicEventHomePath(profile.value?.eventSlug ?? ''));
const publicPreviewName = computed(() =>
  form.isAnonymous ? '匿名参会者' : form.attributionName.trim() || '请填写公开署名',
);

function syncForm(value: AttendeeNeedsProfile) {
  form.questions = value.questions.map((question) => ({
    ...(question.id ? { id: question.id } : {}),
    content: question.content,
    tagCodes: [...question.tagCodes],
    adminEdited: question.adminEdited,
    adminEditReason: question.adminEditReason,
    adminHidden: question.adminHidden,
    adminHiddenReason: question.adminHiddenReason,
  }));
  form.isPublic = value.isPublic;
  form.isAnonymous = value.isAnonymous;
  form.attributionName = value.attributionName ?? '';
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    await customer.refresh();
    if (!customer.session.value) {
      customer.openLogin();
      return;
    }
    let value: AttendeeNeedsProfile;
    try {
      value = await customer.attendeeNeeds(registrationId);
    } catch (error) {
      const checkout = conferenceApi.readCheckout();
      if (
        checkout?.registration.id !== registrationId ||
        !checkout.orderAccessToken ||
        !checkout.order.id
      ) {
        throw error;
      }
      await customer.claimRegistration(checkout.order.id, checkout.orderAccessToken);
      value = await customer.attendeeNeeds(registrationId);
    }
    profile.value = value;
    syncForm(value);
    event.value = await conferenceApi.getEvent(value.eventSlug);
  } catch (error) {
    const failure = error as { data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '参会需求暂时无法加载';
  } finally {
    loading.value = false;
  }
}

function addQuestion() {
  if (form.questions.length >= 3) return;
  form.questions.push({
    content: '',
    tagCodes: [],
    adminEdited: false,
    adminEditReason: null,
    adminHidden: false,
    adminHiddenReason: null,
  });
}

function removeQuestion(index: number) {
  if (form.questions.length === 1) {
    void deleteAll();
    return;
  }
  form.questions.splice(index, 1);
  fieldErrors.value = {};
}

function toggleTag(question: EditableQuestion, code: AttendeeNeedTagCode) {
  const selected = question.tagCodes.includes(code);
  if (selected) {
    question.tagCodes = question.tagCodes.filter((item) => item !== code);
    return;
  }
  if (question.tagCodes.length < 3) question.tagCodes.push(code);
}

function inputPayload(): UpdateAttendeeNeeds | null {
  const parsed = UpdateAttendeeNeedsSchema.safeParse({
    version: profile.value?.version ?? 0,
    questions: form.questions.map((question) => ({
      ...(question.id ? { id: question.id } : {}),
      content: question.content,
      tagCodes: question.tagCodes,
    })),
    isPublic: form.isPublic,
    isAnonymous: form.isAnonymous,
    attributionName: form.attributionName || null,
    consentVersion: ATTENDEE_NEED_CONSENT_VERSION,
  });
  if (parsed.success) return parsed.data;
  fieldErrors.value = Object.fromEntries(
    parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
  errorMessage.value = '请先完善标记出的内容';
  return null;
}

async function save() {
  const input = inputPayload();
  if (!input) return;
  saving.value = true;
  errorMessage.value = '';
  successMessage.value = '';
  try {
    const value = await customer.updateAttendeeNeeds(registrationId, input);
    profile.value = value;
    syncForm(value);
    fieldErrors.value = {};
    savedResult.value = value;
    successDialogOpen.value = true;
  } catch (error) {
    const failure = error as { data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '保存失败，请稍后重试';
  } finally {
    saving.value = false;
  }
}

async function closeSuccessDialog() {
  successDialogOpen.value = false;
  await nextTick();
  saveButtonElement.value?.focus();
}

async function deleteAll() {
  if (!profile.value?.id) {
    form.questions = [
      {
        content: '',
        tagCodes: [],
        adminEdited: false,
        adminEditReason: null,
        adminHidden: false,
        adminHiddenReason: null,
      },
    ];
    return;
  }
  if (!window.confirm('确认删除全部参会需求？删除后大会首页将停止展示。')) return;
  deleting.value = true;
  errorMessage.value = '';
  try {
    const value = await customer.deleteAttendeeNeeds(registrationId, profile.value.version);
    profile.value = value;
    syncForm(value);
    successMessage.value = '参会需求已删除';
  } catch (error) {
    const failure = error as { data?: { message?: string } };
    errorMessage.value = failure.data?.message ?? '删除失败，请刷新后重试';
  } finally {
    deleting.value = false;
  }
}

onMounted(load);
watch(
  () => customer.session.value?.customer.id,
  (id, previous) => {
    if (id && id !== previous && !profile.value) void load();
  },
);

useHead(() => ({
  title: `提交参会需求${profile.value ? ` · ${profile.value.eventName}` : ''}`,
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
}));
</script>

<template>
  <div class="flow-page needs-page">
    <FlowHeader />
    <main id="main-content" class="needs-shell">
      <header class="needs-intro">
        <p class="flow-eyebrow">STEP 06 · ATTENDEE QUESTIONS</p>
        <h1>你希望这次大会，帮你解决什么问题？</h1>
        <p>请写下你最关心的问题。大会团队会按主题整理给相关嘉宾，帮助他们调整分享重点和案例。</p>
      </header>

      <FlowStepper
        v-if="profile && attendeeNeedsFlowEnabled"
        class="needs-stepper"
        :active="activeStep"
        :payment-required="true"
        :steps="flowSteps.map((step) => step.title)"
        :variant="resolveEventExperience(event).registrationFlow.progressVariant"
      />

      <p v-if="loading" class="needs-state">正在准备参会需求表单…</p>
      <p v-else-if="errorMessage && !profile" class="needs-state is-error" role="alert">
        {{ errorMessage }}
      </p>

      <section v-else-if="profile && !profile.id && !profile.canCreate" class="needs-state">
        <h2>
          {{ profile.featureEnabled ? '当前报名暂不能提交参会需求' : '参会需求收集暂未开放' }}
        </h2>
        <p>
          {{
            profile.featureEnabled
              ? profile.qualificationReason || '完成报名并取得有效电子票后即可填写。'
              : '大会团队启用后，你可以从报名完成页或个人中心进入填写。'
          }}
        </p>
        <NuxtLink class="secondary-action" :to="ticketHref">先查看电子票</NuxtLink>
      </section>

      <template v-else-if="profile">
        <form class="needs-editor" novalidate @submit.prevent="save">
          <section class="question-section" aria-labelledby="questions-title">
            <div class="section-heading">
              <div>
                <span>01 / QUESTIONS</span>
                <h2 id="questions-title">最关心的问题</h2>
              </div>
              <strong>{{ form.questions.length }} / 3</strong>
            </div>

            <p v-if="profile.adminRemovedCount > 0" class="moderation-note removed-note">
              有 {{ profile.adminRemovedCount }} 个问题已被大会团队移除，你可以新建替代问题。
            </p>

            <article
              v-for="(question, index) in form.questions"
              :key="question.id ?? `new-${index}`"
              class="question-editor"
            >
              <div class="question-index">
                <span>Q.{{ String(index + 1).padStart(2, '0') }}</span>
                <button type="button" class="quiet-action" @click="removeQuestion(index)">
                  {{ form.questions.length === 1 ? '删除全部' : '删除此题' }}
                </button>
              </div>
              <label :for="`attendee-question-${index}`">你的问题</label>
              <textarea
                :id="`attendee-question-${index}`"
                v-model="question.content"
                rows="4"
                placeholder="例如：企业内部应该由哪个部门牵头 GEO，第一阶段如何确定目标？"
                :aria-invalid="Boolean(fieldErrors[`questions.${index}.content`])"
                :aria-errormessage="
                  fieldErrors[`questions.${index}.content`]
                    ? `attendee-question-${index}-error`
                    : undefined
                "
              />
              <div class="question-meta">
                <span>{{ Array.from(question.content.trim()).length }} / 200</span>
                <span>建议用一个完整问句描述</span>
              </div>
              <p
                v-if="fieldErrors[`questions.${index}.content`]"
                :id="`attendee-question-${index}-error`"
                class="field-error"
              >
                {{ fieldErrors[`questions.${index}.content`] }}
              </p>

              <fieldset
                :aria-describedby="
                  fieldErrors[`questions.${index}.tagCodes`]
                    ? `attendee-question-${index}-tags-error`
                    : undefined
                "
              >
                <legend>选择 1 至 3 个相关主题</legend>
                <div class="topic-grid">
                  <label
                    v-for="topic in ATTENDEE_NEED_TOPIC_OPTIONS"
                    :key="topic.code"
                    :class="{ selected: question.tagCodes.includes(topic.code) }"
                  >
                    <input
                      type="checkbox"
                      :checked="question.tagCodes.includes(topic.code)"
                      :disabled="
                        !question.tagCodes.includes(topic.code) && question.tagCodes.length >= 3
                      "
                      @change="toggleTag(question, topic.code)"
                    />
                    {{ topic.label }}
                  </label>
                </div>
              </fieldset>
              <p
                v-if="fieldErrors[`questions.${index}.tagCodes`]"
                :id="`attendee-question-${index}-tags-error`"
                class="field-error"
              >
                {{ fieldErrors[`questions.${index}.tagCodes`] }}
              </p>
              <p v-if="question.adminEdited" class="moderation-note">
                大会团队调整了公开内容：{{ question.adminEditReason || '请联系组委会了解详情' }}
              </p>
              <p v-if="question.adminHidden" class="moderation-note">
                此问题当前未公开：{{ question.adminHiddenReason || '请联系组委会了解详情' }}
              </p>
            </article>

            <button
              v-if="form.questions.length < 3"
              type="button"
              class="add-question"
              @click="addQuestion"
            >
              <span aria-hidden="true">＋</span> 增加一个问题
            </button>
          </section>

          <section class="privacy-section" aria-labelledby="privacy-title">
            <div class="section-heading">
              <div>
                <span>02 / PRIVACY</span>
                <h2 id="privacy-title">公开方式</h2>
              </div>
            </div>
            <label class="choice-row">
              <input v-model="form.isPublic" type="checkbox" />
              <span>
                <strong>允许在大会首页展示这些问题</strong>
                <small>保存后生效，可随时关闭、修改或删除。</small>
              </span>
            </label>
            <label class="choice-row" :class="{ disabled: !form.isPublic }">
              <input
                v-model="form.isAnonymous"
                type="checkbox"
                :disabled="!form.isPublic || profile?.adminForcedAnonymous"
              />
              <span>
                <strong>匿名展示</strong>
                <small>首页显示“匿名参会者”，组委会仍可确认报名归属。</small>
              </span>
            </label>
            <p v-if="profile?.adminForcedAnonymous" class="moderation-note">
              大会团队已将公开方式设为匿名：{{
                profile.adminForcedAnonymousReason || '请联系组委会了解详情'
              }}
            </p>
            <p v-if="form.isPublic" class="consent-note">
              公开后，问题和所选标签会出现在大会首页。匿名状态下，首页只显示“匿名参会者”；大会组委会仍能在后台确认报名归属，用于内容整理和必要的运营处理。
            </p>
            <label v-if="form.isPublic && !form.isAnonymous" class="attribution-field">
              <span>公开署名</span>
              <input v-model="form.attributionName" autocomplete="name" readonly />
              <small>
                公开署名使用当前报名姓名；如需修改，请先更新报名资料 ·
                {{ Array.from(form.attributionName.trim()).length }} / 120
              </small>
              <em v-if="fieldErrors.attributionName" class="field-error">
                {{ fieldErrors.attributionName }}
              </em>
            </label>

            <div v-if="form.isPublic" class="public-preview">
              <span>首页展示预览</span>
              <strong>{{ publicPreviewName }}</strong>
              <p>{{ form.questions[0]?.content.trim() || '你的问题会显示在这里' }}</p>
            </div>
            <p v-if="form.isPublic && !profile.canPublish && profile.id" class="qualification-note">
              当前无法公开展示：{{ profile.qualificationReason }}。已有内容仍可保持私有或删除。
            </p>
          </section>

          <p v-if="errorMessage" class="form-message is-error" role="alert">{{ errorMessage }}</p>
          <p v-if="successMessage" class="form-message is-success" role="status">
            {{ successMessage }}
          </p>

          <div class="needs-actions">
            <button
              ref="saveButtonElement"
              type="submit"
              class="primary-action"
              :disabled="saving || deleting"
            >
              {{ saving ? '正在保存…' : '保存参会需求' }}
            </button>
            <NuxtLink class="secondary-action" :to="ticketHref">稍后填写，先看电子票</NuxtLink>
            <NuxtLink class="secondary-action" :to="accountHref">返回个人中心</NuxtLink>
            <a class="text-action" :href="homeHref">返回大会首页</a>
          </div>
        </form>

        <AttendeeNeedsSuccessDialog
          v-if="savedResult"
          :open="successDialogOpen"
          :question-count="
            savedResult.questions.filter((question) => question.content.trim()).length
          "
          :is-public="savedResult.isPublic"
          :effective-public="savedResult.effectivePublic"
          :is-anonymous="savedResult.isAnonymous"
          :attribution-name="savedResult.attributionName"
          :home-href="homeHref"
          @close="closeSuccessDialog"
        />
      </template>
    </main>
  </div>
</template>

<style scoped>
.needs-page {
  min-height: 100vh;
  background: #f4f7fb;
  color: #12213d;
}

.needs-shell {
  width: min(980px, calc(100% - 40px));
  margin: 0 auto;
  padding: 72px 0 96px;
}

.needs-intro {
  width: 100%;
}

.needs-intro h1 {
  margin: 12px 0 18px;
  font-size: clamp(34px, 5vw, 58px);
  line-height: 1.08;
  letter-spacing: -0.045em;
}

.needs-intro > p:last-child {
  max-width: 760px;
  margin: 0;
  color: #5b6980;
  font-size: 17px;
  line-height: 1.8;
}

.needs-stepper {
  margin: 38px 0;
}

.needs-state {
  padding: 72px 0;
  color: #66738a;
}

.needs-editor {
  display: grid;
  gap: 24px;
}

.question-section,
.privacy-section {
  padding: 34px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(18 33 61 / 12%);
  border-radius: 16px;
}

.section-heading,
.question-index {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.section-heading {
  padding-bottom: 24px;
  border-bottom: 1px solid #e2e8f1;
}

.section-heading span,
.question-index > span,
.public-preview > span {
  color: #356be8;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.section-heading h2 {
  margin: 5px 0 0;
  font-size: 25px;
}

.section-heading > strong {
  color: #68758b;
  font-variant-numeric: tabular-nums;
}

.question-editor {
  padding: 30px 0;
  border-bottom: 1px solid #e2e8f1;
}

.question-editor > label,
.question-editor legend,
.attribution-field > span {
  display: block;
  margin: 18px 0 10px;
  color: #253551;
  font-size: 14px;
  font-weight: 750;
}

.question-editor textarea,
.attribution-field input {
  width: 100%;
  border: 1px solid #cdd6e5;
  border-radius: 10px;
  background: #fbfcfe;
  color: #12213d;
  font: inherit;
  line-height: 1.75;
  outline: none;
}

.question-editor textarea {
  min-height: 132px;
  padding: 16px;
  resize: vertical;
}

.attribution-field input {
  height: 46px;
  padding: 0 14px;
}

.question-editor textarea:focus,
.attribution-field input:focus {
  border-color: #356be8;
  box-shadow: 0 0 0 3px rgb(53 107 232 / 14%);
}

.question-meta {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 8px;
  color: #7b879a;
  font-size: 12px;
}

.question-editor fieldset {
  min-width: 0;
  margin: 18px 0 0;
  padding: 0;
  border: 0;
}

.topic-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}

.topic-grid label {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  padding: 8px 13px;
  border: 1px solid #d5ddec;
  border-radius: 999px;
  color: #536178;
  cursor: pointer;
  font-size: 13px;
  transition-property: color, background-color, border-color, transform;
  transition-duration: 150ms;
}

.topic-grid label.selected {
  border-color: #356be8;
  background: #eef3ff;
  color: #1f55cf;
  font-weight: 700;
}

.topic-grid label:active,
.add-question:active,
.primary-action:active,
.secondary-action:active,
.quiet-action:active {
  transform: scale(0.97);
}

.topic-grid input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.topic-grid label:has(input:focus-visible) {
  outline: 3px solid rgb(53 107 232 / 24%);
  outline-offset: 2px;
}

.topic-grid label:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.48;
}

.quiet-action,
.add-question {
  min-height: 40px;
  border: 0;
  background: transparent;
  color: #356be8;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.add-question {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}

.choice-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 22px 0;
  border-bottom: 1px solid #e2e8f1;
  cursor: pointer;
}

.choice-row input {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  accent-color: #356be8;
}

.choice-row span {
  display: grid;
  gap: 5px;
}

.choice-row strong {
  font-size: 15px;
}

.choice-row small,
.attribution-field small {
  color: #6c788c;
  line-height: 1.6;
}

.choice-row.disabled {
  cursor: default;
  opacity: 0.55;
}

.consent-note {
  margin: 18px 0 0;
  color: #536078;
  font-size: 13px;
  line-height: 1.75;
}

.attribution-field {
  display: block;
  max-width: 520px;
  margin-top: 20px;
}

.attribution-field small {
  display: block;
  margin-top: 7px;
}

.public-preview {
  margin-top: 24px;
  padding: 20px;
  border-radius: 10px;
  background: #eef3ff;
}

.public-preview strong {
  display: block;
  margin: 8px 0;
}

.public-preview p {
  margin: 0;
  color: #4b5a72;
  line-height: 1.7;
}

.field-error,
.form-message.is-error,
.needs-state.is-error {
  color: #b42318;
}

.field-error {
  display: block;
  margin-top: 8px;
  font-size: 13px;
  font-style: normal;
}

.moderation-note,
.qualification-note {
  margin: 14px 0 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: #fff4e5;
  color: #7a4b0b;
  font-size: 13px;
  line-height: 1.65;
}

.form-message {
  margin: 0;
  padding: 14px 16px;
  border-radius: 8px;
  background: #fff;
}

.form-message.is-success {
  color: #16734b;
}

.needs-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.primary-action,
.secondary-action {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  border-radius: 8px;
  font-weight: 750;
  text-decoration: none;
  transition-property: transform, background-color, color;
  transition-duration: 150ms;
}

.primary-action {
  border: 0;
  background: #245dd8;
  color: #fff;
  cursor: pointer;
}

.primary-action:disabled {
  cursor: wait;
  opacity: 0.62;
}

.secondary-action {
  border: 1px solid #ccd6e5;
  background: #fff;
  color: #263650;
}

.text-action {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  color: #356be8;
  font-weight: 700;
}

@media (max-width: 640px) {
  .needs-shell {
    width: min(100% - 24px, 980px);
    padding: 46px 0 72px;
  }

  .question-section,
  .privacy-section {
    padding: 24px 18px;
    border-radius: 12px;
  }

  .needs-intro h1 {
    font-size: 36px;
  }

  .question-meta {
    display: grid;
  }

  .needs-actions {
    align-items: flex-start;
  }
}

@media (prefers-reduced-motion: reduce) {
  .topic-grid label,
  .primary-action,
  .secondary-action {
    transition: none;
  }
}
</style>
