<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { EventStatus, RegistrationField, RegistrationForm } from '@conference/contracts';
import AdminConfirmDialog from '../components/AdminConfirmDialog.vue';
import SaveStatus from '../components/SaveStatus.vue';
import { conferenceApi } from '../lib/api';
import { dateTime, statusLabel } from '../lib/format';

const versions = ref<RegistrationForm[]>([]);
const loading = ref(true);
const pending = ref(false);
const message = ref('');
const errorMessage = ref('');
const showImportantChangeConfirm = ref(false);
const eventStatus = ref<EventStatus>('configuring');
const editor = reactive({
  name: '标准参会报名表',
  termsVersion: new Date().toISOString().slice(0, 10),
  termsContent: '提交报名即表示参会人同意大会报名服务条款与个人信息处理说明。',
  fields: [] as RegistrationField[],
});
const importantChanges = computed(() => {
  const current = versions.value[0];
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
  const removed = current.fields.filter((field) => !nextFields.has(field.key));
  const changedTypes = current.fields.filter((field) => {
    const next = nextFields.get(field.key);
    return next && next.type !== field.type;
  });
  const newRequired = editor.fields.filter((field) => {
    const prior = current.fields.find((item) => item.key === field.key);
    return field.required && prior?.required !== true;
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
    { key: 'email', label: '电子邮箱', type: 'email', required: true },
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
    const current = versions.value[0];
    if (current) {
      editor.name = current.name;
      editor.termsVersion = current.termsVersion;
      editor.termsContent = current.termsContent;
      editor.fields = current.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(field.options ? { options: [...field.options] } : {}),
      }));
    } else {
      editor.fields = standardFields();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报名表版本读取失败';
    if (!editor.fields.length) editor.fields = standardFields();
  } finally {
    loading.value = false;
  }
}

function addField() {
  editor.fields.push({
    key: `custom_${editor.fields.length + 1}`,
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
  if (importantChanges.value.length) {
    showImportantChangeConfirm.value = true;
    return;
  }
  void save();
}

async function save() {
  showImportantChangeConfirm.value = false;
  pending.value = true;
  errorMessage.value = '';
  try {
    const result = await conferenceApi.publishForm({
      name: editor.name,
      fields: editor.fields,
      termsVersion: editor.termsVersion,
      termsContent: editor.termsContent,
    });
    message.value = ['prepublished', 'registration_open', 'in_progress', 'ended'].includes(
      eventStatus.value,
    )
      ? `已保存，新的报名使用表单 V${result.version}`
      : `已保存表单 V${result.version}，大会上线时生效`;
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
      <p class="eyebrow">VERSIONED CONSENT</p>
      <h1>报名表与条款</h1>
      <p>保存后立即用于新的报名，历史报名继续保留当时确认的字段、条款和同意时间。</p>
    </div>
    <button class="button secondary" type="button" @click="addField">＋ 添加字段</button>
  </header>
  <SaveStatus :message="message" :error="errorMessage" />
  <div v-if="loading" class="admin-loading" role="status">正在读取报名表版本…</div>

  <div v-else class="content-grid">
    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>表单编辑器</h2>
          <p>字段键用于数据契约，保存生效后请保持语义稳定</p>
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
              <select v-model="field.type" :aria-label="`字段 ${index + 1} 的类型`">
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
              <input v-model="field.required" type="checkbox" />
              <span>必填</span>
            </label>
            <div class="field-builder-action">
              <button
                class="row-action"
                type="button"
                :aria-label="`删除字段 ${index + 1}`"
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

    <section class="admin-panel">
      <header class="admin-panel-header">
        <div>
          <h2>版本记录</h2>
          <p>历史版本保持不可变，新报名只使用当前版本</p>
        </div>
        <span class="status-badge">{{ versions.length }} VERSIONS</span>
      </header>
      <ul class="operations-list">
        <li v-for="item in versions" :key="item.id">
          <div>
            <strong>V{{ item.version }} · {{ item.name }}</strong><small>条款 {{ item.termsVersion }} · {{ item.fields.length }} 个字段 ·
              {{ item.publishedAt ? dateTime(item.publishedAt) : '草稿' }}</small>
          </div>
          <span class="status-badge" :class="{ success: item.status === 'published' }">{{
            statusLabel(item.status)
          }}</span>
        </li>
      </ul>
      <div v-if="!versions.length" class="admin-empty">
        尚无表单版本，当前编辑器已载入标准报名字段。
      </div>
    </section>
  </div>

  <AdminConfirmDialog
    :open="showImportantChangeConfirm"
    title="确认更新报名表与条款？"
    description="保存成功后新的报名会立即使用以下配置，历史报名继续保留原表单和条款快照。"
    :details="importantChanges"
    :busy="pending"
    :error="errorMessage"
    @cancel="showImportantChangeConfirm = false"
    @confirm="save"
  />
</template>
