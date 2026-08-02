<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'primary' | 'danger';
    busy?: boolean;
    error?: string;
    details?: Array<{ label: string; value: string }>;
  }>(),
  {
    confirmLabel: '确认并生效',
    cancelLabel: '返回检查',
    tone: 'primary',
    busy: false,
    error: '',
    details: () => [],
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
const dialog = ref<HTMLDialogElement>();
const cancelButton = ref<HTMLButtonElement>();
const dialogId = useId();
let returnFocus: HTMLElement | null = null;

function closeDialog() {
  if (dialog.value?.open) dialog.value.close();
  returnFocus?.focus();
  returnFocus = null;
}

function cancel() {
  if (props.busy) return;
  emit('cancel');
}

function handleNativeCancel(event: Event) {
  event.preventDefault();
  cancel();
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      closeDialog();
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.value?.open) dialog.value?.showModal();
    await nextTick();
    cancelButton.value?.focus();
  },
  { immediate: true },
);

onBeforeUnmount(closeDialog);
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="admin-confirm-dialog"
      :aria-labelledby="`${dialogId}-title`"
      :aria-describedby="`${dialogId}-description`"
      @cancel="handleNativeCancel"
    >
      <div class="admin-confirm-dialog__signal" :class="tone" aria-hidden="true">
        {{ tone === 'danger' ? '!' : '✓' }}
      </div>
      <header>
        <p class="eyebrow">CONFIRM CHANGE</p>
        <h2 :id="`${dialogId}-title`">{{ title }}</h2>
        <p :id="`${dialogId}-description`">{{ description }}</p>
      </header>
      <dl v-if="details.length" class="admin-confirm-dialog__details">
        <div v-for="item in details" :key="item.label">
          <dt>{{ item.label }}</dt>
          <dd>{{ item.value }}</dd>
        </div>
      </dl>
      <p v-if="error" class="admin-confirm-dialog__error" role="alert">{{ error }}</p>
      <footer>
        <button
          ref="cancelButton"
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="cancel"
        >
          {{ cancelLabel }}
        </button>
        <button
          class="button"
          :class="{ danger: tone === 'danger' }"
          type="button"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '正在处理…' : confirmLabel }}
        </button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.admin-confirm-dialog {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  padding: 24px;
  overflow-y: auto;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  box-shadow: 0 24px 60px rgb(13 28 43 / 24%);
}

.admin-confirm-dialog::backdrop {
  background: rgb(14 28 43 / 52%);
}

.admin-confirm-dialog[open] {
  animation: confirm-dialog-in 160ms var(--ease);
}

.admin-confirm-dialog__signal {
  display: grid;
  width: 36px;
  height: 36px;
  margin-bottom: 16px;
  color: var(--blue);
  background: var(--blue-soft);
  border-radius: var(--radius-pill);
  font-weight: 700;
  place-items: center;
}

.admin-confirm-dialog__signal.danger {
  color: var(--red);
  background: var(--red-soft);
}

.admin-confirm-dialog header {
  margin-bottom: 20px;
}

.admin-confirm-dialog h2 {
  margin: 4px 0 8px;
  font-size: 25px;
  line-height: 1.35;
}

.admin-confirm-dialog header > p:last-child {
  max-width: 58ch;
  margin: 0;
  color: var(--muted);
  line-height: 1.75;
}

.admin-confirm-dialog__details {
  display: grid;
  gap: 1px;
  margin: 0 0 22px;
  overflow: hidden;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.admin-confirm-dialog__details > div {
  display: grid;
  grid-template-columns: minmax(88px, 0.35fr) 1fr;
  gap: 16px;
  padding: 10px 12px;
  background: var(--surface);
}

.admin-confirm-dialog dt {
  color: var(--muted);
  font-size: 12px;
}

.admin-confirm-dialog dd {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.admin-confirm-dialog__error {
  margin: -8px 0 18px;
  padding: 10px 12px;
  color: var(--red);
  background: var(--red-soft);
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.6;
}

.admin-confirm-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@keyframes confirm-dialog-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (max-width: 520px) {
  .admin-confirm-dialog {
    padding: 20px;
  }

  .admin-confirm-dialog__details > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .admin-confirm-dialog footer {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .admin-confirm-dialog footer .button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .admin-confirm-dialog[open] {
    animation: none;
  }
}
</style>
