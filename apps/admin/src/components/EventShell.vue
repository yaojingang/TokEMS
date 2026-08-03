<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { isPublicEventStatus, type EventContextOption } from '@conference/contracts';
import { useRoute, useRouter } from 'vue-router';
import { publicEventHomeUrl, session } from '../lib/api';
import { parseEventId } from '../lib/route-scope';
import AdminFrame from './AdminFrame.vue';
import EventSwitcher from './EventSwitcher.vue';
import EventContextEmptyView from '../views/EventContextEmptyView.vue';

const route = useRoute();
const router = useRouter();
const events = ref<EventContextOption[]>([]);
const loading = ref(true);
const loadFailed = ref(false);
const registrationSearch = ref('');
const registrationSearchInput = ref<HTMLInputElement>();
const title = computed(() => String(route.meta.title ?? '大会工作台'));
const code = computed(() => String(route.meta.code ?? 'EVENT'));
const routeEventId = computed(() => {
  const value = Array.isArray(route.params.eventId)
    ? route.params.eventId[0]
    : route.params.eventId;
  return parseEventId(value);
});
const activeEvent = computed(() =>
  session.activeEvent.value?.id === routeEventId.value
    ? session.activeEvent.value
    : events.value.find((item) => item.id === routeEventId.value),
);
const publicEntryUrl = computed(() => {
  const event = activeEvent.value;
  return event && isPublicEventStatus(event.status) ? publicEventHomeUrl(event.slug) : undefined;
});
const contextUnavailable = computed(
  () => !loading.value && (loadFailed.value || !activeEvent.value),
);
const settingsSection = computed(() => route.path.includes('/settings'));
const contentSection = computed(() => route.path.includes('/content'));

const navigation = computed(() => [
  {
    name: 'event-overview',
    match: '/overview',
    icon: '⌂',
    label: '大会概览',
    grants: ['event.dashboard.read'],
  },
  {
    name: session.can('event.manage')
      ? 'event-settings-general'
      : session.can('event.site.read')
        ? 'event-settings-site'
        : 'event-settings-registration',
    match: '/settings',
    icon: '◇',
    label: '大会配置',
    grants: [
      'event.manage',
      'event.site.read',
      'event.registration.manage',
      'event.inventory.read',
      'event.inventory.manage',
    ],
  },
  {
    name: session.can('event.content.manage') ? 'event-content' : 'event-ai',
    match: '/content',
    icon: '#',
    label: '内容运营',
    grants: ['event.content.manage', 'event.ai.read'],
  },
  {
    name: 'event-registrations',
    match: '/registrations',
    icon: '▤',
    label: '报名管理',
    grants: ['event.registration.read'],
  },
  {
    name: 'event-orders',
    match: '/orders',
    icon: '¥',
    label: '订单与退款',
    grants: ['event.order.read'],
  },
  {
    name: 'event-notifications',
    match: '/notifications',
    icon: '◌',
    label: '通知中心',
    grants: ['event.notification.read'],
  },
  {
    name: 'event-check-in',
    match: '/check-in',
    icon: '✓',
    label: '现场签到',
    grants: ['event.checkin.execute', 'event.checkin.manage'],
  },
]);
const visibleNavigation = computed(() =>
  navigation.value.filter((item) => session.canAny(item.grants)),
);

function isActive(match: string) {
  return route.path.includes(`/events/${routeEventId.value}${match}`);
}

function eventRoute(name: string) {
  return { name, params: { eventId: routeEventId.value } };
}

async function loadEvents() {
  loading.value = true;
  loadFailed.value = false;
  try {
    events.value = await session.loadEventOptions();
    const selected = events.value.find((item) => item.id === routeEventId.value);
    const routeWasRemembered =
      Boolean(routeEventId.value) && session.recentEventId() === routeEventId.value;
    if ((!selected || selected.status === 'archived') && routeWasRemembered) {
      session.forgetRecentEvent();
      if (session.identity.value?.adminPreferences.lastEventId === routeEventId.value) {
        session.clearServerRecentEvent();
      }
      session.entryNotice.value = selected
        ? '当前大会已归档，已从最近大会中移除。'
        : '当前大会已不可用，已从最近大会中移除。';
    }
    if (selected) {
      session.setRuntimeEvent(selected);
      if (session.consumeExplicitEventRoute(selected.id)) session.rememberEvent(selected);
    } else {
      if (routeEventId.value) session.consumeExplicitEventRoute(routeEventId.value);
      session.setRuntimeEvent(undefined);
    }
  } catch {
    events.value = [];
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

async function switchEvent(event: EventContextOption) {
  session.rememberEvent(event);
  await router.push({
    name: session.eventLandingRouteName(),
    params: { eventId: event.id },
  });
}

function submitRegistrationSearch() {
  const normalized = registrationSearch.value.trim();
  void router.push({
    name: 'event-registrations',
    params: { eventId: routeEventId.value },
    query: normalized ? { q: normalized } : {},
  });
}

function handleShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    registrationSearchInput.value?.focus();
  }
}

watch(
  routeEventId,
  (eventId) => {
    if (events.value.length) {
      const selected = events.value.find((item) => item.id === eventId);
      session.setRuntimeEvent(selected);
    }
  },
  { immediate: true },
);

