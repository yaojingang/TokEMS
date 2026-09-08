<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import type { TemplateLogoWall, TemplatePartnerLogo } from '@conference/contracts';
import { apiResourceUrl, conferenceApi, session } from '../lib/api';

const props = defineProps<{ modelValue: TemplateLogoWall; disabled?: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: TemplateLogoWall];
  'pending-change': [value: boolean];
}>();
const fieldId = useId();
const fileInput = ref<HTMLInputElement>();
const replacementId = ref<string>();
const uploading = ref(false);
let disposed = false;
onBeforeRouteLeave(() => !uploading.value);
onBeforeRouteUpdate(() => !uploading.value);
onBeforeUnmount(() => {
  disposed = true;
  emit('pending-change', false);
});
const errorMessage = ref('');
const canUpload = session.can('org.template.manage');
const locked = computed(() => props.disabled || uploading.value);
const logoUrl = (assetId: string) => apiResourceUrl(`/assets/templates/${assetId}`) ?? '';

function update(items: TemplatePartnerLogo[]) {
  emit('update:modelValue', { ...props.modelValue, items });
}
function patch(id: string, value: Partial<TemplatePartnerLogo>) {
  update(props.modelValue.items.map((item) => (item.id === id ? { ...item, ...value } : item)));
}
function move(index: number, step: number) {
  const items = [...props.modelValue.items];
  const target = index + step;
  if (target < 0 || target >= items.length) return;
  const [item] = items.splice(index, 1);
  if (item) items.splice(target, 0, item);
  update(items);
}
function chooseImage(id?: string) {
  replacementId.value = id;
  fileInput.value?.click();
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || locked.value || !canUpload) return;
  errorMessage.value = '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    errorMessage.value = '请上传 PNG、JPG 或 WebP 格式的 Logo。';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    errorMessage.value = '图片请控制在 8 MB 以内。';
    return;
  }
  const id = replacementId.value;
  const existing = props.modelValue.items.find((item) => item.id === id);
  if (!existing && props.modelValue.items.length >= 100) return;
  uploading.value = true;
  emit('pending-change', true);
  try {
    const name = existing?.name || file.name.replace(/\.[^.]+$/, '').slice(0, 120) || '机构 Logo';
    const bitmap = await createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const asset = await conferenceApi.uploadTemplateAsset(file, name, dimensions);
    if (disposed) return;
    if (existing) {
      patch(existing.id, { assetId: asset.id });
    } else {
      update([
        ...props.modelValue.items,
        {
          id: crypto.randomUUID(),
          name,
          assetId: asset.id,
          group: 'speaker',
          enabled: true,
          background: 'light',
          scale: 1,
        },
      ]);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Logo 上传失败，请重试。';
  } finally {
    uploading.value = false;
    emit('pending-change', false);
  }
}
</script>

