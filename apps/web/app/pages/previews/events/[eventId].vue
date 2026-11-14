<script setup lang="ts">
import { definePageMeta, createError, useSeoMeta, useRoute } from '#imports';
import ConferenceHome from '../../[[eventSlug]].vue';

definePageMeta({ publicEventHome: false });
const route = useRoute();
const eventId = Number(route.params.eventId);
const token = typeof route.query.token === 'string' ? route.query.token : '';
if (!Number.isSafeInteger(eventId) || eventId < 1 || !token) {
  throw createError({ statusCode: 400, statusMessage: '预览链接无效' });
}
useSeoMeta({ robots: 'noindex, nofollow, noarchive' });
</script>

<template>
  <div class="template-preview">
    <div class="template-preview-notice" role="status">候选模板预览 · 报名与支付已停用</div>
    <div inert><ConferenceHome :preview-event-id="eventId" :preview-token="token" /></div>
  </div>
</template>

<style scoped>
.template-preview-notice {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  max-width: calc(100vw - 32px);
  padding: 12px 18px;
  color: #fff;
  background: #172438;
  border-radius: 4px;
  font: 13px/1.5 system-ui, sans-serif;
  text-align: center;
  pointer-events: none;
}
</style>
