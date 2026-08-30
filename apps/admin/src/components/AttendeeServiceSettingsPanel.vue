<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { EventAttendeeServiceConfiguration } from '@conference/contracts';
import { conferenceApi } from '../lib/api';

const configuration = ref<EventAttendeeServiceConfiguration>();
const loading = ref(true);
const saving = ref(false);
const uploading = ref(false);
const message = ref('');
const errorMessage = ref('');
const form = reactive({
  enabled: false,
  organizerName: '',
  organizerRole: '',
  wechatId: '',
  instructions: '',
  qrAssetId: null as string | null,
  qrPreviewUrl: null as string | null,
  version: 0,
});
const missingEnabledFields = computed(() => {
  if (!form.enabled) return [];
  return [
    !form.organizerName.trim() ? '组织者姓名' : '',
    !form.wechatId.trim() ? '微信号' : '',
    !form.instructions.trim() ? '入群说明' : '',
    !form.qrAssetId ? '二维码' : '',
  ].filter(Boolean);
});
const canSave = computed(() => missingEnabledFields.value.length === 0);
const hasUnsavedChanges = computed(() => {
  const current = configuration.value;
  if (!current) return false;
  return (
    form.enabled !== current.enabled ||
    form.organizerName !== current.organizerName ||
    form.organizerRole !== current.organizerRole ||
    form.wechatId !== current.wechatId ||
    form.instructions !== current.instructions ||
    form.qrAssetId !== current.qrAssetId
  );
});

function hydrate(value: EventAttendeeServiceConfiguration) {
  configuration.value = value;
  Object.assign(form, {
    enabled: value.enabled,
    organizerName: value.organizerName,
    organizerRole: value.organizerRole,
    wechatId: value.wechatId,
    instructions: value.instructions,
    qrAssetId: value.qrAssetId,
    qrPreviewUrl: value.qrPreviewUrl,
    version: value.version,
  });
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    hydrate(await conferenceApi.getAttendeeServiceConfiguration());
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参会者服务配置读取失败';
  } finally {
    loading.value = false;
  }
}

async function uploadQr(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    errorMessage.value = '二维码仅支持 JPG、PNG 或 WebP 图片';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = '二维码图片不能超过 2MB';
    return;
  }
  uploading.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const uploaded = await conferenceApi.uploadAttendeeServiceQr(file);
    form.qrAssetId = uploaded.assetId;
    form.qrPreviewUrl = uploaded.previewUrl;
    message.value = '二维码已上传，请保存配置后生效';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '二维码上传失败';
  } finally {
    uploading.value = false;
  }
}

