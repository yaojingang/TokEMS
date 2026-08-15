<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from 'vue';
import type { AttendeeShowcaseValidationIssue } from '~/utils/attendee-showcase-validation';

const props = defineProps<{
  open: boolean;
  issues: AttendeeShowcaseValidationIssue[];
}>();

const emit = defineEmits<{
  close: [];
  navigate: [targetId: string];
}>();

const dialogElement = ref<HTMLElement>();
let openerElement: HTMLElement | null = null;

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
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
);

onBeforeUnmount(() => {
  document.querySelector<HTMLElement>('#__nuxt')?.removeAttribute('inert');
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="validation-dialog">
      <div v-if="open" class="validation-dialog" role="presentation" @mousedown.self="close">
        <section
          ref="dialogElement"
          class="validation-dialog__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="showcase-validation-title"
          aria-describedby="showcase-validation-description"
          tabindex="-1"
        >
          <button
            class="validation-dialog__close"
            type="button"
            aria-label="关闭信息完善提示"
            @click="close"
          >
            ×
          </button>

          <div class="validation-dialog__signal" aria-hidden="true">!</div>
          <p class="validation-dialog__eyebrow">PROFILE CHECK</p>
          <h2 id="showcase-validation-title">还有 {{ issues.length }} 项信息需要完善</h2>
          <p id="showcase-validation-description" class="validation-dialog__lead">
            完成下面内容后，即可保存并在大会主页展示你的参会名片。
          </p>

          <ol class="validation-dialog__issues">
            <li v-for="(issue, index) in issues" :key="issue.field">
              <button
                type="button"
                :autofocus="index === 0"
                @click="emit('navigate', issue.targetId)"
              >
                <span class="validation-dialog__number">{{
                  String(index + 1).padStart(2, '0')
                }}</span>
                <span class="validation-dialog__issue-copy">
                  <strong>{{ issue.label }}</strong>
                  <small>{{ issue.message }}</small>
                </span>
                <span class="validation-dialog__go">去填写 <b aria-hidden="true">→</b></span>
              </button>
            </li>
          </ol>

          <div class="validation-dialog__actions">
            <button
              class="validation-dialog__primary"
              type="button"
              @click="issues[0] && emit('navigate', issues[0].targetId)"
            >
              去完善第一项
            </button>
            <button class="validation-dialog__secondary" type="button" @click="close">
              稍后处理
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.validation-dialog {
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
.validation-dialog__panel {
  position: relative;
  width: min(100%, 500px);
  max-height: calc(100dvh - 48px);
  padding: 30px;
  overflow-y: auto;
  border: 1px solid rgb(214 222 234 / 90%);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 24px 80px rgb(15 23 42 / 24%);
  overscroll-behavior: contain;
}
.validation-dialog__close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  color: #717b8d;
  font-size: 24px;
  line-height: 1;
}
.validation-dialog__signal {
  display: grid;
  width: 42px;
  height: 42px;
  margin-bottom: 18px;
  place-items: center;
  border: 1px solid #b9cdfc;
  border-radius: 50%;
  background: #eff5ff;
  color: #1f5fe8;
  font-size: 22px;
  font-weight: 800;
}
.validation-dialog__eyebrow {
  margin: 0 0 9px;
  color: #1f5fe8;
  font: 760 10px var(--conference-font-mono);
  letter-spacing: 0.14em;
}
.validation-dialog h2 {
  margin: 0;
  color: #172033;
  font-size: 25px;
  letter-spacing: -0.02em;
}
.validation-dialog__lead {
  margin: 10px 0 22px;
  color: #6e7a8f;
  font-size: 14px;
  line-height: 1.7;
}
.validation-dialog__issues {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.validation-dialog__issues button {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  width: 100%;
  min-height: 72px;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #dde5f1;
  border-radius: 9px;
  background: #f8faff;
  text-align: left;
  transition:
    transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 140ms ease,
    background-color 140ms ease;
}
.validation-dialog__issues button:hover,
.validation-dialog__issues button:focus-visible {
  border-color: #9ab7f7;
  background: #f1f6ff;
  outline: none;
}
.validation-dialog__issues button:active,
.validation-dialog__primary:active,
.validation-dialog__secondary:active,
.validation-dialog__close:active {
  transform: scale(0.97);
}
.validation-dialog__number {
  color: #1f5fe8;
  font: 750 11px var(--conference-font-mono);
  letter-spacing: 0.08em;
}
.validation-dialog__issue-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.validation-dialog__issue-copy strong {
  color: #202b40;
  font-size: 14px;
}
.validation-dialog__issue-copy small {
  color: #768196;
  font-size: 12px;
  line-height: 1.5;
}
.validation-dialog__go {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #1f5fe8;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.validation-dialog__go b {
  font-size: 15px;
}
.validation-dialog__actions {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  margin-top: 22px;
}
.validation-dialog__primary,
.validation-dialog__secondary {
  min-height: 46px;
  border-radius: 8px;
  padding: 0 18px;
  font-size: 14px;
  font-weight: 720;
  transition:
    transform 140ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 140ms ease;
}
.validation-dialog__primary {
  background: #1f5fe8;
  color: #fff;
}
.validation-dialog__secondary {
  background: #f1f3f7;
  color: #3d485a;
}
.validation-dialog-enter-active,
.validation-dialog-leave-active {
  transition: opacity 180ms ease;
}
.validation-dialog-enter-active .validation-dialog__panel,
.validation-dialog-leave-active .validation-dialog__panel {
  transition:
    opacity 180ms ease,
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.validation-dialog-enter-from,
.validation-dialog-leave-to,
.validation-dialog-enter-from .validation-dialog__panel,
.validation-dialog-leave-to .validation-dialog__panel {
  opacity: 0;
}
.validation-dialog-enter-from .validation-dialog__panel {
  transform: translateY(12px);
}
.validation-dialog-leave-to .validation-dialog__panel {
  transform: translateY(-12px);
}
@media (max-width: 520px) {
  .validation-dialog {
    padding: 16px;
  }
  .validation-dialog__panel {
    max-height: calc(100dvh - 32px);
    padding: 26px 20px 22px;
  }
  .validation-dialog h2 {
    max-width: 280px;
    font-size: 22px;
  }
  .validation-dialog__issues button {
    grid-template-columns: 28px minmax(0, 1fr);
  }
  .validation-dialog__go {
    grid-column: 2;
  }
  .validation-dialog__actions {
    grid-template-columns: 1fr;
  }
  .validation-dialog__secondary {
    grid-row: 2;
  }
}
@media (prefers-reduced-motion: reduce) {
  .validation-dialog-enter-active,
  .validation-dialog-leave-active,
  .validation-dialog-enter-active .validation-dialog__panel,
  .validation-dialog-leave-active .validation-dialog__panel {
    transition-duration: 1ms;
  }
}
</style>