<template>
  <div class="logo-editor">
    <div class="logo-editor__heading">
      <div>
        <h3>机构 Logo 墙</h3>
        <p>首页只展示图片，名称和分组用于后台维护。</p>
      </div>
      <label class="logo-editor__toggle">
        <input
          type="checkbox"
          :checked="modelValue.enabled"
          :disabled="locked"
          @change="
            emit('update:modelValue', {
              ...modelValue,
              enabled: ($event.target as HTMLInputElement).checked,
            })
          "
        />
        显示 Logo 墙
      </label>
    </div>
    <p v-if="errorMessage" role="alert" class="form-error">{{ errorMessage }}</p>
    <p v-if="!modelValue.items.length" class="logo-editor__empty">
      上传第一张 Logo，图片会按顺序并排展示。
    </p>
    <ol class="logo-editor__list">
      <li v-for="(logo, index) in modelValue.items" :key="logo.id" class="logo-editor__row">
        <div class="logo-editor__preview" :class="{ 'is-dark': logo.background === 'dark' }">
          <img
            v-if="logo.assetId"
            :src="logoUrl(logo.assetId)"
            :alt="logo.name"
            :style="{ maxHeight: `${48 * logo.scale}px` }"
          />
          <span v-else>待上传</span>
        </div>
        <div class="logo-editor__fields form-field">
          <label :for="`${fieldId}-name-${logo.id}`">机构名称</label>
          <input
            :id="`${fieldId}-name-${logo.id}`"
            :value="logo.name"
            maxlength="120"
            required
            :disabled="locked"
            @input="patch(logo.id, { name: ($event.target as HTMLInputElement).value })"
          />
          <div class="logo-editor__options">
            <label>分组
              <select
                :value="logo.group"
                :disabled="locked"
                @change="
                  patch(logo.id, {
                    group: ($event.target as HTMLSelectElement)
                      .value as TemplatePartnerLogo['group'],
                  })
                "
              >
                <option value="speaker">嘉宾机构</option>
                <option value="media">媒体机构</option>
                <option value="member">会员机构</option>
              </select>
            </label>
            <label>底色
              <select
                :value="logo.background"
                :disabled="locked"
                @change="
                  patch(logo.id, {
                    background: ($event.target as HTMLSelectElement)
                      .value as TemplatePartnerLogo['background'],
                  })
                "
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <label>大小
              <input
                type="number"
                :value="logo.scale"
                min="0.5"
                max="2"
                step="0.1"
                :disabled="locked"
                @change="
                  patch(logo.id, {
                    scale: Math.min(
                      2,
                      Math.max(0.5, Number(($event.target as HTMLInputElement).value) || 1),
                    ),
                  })
                "
              />
            </label>
          </div>
        </div>
        <div class="logo-editor__actions">
          <label class="logo-editor__toggle"><input
            type="checkbox"
            :checked="logo.enabled"
            :disabled="locked"
            @change="patch(logo.id, { enabled: ($event.target as HTMLInputElement).checked })"
          />显示</label>
          <button
            type="button"
            class="button secondary"
            :disabled="locked || !canUpload"
            @click="chooseImage(logo.id)"
          >
            替换图片
          </button>
          <div class="logo-editor__order">
            <button
              type="button"
              class="button secondary"
              :disabled="locked || index === 0"
              :aria-label="`上移 ${logo.name}`"
              @click="move(index, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="button secondary"
              :disabled="locked || index === modelValue.items.length - 1"
              :aria-label="`下移 ${logo.name}`"
              @click="move(index, 1)"
            >
              ↓
            </button>
            <button
              type="button"
              class="button secondary"
              :disabled="locked"
              :aria-label="`移除 ${logo.name}`"
              @click="update(modelValue.items.filter((item) => item.id !== logo.id))"
            >
              移除
            </button>
          </div>
        </div>
      </li>
    </ol>
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      aria-label="上传 Logo 图片"
      @change="upload"
    />
    <button
      type="button"
      class="button secondary"
      :disabled="locked || !canUpload || modelValue.items.length >= 100"
      @click="chooseImage()"
    >
      {{ uploading ? '正在上传…' : '添加 Logo' }}
    </button>
    <p class="logo-editor__hint">
      支持 PNG、JPG、WebP，建议透明背景；留白较多的图片可微调大小。{{
        !canUpload ? '上传图片需要模板管理权限。' : ''
      }}
    </p>
  </div>
</template>

<style scoped>
.logo-editor {
  min-width: 0;
}
.logo-editor__heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.logo-editor__heading h3 {
  margin: 0 0 6px;
}
.logo-editor__heading p,
.logo-editor__hint,
.logo-editor__empty {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.logo-editor__list {
  list-style: none;
  margin: 0 0 20px;
  padding: 0;
}
.logo-editor__row {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: center;
  padding: 20px 0;
  border-top: 1px solid var(--line);
}
.logo-editor__preview {
  width: 152px;
  height: 96px;
  display: grid;
  place-items: center;
  padding: 12px;
  background: #fff;
}
.logo-editor__preview.is-dark {
  background: #202125;
}
.logo-editor__preview img {
  display: block;
  max-width: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}
.logo-editor__fields {
  flex: 1 1 220px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.logo-editor__fields label {
  font-size: 12px;
}
.logo-editor__options {
  display: grid;
  grid-template-columns: 1.4fr 1fr 80px;
  gap: 10px;
}
.logo-editor__options label {
  display: grid;
  gap: 4px;
}
.logo-editor__fields input,
.logo-editor__fields select {
  width: 100%;
  min-width: 0;
}
.logo-editor__actions {
  display: grid;
  gap: 10px;
}
.logo-editor__order {
  display: flex;
  gap: 6px;
}
.logo-editor__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.logo-editor__toggle input {
  width: auto;
}
.logo-editor__hint {
  margin-top: 12px;
}
</style>