async function save() {
  saving.value = true;
  message.value = '';
  errorMessage.value = '';
  try {
    const updated = await conferenceApi.updateAttendeeServiceConfiguration({
      version: form.version,
      enabled: form.enabled,
      organizerName: form.organizerName,
      organizerRole: form.organizerRole,
      wechatId: form.wechatId,
      instructions: form.instructions,
      qrAssetId: form.qrAssetId,
    });
    hydrate(updated);
    message.value = form.enabled ? '参会者服务已启用' : '参会者服务配置已保存，当前保持关闭';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '参会者服务配置保存失败';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="admin-panel attendee-service-panel">
    <header class="admin-panel-header">
      <div>
        <p class="attendee-service-kicker">ATTENDEE SERVICE</p>
        <h2>参会者服务</h2>
        <p>配置个人中心里的大会组织者入口。开启后仅持有效电子票的实际参会人可读取二维码。</p>
      </div>
      <span
        class="status-badge"
        :class="hasUnsavedChanges ? 'pending' : configuration?.enabled ? 'paid' : 'draft'"
      >
        {{ hasUnsavedChanges ? 'UNSAVED' : configuration?.enabled ? 'ENABLED' : 'OFF' }}
      </span>
    </header>

    <div v-if="loading" class="admin-empty">正在读取参会者服务配置…</div>
    <div v-else-if="!configuration" class="attendee-service-load-error" role="alert">
      <span>{{ errorMessage || '参会者服务配置读取失败' }}</span>
      <button class="button secondary compact" type="button" @click="load">重新读取</button>
    </div>
    <form v-else class="event-form settings-form-spaced" @submit.prevent="save">
      <label class="setting-toggle attendee-service-toggle">
        <span>
          <strong>向有效参会人开放组织者入口</strong>
          <small>关闭时用户端显示“暂未开放”，已保存资料继续保留</small>
        </span>
        <input v-model="form.enabled" type="checkbox" />
      </label>

      <div class="attendee-service-layout">
        <div class="form-grid attendee-service-fields">
          <div class="form-field">
            <label for="attendee-service-organizer-name">组织者姓名</label>
            <input
              id="attendee-service-organizer-name"
              v-model="form.organizerName"
              maxlength="120"
              :required="form.enabled"
              placeholder="例如：张老师"
            />
          </div>
          <div class="form-field">
            <label for="attendee-service-organizer-role">身份说明</label>
            <input
              id="attendee-service-organizer-role"
              v-model="form.organizerRole"
              maxlength="160"
              placeholder="例如：大会参会服务负责人"
            />
          </div>
          <div class="form-field full">
            <label for="attendee-service-wechat">微信号</label>
            <input
              id="attendee-service-wechat"
              v-model="form.wechatId"
              maxlength="80"
              :required="form.enabled"
              autocomplete="off"
              placeholder="参会者可复制的微信号"
            />
          </div>
          <div class="form-field full">
            <label for="attendee-service-instructions">入群说明</label>
            <textarea
              id="attendee-service-instructions"
              v-model="form.instructions"
              maxlength="1000"
              :required="form.enabled"
              rows="5"
              placeholder="说明添加好友时的备注格式、邀请入群时间等"
            ></textarea>
          </div>
        </div>

        <div class="attendee-service-qr">
          <div class="attendee-service-qr-frame">
            <img v-if="form.qrPreviewUrl" :src="form.qrPreviewUrl" alt="组织者微信二维码预览" />
            <div v-else class="attendee-service-qr-empty">
              <span>QR</span>
              <small>尚未上传</small>
            </div>
          </div>
          <label class="button secondary compact attendee-service-upload">
            {{ uploading ? '上传中…' : form.qrAssetId ? '更换二维码' : '上传二维码' }}
            <input
              class="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              :disabled="uploading || saving"
              @change="uploadQr"
            />
          </label>
          <button
            v-if="form.qrAssetId"
            class="button secondary compact"
            type="button"
            :disabled="uploading || saving"
            @click="
              form.qrAssetId = null;
              form.qrPreviewUrl = null;
            "
          >
            移除二维码
          </button>
          <small>JPG、PNG 或 WebP，最大 2MB</small>
        </div>
      </div>

      <p v-if="message" class="attendee-service-message success" role="status">{{ message }}</p>
      <p
        v-if="missingEnabledFields.length"
        class="attendee-service-message warning"
        role="status"
      >
        启用前还需补充：{{ missingEnabledFields.join('、') }}
      </p>
      <p v-if="errorMessage" class="attendee-service-message error" role="alert">
        {{ errorMessage }}
      </p>
      <div class="event-form-actions">
        <button
          class="button"
          type="submit"
          :disabled="saving || uploading || !canSave || !hasUnsavedChanges"
        >
          {{ saving ? '保存中…' : hasUnsavedChanges ? '保存参会者服务' : '配置已保存' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.attendee-service-panel {
  border-top: 3px solid #2563eb;
}

.attendee-service-kicker {
  margin: 0 0 6px;
  color: #2563eb;
  font:
    700 11px/1.2 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.12em;
}

.attendee-service-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 32px;
  align-items: start;
}

.attendee-service-fields {
  margin: 0;
}

.attendee-service-toggle {
  margin-bottom: 24px;
}

.attendee-service-qr {
  display: grid;
  justify-items: stretch;
  gap: 10px;
}

.attendee-service-qr-frame {
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  padding: 12px;
  border: 1px solid var(--line, #d7dce5);
  background: #f7f9fc;
}

.attendee-service-qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.attendee-service-qr-empty {
  display: grid;
  gap: 8px;
  color: #738099;
  text-align: center;
}

.attendee-service-qr-empty span {
  font:
    800 32px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  letter-spacing: 0.08em;
}

.attendee-service-upload {
  cursor: pointer;
  text-align: center;
}

.attendee-service-message {
  margin: 0;
  font-size: 13px;
}

.attendee-service-message.success {
  color: #177147;
}

.attendee-service-message.error {
  color: #b42318;
}

.attendee-service-message.warning {
  color: #9a5b13;
}

.attendee-service-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 20px;
  padding: 16px;
  border: 1px solid #fecaca;
  background: #fff7f7;
  color: #b42318;
  font-size: 13px;
}

@media (max-width: 760px) {
  .attendee-service-layout {
    grid-template-columns: 1fr;
  }

  .attendee-service-qr {
    max-width: 240px;
  }
}
</style>
