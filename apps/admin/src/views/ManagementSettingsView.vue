<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { session } from '../lib/api';
import { provideSettingsFormState } from '../composables/settings-form-state';

type SettingsItem = {
  name: string;
  label: string;
  grants: string[];
};

const route = useRoute();
const router = useRouter();
const formState = provideSettingsFormState();

const items: SettingsItem[] = [
  {
    name: 'manage-settings-website',
    label: '公开网站',
    grants: ['org.settings.read'],
  },
  {
    name: 'manage-settings-payment',
    label: '支付服务',
    grants: ['org.settings.read'],
  },
  {
    name: 'manage-settings-sms',
    label: '短信服务',
    grants: ['org.settings.read'],
  },
  {
    name: 'manage-settings-customers',
    label: '账号与合规',
    grants: ['org.settings.read'],
  },
  {
    name: 'manage-settings-team',
    label: '管理员与权限',
    grants: ['org.member.read'],
  },
];

const visibleItems = computed(() => items.filter((item) => session.canAny(item.grants)));

function confirmUnsavedChanges() {
  if (formState.busy.value) {
    window.alert('设置正在保存，请等待操作完成后再离开。');
    return false;
  }
  return (
    !formState.dirty.value ||
    window.confirm('当前设置有未保存的更改。离开后这些更改会丢失，确定继续吗？')
  );
}

async function navigateFromSelect(event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  const name = select.value;
  if (!name || name === route.name) return;
  const failure = await router.push({ name });
  if (failure) select.value = String(route.name ?? '');
}

function markFormDirty(event: Event) {
  const target = event.target;
  if (target instanceof Element && target.closest('form[data-settings-form]')) {
    formState.markDirty();
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!formState.dirty.value && !formState.busy.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteUpdate((to, from) => {
  if (to.name === from.name) return true;
  return confirmUnsavedChanges();
});
onBeforeRouteLeave(() => confirmUnsavedChanges());

onMounted(() => window.addEventListener('beforeunload', handleBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload));
</script>

<template>
  <header class="settings-page-head reveal is-visible">
    <div>
      <p class="eyebrow">ORGANIZATION CONTROL</p>
      <p class="settings-page-title">系统设置</p>
      <p>管理账号合规、服务连接与管理员访问权限。</p>
    </div>
  </header>

  <nav class="settings-tabs" aria-label="系统设置模块">
    <RouterLink v-for="item in visibleItems" :key="item.name" :to="{ name: item.name }">
      {{ item.label }}
    </RouterLink>
  </nav>

  <label class="settings-mobile-switcher">
    <span>当前设置模块</span>
    <select :value="String(route.name ?? '')" @change="navigateFromSelect">
      <option v-for="item in visibleItems" :key="String(item.name)" :value="String(item.name)">
        {{ item.label }}
      </option>
    </select>
  </label>

  <section
    class="settings-detail"
    aria-label="设置详情"
    @input.capture="markFormDirty"
    @change.capture="markFormDirty"
  >
    <RouterView />
  </section>
</template>
