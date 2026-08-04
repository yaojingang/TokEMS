<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { EventContextOption } from '@conference/contracts';
import { eventSwitcherGroups, filterEventOptions } from '../lib/event-switcher.js';
import { statusLabel } from '../lib/format.js';

const props = withDefaults(
  defineProps<{
    events: EventContextOption[];
    activeEvent?: EventContextOption | undefined;
    loading?: boolean;
  }>(),
  { activeEvent: undefined, loading: false },
);
const emit = defineEmits<{
  select: [event: EventContextOption];
  viewAll: [];
}>();

const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const closeButton = ref<HTMLButtonElement>();
const searchInput = ref<HTMLInputElement>();
const open = ref(false);
const query = ref('');
const panelId = `event-switcher-${useId()}`;
const searchable = computed(
  () => props.events.filter((event) => event.status !== 'archived').length > 8,
);
const groups = computed(() => eventSwitcherGroups(filterEventOptions(props.events, query.value)));

async function openPanel() {
  if (props.loading || !props.events.length) return;
  open.value = true;
  await nextTick();
  if (searchable.value) searchInput.value?.focus();
  else {
    const currentOption = root.value?.querySelector<HTMLButtonElement>(
      '.event-switcher-option[aria-current="true"]',
    );
    const firstOption = root.value?.querySelector<HTMLButtonElement>('.event-switcher-option');
    (currentOption ?? firstOption ?? closeButton.value)?.focus();
  }
}

function closePanel(restoreFocus = false) {
  open.value = false;
  query.value = '';
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}

function togglePanel() {
  if (open.value) closePanel();
  else void openPanel();
}

function selectEvent(event: EventContextOption) {
  closePanel(true);
  emit('select', event);
}

function handlePointerDown(event: PointerEvent) {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) {
    closePanel();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.stopImmediatePropagation();
    closePanel(true);
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('keydown', handleKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown);
  window.removeEventListener('keydown', handleKeydown, true);
});
</script>

<template>
  <section
    ref="root"
    class="event-context-switcher"
    :class="{ 'is-open': open }"
    aria-label="当前大会"
    lang="zh-CN"
  >
    <button
      ref="trigger"
      class="event-context-switcher__trigger"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-label="`当前大会：${activeEvent?.name ?? '大会不可用'}，打开大会切换器`"
      :disabled="loading || !events.length"
      @click.stop="togglePanel"
      @keydown.down.prevent="openPanel"
    >
      <span class="event-context-switcher__identity">
        <strong>{{ activeEvent?.name ?? (loading ? '正在载入大会…' : '大会不可用') }}</strong>
      </span>
      <span class="event-context-switcher__chevron" aria-hidden="true">
        <svg viewBox="0 0 14 8" focusable="false">
          <path d="M1 1l6 6 6-6" />
        </svg>
      </span>
    </button>

    <div
      v-if="open"
      :id="panelId"
      class="event-switcher-panel"
      role="dialog"
      aria-label="切换当前大会"
    >
      <div class="event-switcher-panel__head">
        <strong>切换大会</strong>
        <button
          ref="closeButton"
          type="button"
          aria-label="关闭大会切换器"
          @click="closePanel(true)"
        >
          ×
        </button>
      </div>
      <label v-if="searchable" class="event-switcher-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          aria-label="搜索大会"
          placeholder="搜索大会或城市"
        />
      </label>
      <div class="event-switcher-options">
        <section v-for="group in groups" :key="group.key">
          <span>{{ group.label }}</span>
          <button
            v-for="event in group.events"
            :key="event.id"
            class="event-switcher-option"
            type="button"
            :aria-current="event.id === activeEvent?.id ? 'true' : undefined"
            @click="selectEvent(event)"
          >
            <span>
              <strong>{{ event.name }}</strong>
              <small>
                {{ event.shortName }} · {{ event.city }} ·
                {{ statusLabel(event.status) }}
              </small>
            </span>
            <b v-if="event.id === activeEvent?.id" aria-hidden="true">✓</b>
          </button>
        </section>
        <p v-if="!groups.length" class="event-switcher-empty">没有匹配的大会</p>
      </div>
      <RouterLink
        class="event-switcher-panel__all"
        :to="{ name: 'manage-events' }"
        @click="emit('viewAll')"
      >
        查看全部大会 <span aria-hidden="true">→</span>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.event-context-switcher {
  position: relative;
  margin: 2px 4px 16px;
  color: var(--ink);
}

