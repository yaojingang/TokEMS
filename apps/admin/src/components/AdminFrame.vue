<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { useRoute, useRouter } from 'vue-router';
import { session } from '../lib/api';
import { organizationRoleLabel } from '../lib/roles';

const props = defineProps<{
  brandTo: RouteLocationRaw;
  publicEntryUrl?: string | undefined;
}>();

const route = useRoute();
const router = useRouter();
const navigationOpen = ref(false);
const navigationTrigger = ref<HTMLButtonElement>();
const navigationPanel = ref<HTMLElement>();
const accountMenuOpen = ref(false);
const accountArea = ref<HTMLElement>();
const accountTrigger = ref<HTMLButtonElement>();
const accountMenu = ref<HTMLElement>();
const accountRole = computed(() => organizationRoleLabel(session.identity.value?.membership.role));
const accountInitial = computed(() => session.user.value?.name.trim().charAt(0) || '管');
const accountRoute = computed<RouteLocationRaw>(() => ({
  name: 'account-profile',
  ...(route.name === 'account-profile' ? {} : { query: { from: route.fullPath } }),
}));

function closeNavigation(restoreFocus = false) {
  navigationOpen.value = false;
  if (restoreFocus) void nextTick(() => navigationTrigger.value?.focus());
}

async function toggleNavigation() {
  closeAccountMenu();
  navigationOpen.value = !navigationOpen.value;
  if (!navigationOpen.value) return;
  await nextTick();
  navigationPanel.value?.querySelector<HTMLElement>('a, button, select')?.focus();
}

function closeAccountMenu(restoreFocus = false) {
  accountMenuOpen.value = false;
  if (restoreFocus) void nextTick(() => accountTrigger.value?.focus());
}

async function toggleAccountMenu() {
  accountMenuOpen.value = !accountMenuOpen.value;
  if (!accountMenuOpen.value) return;
  await nextTick();
  accountMenu.value?.querySelector<HTMLElement>('a, button')?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (accountMenuOpen.value) {
    closeAccountMenu(true);
    return;
  }
  if (navigationOpen.value) closeNavigation(true);
}

function handlePointerDown(event: PointerEvent) {
  if (
    accountMenuOpen.value &&
    event.target instanceof Node &&
    !accountArea.value?.contains(event.target)
  ) {
    closeAccountMenu();
  }
}

async function logout() {
  closeAccountMenu();
  session.clear();
  await router.push({ name: 'login' });
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  document.addEventListener('pointerdown', handlePointerDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('pointerdown', handlePointerDown);
});
</script>

<template>
  <a class="skip-link" href="#admin-content">跳到主要内容</a>
  <div class="admin-layout" :class="{ 'admin-navigation-open': navigationOpen }">
    <aside id="admin-navigation" ref="navigationPanel" class="admin-sidebar" aria-label="后台导航">
      <RouterLink
        class="admin-brand"
        :to="brandTo"
        aria-label="TokEMS 首页"
        @click="closeNavigation()"
      >
        <span class="brand-copy"><strong>TokEMS</strong></span>
      </RouterLink>

      <slot name="context" :close-navigation="closeNavigation" />
      <div class="admin-navigation">
        <slot name="navigation" :close-navigation="closeNavigation" />
      </div>

      <div ref="accountArea" class="admin-user-area">
        <div
          v-if="accountMenuOpen"
          id="admin-account-menu"
          ref="accountMenu"
          class="admin-account-menu"
          role="menu"
          aria-label="当前账号"
        >
          <div class="admin-account-menu__identity">
            <span class="admin-account-avatar" aria-hidden="true">{{ accountInitial }}</span>
            <span>
              <strong>{{ session.user.value?.name ?? '大会运营管理员' }}</strong>
              <small>{{ session.user.value?.username ?? session.user.value?.email }}</small>
              <em>{{ accountRole }}</em>
            </span>
          </div>
          <RouterLink
            class="admin-account-menu__item"
            :to="accountRoute"
            role="menuitem"
            @click="
              closeAccountMenu();
              closeNavigation();
            "
          >
            <span>个人中心</span>
            <span aria-hidden="true">→</span>
          </RouterLink>
          <a
            class="admin-account-menu__item"
            href="https://github.com/yaojingang/TokEMS"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
          >
            <span>源代码与 AGPL-3.0 许可证</span>
            <span aria-hidden="true">↗</span>
          </a>
          <button
            class="admin-account-menu__item admin-account-menu__logout"
            type="button"
            role="menuitem"
            @click="logout"
          >
            退出登录
          </button>
        </div>
        <button
          ref="accountTrigger"
          class="admin-user-trigger"
          :class="{ 'is-active': accountMenuOpen || route.name === 'account-profile' }"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="accountMenuOpen"
          aria-controls="admin-account-menu"
          :aria-label="`${session.user.value?.name ?? '大会运营管理员'}，${accountRole}，打开账号菜单`"
          @click.stop="toggleAccountMenu"
        >
          <span class="admin-user-copy">
            <strong>{{ session.user.value?.name ?? '大会运营管理员' }}</strong>
            <small>{{ accountRole }}</small>
          </span>
          <span class="admin-user-chevron" aria-hidden="true">⌃</span>
        </button>
      </div>
    </aside>
    <button
      v-if="navigationOpen"
      class="admin-navigation-scrim"
      type="button"
      aria-label="关闭导航"
      @click="closeNavigation(true)"
    ></button>
    <div class="admin-sidebar-resizer" aria-hidden="true"></div>

    <div class="admin-workspace">
      <header
        class="admin-topbar"
        :class="{
          'has-topbar-tools':
            props.publicEntryUrl || $slots['topbar-context'] || $slots['topbar-actions'],
        }"
      >
        <button
          ref="navigationTrigger"
          class="admin-navigation-trigger"
          type="button"
          :aria-expanded="navigationOpen"
          aria-controls="admin-navigation"
          :aria-label="navigationOpen ? '关闭导航' : '打开导航'"
          @click="toggleNavigation"
        >
          <span aria-hidden="true">≡</span>
        </button>
        <div v-if="$slots['topbar-context']" class="admin-topbar-context">
          <slot name="topbar-context" />
        </div>
        <div class="topbar-tools">
          <slot name="topbar-actions" />
          <a
            v-if="props.publicEntryUrl"
            class="admin-topbar-action"
            :href="props.publicEntryUrl"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="访问大会前台，在新标签页打开"
            title="访问大会前台"
          >
            <span class="admin-topbar-action__label">访问前台</span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>
      <main class="admin-content" id="admin-content">
        <slot />
      </main>
    </div>
  </div>
</template>
