<script setup lang="ts">
import type { ResolvedNavigationLink } from '@conference/contracts';
import { nextTick, useId, watch } from 'vue';

const props = defineProps<{ links: ResolvedNavigationLink[] }>();
const root = ref<HTMLElement | null>(null);
const measure = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const expanded = ref(false);
const collapsed = ref(true);
const position = ref({ top: '72px', left: '12px', width: '296px' });
const menuId = useId();
const route = useRoute();
function current(link: ResolvedNavigationLink) {
  return link.kind === 'page' &&
    ((link.target === 'cooperation' && route.path === '/apply/cooperation') ||
      (link.target === 'faq' && route.path === '/faq') ||
      (link.target === 'partners' && route.path === '/partners'))
    ? ('page' as const)
    : undefined;
}
let observer: ResizeObserver | undefined;

function close(restoreFocus = false) {
  const wasExpanded = expanded.value;
  expanded.value = false;
  if (restoreFocus && wasExpanded) trigger.value?.focus();
}
function fit() {
  if (!root.value || !measure.value) return;
  collapsed.value = window.innerWidth <= 900 || measure.value.scrollWidth > root.value.clientWidth;
  if (!collapsed.value) close();
}
async function toggle() {
  if (expanded.value) {
    close(true);
    return;
  }
  const rect = trigger.value?.getBoundingClientRect();
  if (rect) {
    const width = Math.min(340, window.innerWidth - 24);
    position.value = {
      top: `${rect.bottom + 10}px`,
      left: `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`,
      width: `${width}px`,
    };
  }
  expanded.value = true;
  await nextTick();
  panel.value?.querySelector<HTMLAnchorElement>('a')?.focus();
}
function outside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close();
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') close(true);
}
function focusLeft() {
  queueMicrotask(() => {
    if (expanded.value && !root.value?.contains(document.activeElement)) close();
  });
}
function observeMeasurements() {
  observer?.disconnect();
  if (root.value) observer?.observe(root.value);
  if (measure.value) observer?.observe(measure.value);
  fit();
}
function scrolled() {
  close();
}
function resized() {
  close();
  fit();
}
watch(
  () => props.links,
  async () => {
    close();
    await nextTick();
    observeMeasurements();
  },
  { deep: true },
);
onMounted(() => {
  observer = new ResizeObserver(fit);
  observeMeasurements();
  window.addEventListener('resize', resized);
  window.addEventListener('scroll', scrolled, { passive: true });
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', keyboard);
  fit();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', resized);
  window.removeEventListener('scroll', scrolled);
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', keyboard);
});
</script>

<template>
  <div
    v-if="links.length"
    ref="root"
    class="conference-navigation"
    :class="{ 'is-collapsed': collapsed }"
    @focusout="focusLeft"
  >
    <div ref="measure" class="navigation-measure" aria-hidden="true" inert>
      <span v-for="link in links" :key="link.id">{{ link.label }}<span v-if="link.newWindow"> ↗</span></span>
    </div>
    <div v-show="!collapsed" class="nav-links">
      <a
        v-for="link in links"
        :key="link.id"
        :href="link.href"
        :aria-current="current(link)"
        :target="link.newWindow ? '_blank' : undefined"
        :rel="link.newWindow ? 'noopener noreferrer' : undefined"
      >
        {{ link.label
        }}<span v-if="link.newWindow" class="external-mark" aria-label="新窗口打开"> ↗</span>
      </a>
    </div>
    <button
      v-show="collapsed"
      ref="trigger"
      type="button"
      class="navigation-toggle"
      :aria-expanded="expanded"
      :aria-controls="menuId"
      @click="toggle"
      @keydown.down.prevent="expanded || toggle()"
    >
      <span aria-hidden="true">☰</span><span>菜单</span>
    </button>
    <div
      v-if="collapsed && expanded"
      :id="menuId"
      ref="panel"
      class="navigation-panel"
      :style="position"
      aria-label="大会菜单"
    >
      <a
        v-for="link in links"
        :key="link.id"
        :href="link.href"
        :aria-current="current(link)"
        :target="link.newWindow ? '_blank' : undefined"
        :rel="link.newWindow ? 'noopener noreferrer' : undefined"
        @click="close()"
      >
        {{ link.label }}<span v-if="link.newWindow" aria-label="新窗口打开">↗</span>
      </a>
    </div>
  </div>
</template>

<style scoped>
.conference-navigation {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  justify-content: center;
}
.conference-navigation.is-collapsed {
  justify-content: flex-end;
}
.conference-navigation .nav-links {
  display: flex;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}
.navigation-measure {
  position: fixed;
  left: 0;
  top: 0;
  transform: translateX(-110%);
  display: flex;
  gap: 6px;
  width: max-content;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
}
.navigation-measure > span {
  padding: 7px 12px;
  border: 1px solid transparent;
  font-size: 13.5px;
}
.navigation-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 40px;
  min-height: 40px;
  padding: 7px 10px;
  border: 1px solid var(--line, #dfe5ee);
  border-radius: 4px;
  background: var(--bg, #fff);
  color: var(--ink, #172033);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.navigation-toggle:active {
  transform: scale(0.96);
}
.navigation-panel {
  position: fixed;
  z-index: 150;
  box-sizing: border-box;
  display: grid;
  gap: 2px;
  max-height: calc(100dvh - 100px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  border: 1px solid var(--line, #dfe5ee);
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 24px rgb(17 28 48 / 12%);
}
.navigation-panel a {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 44px;
  padding: 8px 12px;
  color: var(--ink, #172033);
  text-decoration: none;
  font-size: 14px;
}
.navigation-panel a:active {
  background: #edf2fa;
}
.navigation-toggle:focus-visible,
.navigation-panel a:focus-visible,
.nav-links a:focus-visible {
  outline: 2px solid var(--accent, #1f5fe8);
  outline-offset: 2px;
}
@media (hover: hover) {
  .navigation-panel a:hover {
    background: #f0f4fa;
  }
}
@media (max-width: 390px) {
  .navigation-toggle {
    padding: 7px;
  }
  .navigation-toggle > span:first-child {
    display: none;
  }
}
</style>