.event-context-switcher__trigger {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 56px;
  padding: 8px 8px 8px 10px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
  transition:
    color 160ms var(--ease),
    transform 160ms var(--ease);
}

.event-context-switcher__trigger:disabled {
  cursor: wait;
  opacity: 0.72;
}

.event-context-switcher__trigger:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.event-context-switcher__identity {
  display: grid;
  flex: 0 1 auto;
  min-width: 0;
}

.event-context-switcher__identity strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-context-switcher__chevron {
  display: grid;
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  place-items: center;
  color: var(--muted);
  border-radius: var(--radius-xs);
  transform-origin: center;
  transition:
    color 140ms var(--ease),
    transform 140ms var(--ease);
}

.event-context-switcher__chevron svg {
  display: block;
  width: 14px;
  height: 8px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.event-context-switcher.is-open .event-context-switcher__trigger {
  color: var(--blue);
}

.event-context-switcher.is-open .event-context-switcher__chevron {
  color: var(--blue);
  transform: rotate(180deg);
}

.event-switcher-panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 7px);
  left: 0;
  display: grid;
  width: 100%;
  max-height: min(520px, calc(100dvh - 120px));
  overflow: hidden;
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  box-shadow: 0 18px 42px rgb(13 28 43 / 20%);
  animation: event-switcher-in 140ms var(--ease);
}

.event-switcher-panel__head {
  display: flex;
  min-height: 45px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 8px 13px;
  border-bottom: 1px solid var(--line);
}

.event-switcher-panel__head strong {
  font-size: 11px;
}

.event-switcher-panel__head button {
  width: 44px;
  height: 44px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-radius: var(--radius-xs);
  font-size: 18px;
  cursor: pointer;
}

.event-switcher-search {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 8px;
  margin: 10px 10px 4px;
  padding: 0 10px;
  color: var(--muted);
  background: var(--admin-control-surface);
  border: 1px solid var(--admin-control-border);
  border-radius: var(--radius-xs);
}

.event-switcher-search input {
  min-width: 0;
  width: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 11px;
}

.event-switcher-options {
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
}

.event-switcher-options section {
  display: grid;
  gap: 2px;
}

.event-switcher-options section + section {
  margin-top: 8px;
}

.event-switcher-options section > span {
  padding: 5px 7px 3px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: var(--admin-font-micro);
  letter-spacing: 0.06em;
}

.event-switcher-option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 7px;
  color: var(--ink);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  cursor: pointer;
}

.event-switcher-option > span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.event-switcher-option small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-switcher-option strong {
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.event-switcher-option small {
  color: var(--muted);
  font-size: var(--admin-font-caption);
}

.event-switcher-option b {
  color: var(--blue);
}

.event-switcher-option[aria-current='true'] {
  background: var(--blue-soft);
  border-color: color-mix(in srgb, var(--blue) 22%, var(--line));
}

.event-switcher-panel__all {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  padding: 0 13px;
  color: var(--blue);
  border-top: 1px solid var(--line);
  font-size: 10px;
  font-weight: 700;
  text-decoration: none;
}

.event-switcher-empty {
  margin: 0;
  padding: 24px 12px;
  color: var(--muted);
  text-align: center;
  font-size: 10px;
}

@media (hover: hover) {
  .event-context-switcher__trigger:hover {
    color: var(--blue);
  }

  .event-context-switcher__trigger:hover .event-context-switcher__chevron {
    color: var(--blue);
  }

  .event-switcher-option:hover,
  .event-switcher-panel__head button:hover {
    color: var(--blue);
    background: var(--blue-soft);
  }

  .event-switcher-panel__all:hover {
    background: var(--blue-soft);
  }
}

.event-switcher-option:active,
.event-context-switcher__trigger:active,
.event-switcher-panel__all:active,
.event-switcher-panel__head button:active {
  transform: scale(0.96);
}

@keyframes event-switcher-in {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .event-switcher-panel {
    animation: none;
  }

  .event-context-switcher__chevron {
    transition: none;
  }
}

@media (max-width: 820px) {
  .event-switcher-panel {
    width: 100%;
    max-height: min(460px, calc(100dvh - 180px));
  }

  .event-switcher-search input {
    font-size: 16px;
  }
}
</style>
