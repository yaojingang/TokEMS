<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    message?: string;
    error?: string;
  }>(),
  { message: '', error: '' },
);

const visible = ref(false);
const content = computed(() => props.error || props.message);
const tone = computed(() => (props.error ? 'error' : 'success'));
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  content,
  (value) => {
    if (timer) clearTimeout(timer);
    visible.value = Boolean(value);
    if (value && !props.error) {
      timer = setTimeout(() => {
        visible.value = false;
      }, 3_000);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="save-status-slot">
    <Transition name="save-status">
      <p
        v-if="visible && content"
        class="save-status"
        :class="tone"
        :role="tone === 'error' ? 'alert' : 'status'"
      >
        <span aria-hidden="true">{{ tone === 'error' ? '!' : '✓' }}</span>
        {{ content }}
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.save-status-slot {
  min-height: 30px;
  margin: 8px 0 12px;
}

.save-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--green);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.save-status.error {
  color: var(--red);
}

.save-status span {
  display: grid;
  width: 20px;
  height: 20px;
  color: var(--paper);
  background: var(--green);
  border-radius: var(--radius-pill);
  font-size: 11px;
  place-items: center;
}

.save-status.error span {
  background: var(--red);
}

.save-status-enter-active,
.save-status-leave-active {
  transition:
    opacity 140ms var(--ease),
    transform 140ms var(--ease);
}

.save-status-enter-from,
.save-status-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

@media (prefers-reduced-motion: reduce) {
  .save-status-enter-active,
  .save-status-leave-active {
    transition: none;
  }
}
</style>
