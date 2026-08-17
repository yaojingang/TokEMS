<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

defineProps<{ cooperationCount?: number }>();

const route = useRoute();
const eventId = computed(() => route.params.eventId);
const cooperationActive = computed(() => route.name === 'event-cooperation-requests');
</script>

<template>
  <nav class="registration-tabs" aria-label="报名管理分类">
    <RouterLink
      class="registration-tab"
      :class="{ active: !cooperationActive }"
      :aria-current="!cooperationActive ? 'page' : undefined"
      :to="{ name: 'event-registrations', params: { eventId }, query: route.query }"
    >
      报名记录
    </RouterLink>
    <RouterLink
      class="registration-tab"
      :class="{ active: cooperationActive }"
      :aria-current="cooperationActive ? 'page' : undefined"
      :to="{ name: 'event-cooperation-requests', params: { eventId } }"
    >
      合作申请
      <b v-if="cooperationCount !== undefined">{{ cooperationCount }}</b>
    </RouterLink>
  </nav>
</template>

<style scoped>
.registration-tabs {
  display: flex;
  gap: 4px;
  margin: -2px 0 16px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
}

.registration-tab {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-radius: var(--radius-xs);
  color: var(--muted);
  font-size: var(--admin-font-control);
  font-weight: 680;
  text-decoration: none;
  transition:
    color 140ms var(--ease),
    background-color 140ms var(--ease),
    transform 140ms var(--ease);
}

.registration-tab:hover {
  color: var(--ink);
  background: var(--surface-muted);
}

.registration-tab:active {
  transform: scale(0.98);
}

.registration-tab.active {
  color: #fff;
  background: var(--blue);
}

.registration-tab b {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 18%);
  font-family: var(--mono);
  font-size: 9px;
  text-align: center;
}

@media (max-width: 520px) {
  .registration-tabs,
  .registration-tab {
    width: 100%;
  }

  .registration-tab {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .registration-tab {
    transition: none;
  }
}
</style>
