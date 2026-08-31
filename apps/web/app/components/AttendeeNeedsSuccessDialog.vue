<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  questionCount: number;
  isPublic: boolean;
  effectivePublic: boolean;
  isAnonymous: boolean;
  attributionName: string | null;
  homeHref: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const dialogElement = ref<HTMLElement>();
let openerElement: HTMLElement | null = null;

const lead = computed(() => {
  if (props.effectivePublic) {
    return '你的问题已更新到大会首页。大会团队会按主题整理，帮助相关嘉宾更准确地回应参会者关注。';
  }
  if (props.isPublic) {
    return '你的问题与公开设置已经保存。满足展示条件后，内容会自动出现在大会首页。';
  }
  return '你的问题已经保存，目前仅你和大会团队可见。你可以随时回来修改内容和公开方式。';
});

const visibilityLabel = computed(() => {
  if (props.effectivePublic) return '已在大会首页展示';
  if (props.isPublic) return '公开设置已保存，当前未展示';
  return '仅你和大会团队可见';
});

const attributionLabel = computed(() => {
  if (!props.isPublic) return '不在首页展示';
  if (props.isAnonymous) return '匿名参会者';
  return props.attributionName?.trim() || '公开署名';
});

function close() {
  emit('close');
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close();
    return;
  }
  if (event.key !== 'Tab' || !dialogElement.value) return;
  const focusable = [
    ...dialogElement.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    dialogElement.value.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialogElement.value.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!import.meta.client) return;
    if (open) {
      openerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.querySelector<HTMLElement>('#__nuxt')?.setAttribute('inert', '');
      document.addEventListener('keydown', handleKeydown);
      await nextTick();
      dialogElement.value?.querySelector<HTMLElement>('[autofocus]')?.focus();
      return;
    }
    document.querySelector<HTMLElement>('#__nuxt')?.removeAttribute('inert');
    document.removeEventListener('keydown', handleKeydown);
    if (openerElement?.isConnected) openerElement.focus();
    openerElement = null;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.querySelector<HTMLElement>('#__nuxt')?.removeAttribute('inert');
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="needs-success-dialog">
      <div v-if="open" class="needs-success-dialog" role="presentation" @mousedown.self="close">
        <section
          ref="dialogElement"
          class="needs-success-dialog__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="needs-success-title"
          aria-describedby="needs-success-description"
          tabindex="-1"
        >
          <button
            class="needs-success-dialog__close"
            type="button"
            aria-label="关闭提交成功提示"
            @click="close"
          >
            ×
          </button>

          <div class="needs-success-dialog__signal" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="m6.5 12.5 3.4 3.4 7.7-8" />
            </svg>
          </div>
          <p class="needs-success-dialog__eyebrow">SUBMISSION SAVED</p>
          <h2 id="needs-success-title">参会需求已保存</h2>
          <p id="needs-success-description" class="needs-success-dialog__lead">{{ lead }}</p>

          <dl class="needs-success-dialog__summary">
            <div>
              <dt>提交内容</dt>
              <dd>{{ questionCount }} 个问题</dd>
            </div>
            <div>
              <dt>首页展示</dt>
              <dd :class="{ 'is-live': effectivePublic }">{{ visibilityLabel }}</dd>
            </div>
            <div>
              <dt>展示署名</dt>
              <dd>{{ attributionLabel }}</dd>
            </div>
          </dl>

          <div class="needs-success-dialog__actions">
            <button autofocus class="needs-success-dialog__primary" type="button" @click="close">
              完成
            </button>
            <a v-if="effectivePublic" class="needs-success-dialog__secondary" :href="homeHref">
              查看大会首页
            </a>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.needs-success-dialog {
  position: fixed;
  z-index: 1100;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow-y: auto;
  background: rgb(9 14 28 / 52%);
  overscroll-behavior: contain;
}

.needs-success-dialog__panel {
  position: relative;
  width: min(100%, 520px);
  max-height: calc(100dvh - 48px);
  padding: 34px;
  overflow-y: auto;
  border: 1px solid rgb(214 222 234 / 90%);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 24%);
  color: #12213d;
  overscroll-behavior: contain;
}

.needs-success-dialog__close {
  position: absolute;
  top: 14px;
  right: 14px;
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #717b8d;
  cursor: pointer;
  font-family: inherit;
  font-size: 24px;
  line-height: 1;
}

