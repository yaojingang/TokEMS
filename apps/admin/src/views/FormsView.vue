<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  DEFAULT_REGISTRATION_TERMS,
  type EventStatus,
  type RegistrationField,
  type RegistrationForm,
} from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi, session } from '../lib/api';
import {
  isCoreRegistrationField,
  isSystemRegistrationField,
  nextCustomFieldKey,
  prepareRegistrationForm,
} from '../lib/registration-form-editor';

const versions = ref<RegistrationForm[]>([]);
const loading = ref(true);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const showImportantChangeConfirm = ref(false);
const eventStatus = ref<EventStatus>('configuring');
const eventSlug = ref('');
const currentForm = computed(() => versions.value.find((form) => form.active) ?? versions.value[0]);
const savedFormDiffers = computed(() => versions.value[0]?.version !== currentForm.value?.version);
const editor = reactive({
  name: '标准参会报名表',
  termsVersion: new Date().toISOString().slice(0, 10),
  termsContent: DEFAULT_REGISTRATION_TERMS,
  fields: [] as RegistrationField[],
});
const importantChanges = computed(() => {
  const current = currentForm.value;
  if (!current) return [];
  const details: Array<{ label: string; value: string }> = [];
  if (
    current.termsVersion !== editor.termsVersion ||
    current.termsContent !== editor.termsContent
  ) {
    details.push({
      label: '报名条款',
      value: `${current.termsVersion} → ${editor.termsVersion}`,
    });
  }
  const nextFields = new Map(editor.fields.map((field) => [field.key, field]));
  const removed = current.fields.filter(
    (field) =>
      !nextFields.has(field.key) ||
      (field.enabled !== false && nextFields.get(field.key)?.enabled === false),
  );
  const changedTypes = current.fields.filter((field) => {
    const next = nextFields.get(field.key);
    return next && next.type !== field.type;
  });
  const newRequired = editor.fields.filter((field) => {
    const prior = current.fields.find((item) => item.key === field.key);
    return (
      field.enabled !== false &&
      field.required &&
      (prior?.required !== true || prior.enabled === false)
    );
  });
  if (removed.length) {
    details.push({ label: '移除字段', value: removed.map((field) => field.label).join('、') });
  }
  if (changedTypes.length) {
    details.push({
      label: '改变类型',
      value: changedTypes.map((field) => field.label).join('、'),
    });
  }
  if (newRequired.length) {
    details.push({
      label: '新增必填',
      value: newRequired.map((field) => field.label).join('、'),
    });
  }
  return details;
});

function standardFields(): RegistrationField[] {
  return [
    { key: 'name', label: '姓名', type: 'text', required: true },
    { key: 'mobile', label: '手机号码', type: 'tel', required: true },
    { key: 'email', label: '电子邮箱', type: 'email', required: false },
    { key: 'company', label: '公司/机构', type: 'text', required: true },
    { key: 'title', label: '职位', type: 'text', required: true },
    { key: 'city', label: '所在城市', type: 'text', required: true },
  ];
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [loadedVersions, event] = await Promise.all([
      conferenceApi.getForms(),
      conferenceApi.getEvent(),
    ]);
    versions.value = loadedVersions;
    eventStatus.value = event.status;
    eventSlug.value = event.slug;
    const current = currentForm.value;
    if (current) {
      editForm(current);
    } else {
      editor.fields = standardFields();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名表与条款读取失败';
    if (!editor.fields.length) editor.fields = standardFields();
  } finally {
    loading.value = false;
  }
}

function editForm(form: RegistrationForm) {
  editor.name = form.name;
  editor.termsVersion = form.termsVersion;
  editor.termsContent = form.termsContent;
  editor.fields = form.fields.map((field) => ({
    ...field,
    ...(field.options ? { options: [...field.options] } : {}),
  }));
}

function addField() {
  editor.fields.push({
    key: nextCustomFieldKey(editor.fields),
    label: '自定义字段',
    type: 'text',
    required: false,
  });
}

