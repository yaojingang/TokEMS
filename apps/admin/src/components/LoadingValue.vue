<script setup lang="ts">
defineProps<{ loading: boolean; value?: string | number | null | undefined }>();
</script>

<template>
  <span v-if="loading" class="admin-skeleton admin-skeleton-number" role="status">
    <span class="sr-only">正在读取数据</span>
  </span>
  <template v-else>{{ value ?? '暂不可用' }}</template>
</template>