watch(session.activeEvent, (updated) => {
  if (!updated) return;
  events.value = events.value.map((event) => (event.id === updated.id ? updated : event));
});

watch(
  () => route.query.q,
  (query) => {
    if (route.name === 'event-registrations') {
      registrationSearch.value = String(query ?? '');
    }
  },
  { immediate: true },
);

onMounted(() => {
  void loadEvents();
  window.addEventListener('keydown', handleShortcut);
});
onBeforeUnmount(() => window.removeEventListener('keydown', handleShortcut));
</script>

<template>
  <AdminFrame
    :title="title"
    :code="code"
    :scope-label="activeEvent?.name ?? '大会工作台'"
    :brand-to="{ name: session.eventLandingRouteName(), params: { eventId: routeEventId } }"
    :public-entry-url="publicEntryUrl"
  >
    <template #context>
      <div class="event-context">
        <EventSwitcher
          :events="events"
          :active-event="activeEvent"
          :loading="loading"
          @select="switchEvent"
        />
      </div>
    </template>

    <template #navigation="{ closeNavigation }">
      <div class="admin-nav-section">
        <span class="admin-nav-label">EVENT WORKSPACE</span>
        <nav class="admin-nav" aria-label="大会工作台导航">
          <RouterLink
            v-for="item in visibleNavigation"
            :key="item.name"
            :to="eventRoute(item.name)"
            :aria-current="isActive(item.match) ? 'page' : undefined"
            @click="closeNavigation()"
          >
            <span class="admin-nav-icon">{{ item.icon }}</span><span>{{ item.label }}</span>
            <span
              v-if="item.name === 'event-registrations' && activeEvent?.registrationCount"
              class="nav-count"
            >
              {{ activeEvent.registrationCount }}
            </span>
          </RouterLink>
        </nav>
      </div>
      <div class="admin-nav-section event-management-entry">
        <span class="admin-nav-label">ORGANIZATION</span>
        <nav class="admin-nav" aria-label="组织管理入口">
          <RouterLink :to="{ name: 'manage-events' }" @click="closeNavigation()">
            <span class="admin-nav-icon">⌘</span>
            <span>管理中心</span>
            <span aria-hidden="true">→</span>
          </RouterLink>
        </nav>
      </div>
    </template>

    <template #topbar-center>
      <form
        v-if="session.can('event.registration.read')"
        class="admin-command admin-command-search"
        role="search"
        @submit.prevent="submitRegistrationSearch"
      >
        <span aria-hidden="true">⌕</span>
        <input
          ref="registrationSearchInput"
          v-model="registrationSearch"
          type="search"
          aria-label="搜索报名信息"
          placeholder="搜索姓名、公司、手机号或报名码"
          @keydown.enter.prevent="submitRegistrationSearch"
        />
        <kbd aria-hidden="true">⌘ K</kbd>
        <button class="admin-command-search__submit" type="submit" aria-label="执行报名搜索">
          →
        </button>
      </form>
    </template>

    <template #topbar-actions>
      <RouterLink
        v-if="session.can('event.audit.read')"
        class="tool-button"
        :to="eventRoute('event-activity')"
        aria-label="查看操作记录"
        title="操作记录"
      >
        ⌁
      </RouterLink>
    </template>

    <div v-if="session.entryNotice.value" class="admin-context-notice" role="status">
      <span>{{ session.entryNotice.value }}</span>
      <button type="button" aria-label="关闭提示" @click="session.entryNotice.value = ''">×</button>
    </div>
    <div v-if="loading" class="admin-loading">正在载入大会工作台…</div>
    <EventContextEmptyView
      v-else-if="contextUnavailable"
      :load-failed="loadFailed"
      :event-id="routeEventId"
    />
    <template v-else>
      <nav v-if="settingsSection" class="event-secondary-nav" aria-label="大会配置分区">
        <RouterLink v-if="session.can('event.manage')" :to="eventRoute('event-settings-general')">
          基本信息
        </RouterLink>
        <RouterLink v-if="session.can('event.site.read')" :to="eventRoute('event-settings-site')">
          前台与模板
        </RouterLink>
        <RouterLink
          v-if="
            session.canAny([
              'event.manage',
              'event.registration.manage',
              'event.inventory.read',
              'event.inventory.manage',
            ])
          "
          :to="eventRoute('event-settings-registration')"
        >
          报名与票务
        </RouterLink>
        <RouterLink
          v-if="session.can('event.registration.manage')"
          :to="eventRoute('event-settings-form')"
        >
          表单与条款
        </RouterLink>
      </nav>
      <nav v-if="contentSection" class="event-secondary-nav" aria-label="内容运营分区">
        <RouterLink v-if="session.can('event.content.manage')" :to="eventRoute('event-content')">
          嘉宾与议程
        </RouterLink>
        <RouterLink v-if="session.can('event.ai.read')" :to="eventRoute('event-ai')">
          AI 文案
        </RouterLink>
      </nav>
      <RouterView :key="routeEventId ?? 'invalid-event'" />
    </template>
  </AdminFrame>
</template>