function updateOptions(field: RegistrationField, value: string) {
  field.options = value
    .split(/\n|、|，|,|；|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function requestSave() {
  message.value = '';
  errorMessage.value = '';
  const prepared = prepareRegistrationForm(editor);
  if (!prepared.ok) {
    errorMessage.value = prepared.message;
    return;
  }
  if (importantChanges.value.length) {
    showImportantChangeConfirm.value = true;
    return;
  }
  void save();
}

async function save() {
  showImportantChangeConfirm.value = false;
  message.value = '';
  errorMessage.value = '';
  const prepared = prepareRegistrationForm(editor);
  if (!prepared.ok) {
    errorMessage.value = prepared.message;
    return;
  }
  pending.value = true;
  try {
    const published = await conferenceApi.publishForm(prepared.value);
    const publicEvent = ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(
      eventStatus.value,
    )
      ? await conferenceApi.getEvent(eventSlug.value)
      : null;
    if (
      publicEvent &&
      (publicEvent.registrationForm?.version !== published.version ||
        publicEvent.registrationForm.termsVersion !== published.termsVersion ||
        publicEvent.registrationForm.termsContent !== published.termsContent ||
        JSON.stringify(prepareRegistrationForm(publicEvent.registrationForm)) !==
          JSON.stringify(prepareRegistrationForm(published)))
    ) {
      throw new Error('表单已保存，但前台生效版本核对失败，请重新保存并检查发布状态。');
    }
    message.value = publicEvent
      ? '已核对前台，新的报名已使用最新表单与条款'
      : '已保存，大会上线时生效';
    await load();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '表单保存失败';
  } finally {
    pending.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <header class="admin-page-head reveal is-visible">
    <div>
      <p class="eyebrow">REGISTRATION FORM / CONSENT</p>
      <h1>报名表与条款</h1>
      <p>维护报名字段和条款正文，保存后直接用于新的报名。</p>
    </div>
    <button class="button secondary" type="button" @click="addField">＋ 添加字段</button>
  </header>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading" role="status">正在读取报名表版本…</div>

  <div v-else>
    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>表单编辑器</h2>
          <p v-if="currentForm">当前生效表单：第 {{ currentForm.version }} 版</p>
          <p>历史报名继续保留当时确认的字段、条款和同意时间</p>
          <p>手机号码保持开启并必填。其他字段可设为选填、关闭或删除；关闭后保留字段配置。</p>
          <p v-if="savedFormDiffers" role="status">
            另有第 {{ versions[0]?.version }} 版保存内容尚未用于当前报名。
            <button type="button" class="row-action" @click="editForm(versions[0]!)">
              载入该版内容
            </button>
          </p>
        </div>
      </header>
      <form class="event-form" @submit.prevent="requestSave">
        <div class="form-grid">
          <div class="form-field">
            <label for="registration-form-name">表单名称</label><input id="registration-form-name" v-model="editor.name" required />
          </div>
          <div class="form-field">
            <label for="registration-terms-version">条款版本</label><input id="registration-terms-version" v-model="editor.termsVersion" required />
          </div>
          <div class="form-field full">
            <label for="registration-terms-content">条款正文</label><textarea
              id="registration-terms-content"
              v-model="editor.termsContent"
              required
              minlength="10"
            ></textarea>
          </div>
        </div>
        <div class="field-builder">
          <div class="field-builder-header" aria-hidden="true">
            <span>字段键</span><span>显示名称</span><span>类型</span><span>占位提示</span><span>可选值</span><span>必填</span><span>操作</span>
          </div>
          <div
            v-for="(field, index) in editor.fields"
            :key="`${field.key}-${index}`"
            class="field-builder-row"
          >
            <strong class="field-builder-index">字段 {{ String(index + 1).padStart(2, '0') }}</strong>
            <label class="field-builder-cell">
              <span class="field-cell-label">字段键</span>
              <input
                v-model="field.key"
                :aria-label="`字段 ${index + 1} 的字段键`"
                :disabled="isSystemRegistrationField(field.key)"
                :title="
                  isCoreRegistrationField(field.key) ? '系统核心字段的键名保持固定' : undefined
                "
                required
                placeholder="field_key"
              />
            </label>
            <label class="field-builder-cell">
              <span class="field-cell-label">显示名称</span>
              <input
                v-model="field.label"
                :aria-label="`字段 ${index + 1} 的显示名称`"
                required
                placeholder="字段名称"
              />
            </label>
            <label class="field-builder-cell">
              <span class="field-cell-label">类型</span>
              <select
                v-model="field.type"
                :aria-label="`字段 ${index + 1} 的类型`"
                :disabled="isSystemRegistrationField(field.key)"
                :title="
                  isCoreRegistrationField(field.key) ? '系统核心字段的类型保持固定' : undefined
                "
              >
                <option value="text">文本</option>
                <option value="email">邮箱</option>
                <option value="tel">手机</option>
                <option value="select">选项</option>
              </select>
            </label>
            <label class="field-builder-cell">
              <span class="field-cell-label">占位提示</span>
              <input
                v-model="field.placeholder"
                :aria-label="`字段 ${index + 1} 的占位提示`"
                placeholder="占位提示"
              />
            </label>
            <label class="field-builder-cell">
              <span class="field-cell-label">可选值</span>
              <input
                v-if="field.type === 'select'"
                :value="field.options?.join('、') ?? ''"
                :aria-label="`字段 ${index + 1} 的可选值`"
                placeholder="选项A、选项B"
                @input="updateOptions(field, ($event.target as HTMLInputElement).value)"
              />
              <span v-else class="field-empty-value">无需填写</span>
            </label>
            <label class="field-builder-required">
              <input
                v-model="field.required"
                type="checkbox"
                :disabled="isCoreRegistrationField(field.key)"
                :title="isCoreRegistrationField(field.key) ? '系统核心字段保持必填' : undefined"
              />
              <span>必填</span>
            </label>
            <div class="field-builder-action">
              <button
                class="row-action"
                type="button"
                :disabled="isCoreRegistrationField(field.key)"
                :aria-label="`${field.enabled === false ? '开启' : '关闭'}字段 ${field.label}`"
                :aria-pressed="field.enabled !== false"
                @click="field.enabled = field.enabled === false"
              >
                {{ field.enabled === false ? '已关闭' : '已开启' }}
              </button>
              <button
                class="row-action"
                type="button"
                :aria-label="
                  isCoreRegistrationField(field.key)
                    ? `系统核心字段 ${index + 1} 不可删除`
                    : `删除字段 ${index + 1}`
                "
                :disabled="isCoreRegistrationField(field.key)"
                :title="isCoreRegistrationField(field.key) ? '系统核心字段不可删除' : '删除字段'"
                @click="editor.fields.splice(index, 1)"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        <div class="event-form-actions">
          <button class="button" type="submit" :disabled="pending || !editor.fields.length">
            {{ pending ? '保存中…' : '保存并生效' }}
          </button>
        </div>
      </form>
    </section>
  </div>

  <AdminConfirmDialog
    :open="showImportantChangeConfirm"
    :event-name="session.activeEvent.value?.name"
    title="确认更新报名表与条款？"
    description="保存成功后新的报名会立即使用以下配置，历史报名继续保留原表单和条款快照。"
    :details="importantChanges"
    :busy="pending"
    :error="errorMessage"
    @cancel="showImportantChangeConfirm = false"
    @confirm="save"
  />
</template>
