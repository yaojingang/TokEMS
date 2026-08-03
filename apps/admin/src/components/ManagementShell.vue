<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { conferenceApi, session } from '../lib/api';
import AdminFrame from './AdminFrame.vue';

const route = useRoute();
const title = computed(() => String(route.meta.title ?? '管理中心'));
const code = computed(() => String(route.meta.code ?? 'MANAGEMENT'));
const accountScope = computed(() => route.meta.scope === 'account');
const scopeLabel = computed(() => (accountScope.value ? '个人账号' : '管理中心'));
const pendingInvoiceCount = ref(0);

const navigation = [
  { name: 'manage-events', icon: '◫', label: '大会管理', grants: ['event.read'] },
  { name: 'manage-users', icon: '◎', label: '用户管理', grants: ['customer.read'] },
  {
    name: 'manage-invoices',
    icon: '▤',
    label: '发票管理',
    grants: ['org.invoice.read'],
    badge: pendingInvoiceCount,
  },
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

onMounted(async () => {
  if (!session.can('org.invoice.read')) return;
  try {
    pendingInvoiceCount.value = (await conferenceApi.getInvoicePendingCount()).count;
  } catch {
    pendingInvoiceCount.value = 0;
  }
});
</script>

<template>
  <AdminFrame
    :title="title"
    :code="code"
    :scope-label="scopeLabel"
    :brand-to="{ name: session.managementLandingRouteName() }"
  >
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
            <b v-if="'badge' in item && item.badge.value" class="nav-count nav-count-alert">{{
              item.badge.value
            }}</b>
          </RouterLink>
        </nav>
      </div>
    </template>

    <RouterView />
  </AdminFrame>
</template>
