<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{ open: boolean; version: string; content: string; eventName: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const paragraphs = computed(() =>
  props.content
    .trim()
    .split(/\n\s*\n/u)
    .filter(Boolean),
);
let previousOverflow: string | undefined;

function restoreScroll() {
  if (previousOverflow === undefined) return;
  document.documentElement.style.overflow = previousOverflow;
  previousOverflow = undefined;
}

function close() {
  dialog.value?.close();
  restoreScroll();
  emit('close');
}

watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (!import.meta.client || !dialog.value) return;
    if (open && !dialog.value.open) {
      previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.value.showModal();
    } else if (!open) {
      dialog.value.close();
      restoreScroll();
    }
  },
);
onBeforeUnmount(() => {
  dialog.value?.close();
  restoreScroll();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      id="registration-terms"
      ref="dialog"
      class="registration-terms"
      aria-labelledby="registration-terms-title"
      @cancel.prevent="close"
      @click.self="close"
    >
      <div class="registration-terms__panel">
        <header>
          <div>
            <h2 id="registration-terms-title">报名条款</h2>
            <p>{{ eventName }} · 版本 {{ version }}</p>
          </div>
          <button
            autofocus
            type="button"
            class="registration-terms__close"
            aria-label="关闭报名条款"
            @click="close"
          >
            ×
          </button>
        </header>
        <div class="registration-terms__body">
          <p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p>
          <p v-if="!paragraphs.length">条款暂时无法读取，请关闭弹窗后刷新页面重试。</p>
        </div>
        <footer>
          <button type="button" class="registration-terms__done" @click="close">关闭</button>
        </footer>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.registration-terms {
  margin: auto;
  width: min(600px, calc(100% - 32px));
  max-width: none;
  max-height: calc(100dvh - 48px);
  padding: 0;
  border: 1px solid #d6deea;
  border-radius: 16px;
  background: #fff;
  color: #12213d;
  box-shadow: 0 24px 80px rgb(15 23 42 / 24%);
}
.registration-terms::backdrop {
  background: rgb(9 14 28 / 52%);
}
.registration-terms__panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 50px);
}
.registration-terms header {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 24px 18px;
  border-bottom: 1px solid #e0e7f1;
}
.registration-terms h2 {
  margin: 0;
  font-size: 23px;
  color: #172033;
}
.registration-terms header p {
  margin: 8px 0 0;
  font-size: 13px;
  color: #66738a;
  line-height: 1.6;
}
.registration-terms__close {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: 0;
  border-radius: 8px;
  background: #f1f4f8;
  color: #263650;
  font-size: 26px;
  cursor: pointer;
}
.registration-terms__body {
  padding: 8px 24px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.registration-terms__body p {
  margin: 16px 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
  line-height: 1.8;
  font-size: 15px;
}
.registration-terms footer {
  padding: 16px 24px;
  border-top: 1px solid #e0e7f1;
}
.registration-terms__done {
  display: block;
  min-height: 44px;
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: #245dd8;
  color: #fff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.registration-terms button:focus-visible {
  outline: 3px solid #88aafa;
  outline-offset: 2px;
}
.registration-terms button:active {
  transform: scale(0.97);
}
@media (max-width: 520px) {
  .registration-terms header {
    padding: 20px 18px 16px;
  }
  .registration-terms__body {
    padding: 4px 18px;
  }
  .registration-terms footer {
    padding: 14px 18px;
  }
}
</style>
