<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { isPublicEventStatus, type EventContextOption } from '@conference/contracts';
import { useRoute, useRouter } from 'vue-router';
import { publicEventPreviewUrl, session } from '../lib/api';
import { parseEventId } from '../lib/route-scope';
import AdminFrame from './AdminFrame.vue';
import EventSwitcher from './EventSwitcher.vue';
import EventContextEmptyView from '../views/EventContextEmptyView.vue';

const route = useRoute();
const router = useRouter();
const events = ref<EventContextOption[]>([]);
const loading = ref(true);
const loadFailed = ref(false);
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
  return event && isPublicEventStatus(event.status) ? publicEventPreviewUrl(event.slug) : undefined;
});
const contextUnavailable = computed(
  () => !loading.value && (loadFailed.value || !activeEvent.value),
);
const settingsSection = computed(() => route.path.includes('/settings'));

const navigation = computed(() => [
  {
    name: 'event-overview',
    match: '/overview',
    icon: '⌂',
    label: '数据概览',
    grants: ['event.dashboard.read'],
  },
  {
    name: session.canAny(['event.manage', 'event.site.read'])
      ? 'event-settings-general'
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
    name: 'event-registrations',
    match: '/registrations',
    icon: '▤',
    label: '报名管理',
    grants: ['event.registration.read'],
  },
  {
    name: 'event-invoices',
    match: '/invoices',
    icon: '¥',
    label: '发票管理',
    grants: ['org.invoice.read'],
  },
  {
    name: 'event-notifications',
    match: '/notifications',
    icon: '◌',
    label: '通知中心',
    grants: ['event.notification.read'],
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

onMounted(() => {
  void loadEvents();
});
</script>

<template>
  <AdminFrame
    :brand-to="{ name: session.eventLandingRouteName(), params: { eventId: routeEventId } }"
    :public-entry-url="publicEntryUrl"
  >
    <template #context="{ closeNavigation }">
      <div class="event-context">
        <RouterLink
          class="admin-system-entry"
          :to="{ name: 'manage-events' }"
          aria-label="进入系统管理"
          title="系统管理"
          @click="closeNavigation()"
        >
          <span aria-hidden="true">⌘</span>
          <strong>系统管理</strong>
          <span aria-hidden="true">→</span>
        </RouterLink>
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
          </RouterLink>
        </nav>
      </div>
    </template>

    <template #topbar-context>
      <EventSwitcher
        :events="events"
        :active-event="activeEvent"
        :loading="loading"
        @select="switchEvent"
      />
    </template>

    <template #topbar-actions>
      <RouterLink
        v-if="session.can('event.notification.read')"
        class="admin-topbar-action admin-topbar-action--icon"
        :to="eventRoute('event-notifications')"
        aria-label="消息通知"
        title="消息通知"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
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
      <div v-if="settingsSection" class="event-settings-view">
        <nav class="event-secondary-nav" aria-label="大会配置分区">
          <RouterLink
            v-if="session.canAny(['event.manage', 'event.site.read'])"
            :to="eventRoute('event-settings-general')"
          >
            基本信息
          </RouterLink>
          <RouterLink
            v-if="
              session.canAny([
                'event.manage',
                'event.site.read',
                'event.registration.manage',
                'event.inventory.read',
                'event.inventory.manage',
              ])
            "
            :to="eventRoute('event-settings-registration')"
          >
            报名设置
          </RouterLink>
          <RouterLink
            v-if="session.can('event.registration.manage')"
            :to="eventRoute('event-settings-form')"
          >
            表单与条款
          </RouterLink>
          <RouterLink
            v-if="session.canAny(['event.site.read', 'event.registration.manage'])"
            :to="eventRoute('event-settings-changes')"
          >
            修改记录
          </RouterLink>
        </nav>
        <RouterView :key="routeEventId ?? 'invalid-event'" />
      </div>
      <RouterView v-else :key="routeEventId ?? 'invalid-event'" />
    </template>
  </AdminFrame>
</template>
