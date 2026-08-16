<script setup lang="ts">
defineProps<{ error: { statusCode?: number; message?: string } }>();
</script>

<template>
  <main class="error-page" id="main-content">
    <NuxtLink class="brand-inline" to="/">GEO大会 · 2026</NuxtLink>
    <p class="eyebrow">PAGE NOT FOUND</p>
    <h1>这条路线暂时没有安排</h1>
    <p>页面可能已移动，返回大会首页可以继续查看议程、嘉宾和门票。</p>
    <NuxtLink class="action-button" to="/">返回大会首页</NuxtLink>
  </main>
</template>
