<script setup lang="ts">
import { computed } from 'vue';
import { useSettingsFormState } from '../composables/settings-form-state';

const props = withDefaults(
  defineProps<{
    pending?: boolean;
    disabled?: boolean;
    primaryLabel: string;
    pendingLabel?: string;
    impactText?: string;
  }>(),
  {
    pending: false,
    disabled: false,
    pendingLabel: '保存中…',
    impactText: '保存成功后配置立即生效。',
  },
);

const { dirty, discard } = useSettingsFormState();
const visible = computed(() => dirty.value || props.pending);
</script>

<template>
  <Transition name="settings-save-bar">
    <div v-if="visible" class="event-form-actions settings-form-actions">
      <p class="settings-save-state" aria-live="polite">
        <strong>{{ pending ? '正在保存设置' : '有未保存的更改' }}</strong>
        <span>{{ pending ? '请保持页面开启，完成后即可继续操作。' : impactText }}</span>
      </p>
      <div class="settings-save-buttons">
        <button class="button secondary" type="button" :disabled="pending" @click="discard">
          放弃更改
        </button>
        <slot name="secondary" />
        <button class="button" type="submit" :disabled="pending || disabled">
          {{ pending ? pendingLabel : primaryLabel }}
        </button>
      </div>
    </div>
  </Transition>
</template>
