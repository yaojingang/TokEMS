<script setup lang="ts">
import type { CustomerServiceHubItemCode } from '@conference/contracts';

defineProps<{ code: CustomerServiceHubItemCode }>();
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="code === 'ticket'">
      <path d="M4 6.5h16v3a2.5 2.5 0 0 0 0 5v3H4v-3a2.5 2.5 0 0 0 0-5v-3Z" />
      <path d="M14.5 8.5v1M14.5 12v1M14.5 15.5v.1" />
    </template>
    <template v-else-if="code === 'poster'">
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <circle cx="9" cy="8.5" r="1.5" />
      <path d="m6.5 17 4-4 2.5 2.5 2-2 2.5 3" />
    </template>
    <template v-else-if="code === 'showcase'">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="11" r="2.2" />
      <path d="M5.8 16c.8-1.5 1.9-2.2 3.2-2.2s2.4.7 3.2 2.2M14.5 9h3M14.5 12h3M14.5 15h2" />
    </template>
    <template v-else-if="code === 'needs'">
      <path d="M5 4.5h14v11H9l-4 4v-15Z" />
      <path d="M8.5 8.5h7M8.5 12h4.5" />
    </template>
    <template v-else-if="code === 'organizer_contact'">
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.8 19c.5-3.3 2.2-5 5.2-5s4.7 1.7 5.2 5M17.5 8v6M14.5 11h6" />
    </template>
    <template v-else>
      <path d="M6 3.5h9l3 3V20.5H6v-17Z" />
      <path d="M15 3.5v3h3M9 11h6M9 14.5h6M9 18h4" />
    </template>
  </svg>
</template>