.needs-success-dialog__signal {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 20px;
  place-items: center;
  border: 1px solid #9cddc0;
  border-radius: 50%;
  background: #ecf9f3;
  color: #168257;
}

.needs-success-dialog__signal svg {
  width: 25px;
  fill: none;
  stroke: currentcolor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.2;
}

.needs-success-dialog__eyebrow {
  margin: 0 0 9px;
  color: #168257;
  font: 760 10px var(--conference-font-mono);
  letter-spacing: 0.14em;
}

.needs-success-dialog h2 {
  margin: 0;
  color: #172033;
  font-size: 27px;
  letter-spacing: -0.025em;
}

.needs-success-dialog__lead {
  margin: 12px 0 24px;
  color: #66738a;
  font-size: 14px;
  line-height: 1.75;
}

.needs-success-dialog__summary {
  margin: 0;
  padding: 2px 18px;
  border: 1px solid #e0e7f1;
  border-radius: 11px;
  background: #f8faff;
}

.needs-success-dialog__summary > div {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 18px;
  padding: 15px 0;
  border-bottom: 1px solid #e0e7f1;
}

.needs-success-dialog__summary > div:last-child {
  border-bottom: 0;
}

.needs-success-dialog__summary dt,
.needs-success-dialog__summary dd {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
}

.needs-success-dialog__summary dt {
  color: #7b879a;
}

.needs-success-dialog__summary dd {
  color: #263650;
  font-weight: 700;
}

.needs-success-dialog__summary dd.is-live {
  color: #168257;
}

.needs-success-dialog__actions {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  margin-top: 24px;
}

.needs-success-dialog__primary,
.needs-success-dialog__secondary {
  display: inline-flex;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  font-weight: 750;
  text-decoration: none;
  transition:
    transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 160ms ease,
    border-color 160ms ease;
}

.needs-success-dialog__primary {
  border: 0;
  background: #245dd8;
  color: #fff;
}

.needs-success-dialog__secondary {
  border: 1px solid #ccd6e5;
  background: #fff;
  color: #263650;
}

.needs-success-dialog__close:hover,
.needs-success-dialog__close:focus-visible {
  background: #f1f4f8;
  outline: none;
}

.needs-success-dialog__primary:focus-visible,
.needs-success-dialog__secondary:focus-visible {
  outline: 3px solid rgb(53 107 232 / 25%);
  outline-offset: 2px;
}

.needs-success-dialog__close:active,
.needs-success-dialog__primary:active,
.needs-success-dialog__secondary:active {
  transform: scale(0.97);
}

.needs-success-dialog-enter-active,
.needs-success-dialog-leave-active {
  transition: opacity 180ms ease;
}

.needs-success-dialog-enter-active .needs-success-dialog__panel,
.needs-success-dialog-leave-active .needs-success-dialog__panel {
  transition:
    opacity 180ms ease,
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.needs-success-dialog-enter-from,
.needs-success-dialog-leave-to,
.needs-success-dialog-enter-from .needs-success-dialog__panel,
.needs-success-dialog-leave-to .needs-success-dialog__panel {
  opacity: 0;
}

.needs-success-dialog-enter-from .needs-success-dialog__panel {
  transform: translateY(12px);
}

.needs-success-dialog-leave-to .needs-success-dialog__panel {
  transform: translateY(-12px);
}

@media (max-width: 520px) {
  .needs-success-dialog {
    align-items: end;
    padding: 0;
  }

  .needs-success-dialog__panel {
    width: 100%;
    max-height: 85dvh;
    padding: 28px 20px calc(22px + env(safe-area-inset-bottom));
    border-radius: 16px 16px 0 0;
  }

  .needs-success-dialog h2 {
    max-width: 280px;
    font-size: 24px;
  }

  .needs-success-dialog__close {
    width: 44px;
    height: 44px;
  }

  .needs-success-dialog__summary {
    padding: 2px 14px;
  }

  .needs-success-dialog__summary > div {
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 12px;
  }

  .needs-success-dialog__actions {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .needs-success-dialog-enter-active,
  .needs-success-dialog-leave-active,
  .needs-success-dialog-enter-active .needs-success-dialog__panel,
  .needs-success-dialog-leave-active .needs-success-dialog__panel {
    transition-duration: 1ms;
  }
}
</style>
