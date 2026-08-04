<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { session } from '../lib/api';
import AdminFrame from './AdminFrame.vue';

const route = useRoute();

const navigation = [
  { name: 'manage-events', icon: '◫', label: '大会管理', grants: ['event.read'] },
  { name: 'manage-users', icon: '◎', label: '用户管理', grants: ['customer.read'] },
  {
    name: 'manage-templates',
    icon: '▧',
    label: '模板管理',
    grants: ['org.template.read'],
  },
  {
    name: 'manage-settings',
    icon: '◇',
    label: '系统设置',
    grants: ['org.settings.read', 'org.member.read'],
  },
];
const visibleNavigation = computed(() => navigation.filter((item) => session.canAny(item.grants)));
function isNavigationActive(name: string) {
  return (
    route.name === name ||
    (name === 'manage-settings' && String(route.name ?? '').startsWith('manage-settings-')) ||
    (name === 'manage-templates' && route.name === 'manage-template-editor')
  );
}
</script>

<template>
  <AdminFrame :brand-to="{ name: session.managementLandingRouteName() }">
    <template #navigation="{ closeNavigation }">
      <div class="admin-nav-section">
        <span class="admin-nav-label">MANAGEMENT</span>
        <nav class="admin-nav" aria-label="管理中心导航">
          <RouterLink
            v-for="item in visibleNavigation"
            :key="item.name"
            :to="{ name: item.name }"
            :aria-current="isNavigationActive(item.name) ? 'page' : undefined"
            @click="closeNavigation()"
          >
            <span class="admin-nav-icon">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>
        </nav>
      </div>
    </template>

    <RouterView />
  </AdminFrame>
</template>
