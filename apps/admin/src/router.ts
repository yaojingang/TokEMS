import { createRouter, createWebHistory, type RouteLocationRaw } from 'vue-router';
import { conferenceApi, session } from './lib/api';
import {
  adminEntryPreferenceNotice,
  hasEventWorkspaceLanding,
  resolveAdminEntry,
  safeRedirectPath,
} from './lib/admin-entry';
import { parseEventId } from './lib/route-scope';
import { createRouteLoadRecovery } from './lib/route-load-recovery';
import { legacyContentWorkspaceRoute } from './lib/legacy-content-route';

function recentEventRoute(
  name: string,
  query: Record<string, string | string[]> = {},
  hash = '',
): RouteLocationRaw {
  const eventId = session.activeEventId.value;
  if (!eventId) return { name: 'login' };
  return {
    name,
    params: { eventId },
    query,
    ...(hash ? { hash } : {}),
  };
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(to) {
    if (to.hash) return { el: to.hash, top: 96 };
    return { top: 0 };
  },
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true, title: '运营人员登录' },
    },
    {
      path: '/accept-invitation',
      name: 'accept-invitation',
      component: () => import('./views/AcceptInvitationView.vue'),
      meta: { public: true, title: '接受组织邀请' },
    },
    { path: '/', redirect: { name: 'login' } },
    {
      path: '/manage',
      component: () => import('./components/ManagementShell.vue'),
      meta: { scope: 'management' },
      children: [
        { path: '', redirect: { name: 'login' } },
        {
          path: 'events',
          name: 'manage-events',
          component: () => import('./views/EventsView.vue'),
          meta: { title: '大会管理', code: 'EVENTS', requiredGrants: ['event.read'] },
        },
        {
          path: 'users',
          name: 'manage-users',
          component: () => import('./views/CustomerUsersView.vue'),
          meta: {
            title: '用户管理',
            code: 'USERS',
            requiredGrants: ['customer.read'],
          },
        },
        {
          path: 'members',
          redirect: { name: 'manage-settings-team' },
        },
        {
          path: 'invoices/:invoiceId?',
          redirect: (to) => {
            const queryValue = Array.isArray(to.query.eventId)
              ? to.query.eventId[0]
              : to.query.eventId;
            const explicitEventId = parseEventId(queryValue ?? undefined);
            const eventId = explicitEventId ?? session.activeEventId.value;
            if (!eventId) return { name: 'manage-events' };
            const query = { ...to.query };
            delete query.eventId;
            if (!explicitEventId && to.params.invoiceId) {
              session.entryNotice.value = '旧发票详情地址缺少大会信息，已进入最近大会的发票列表。';
            }
            return {
              name: 'event-invoices',
              params: {
                eventId,
                ...(explicitEventId && to.params.invoiceId
                  ? { invoiceId: to.params.invoiceId }
                  : {}),
              },
              query,
            };
          },
        },
        {
          path: 'templates',
          name: 'manage-templates',
          component: () => import('./views/TemplatesView.vue'),
          meta: { title: '模板管理', code: 'TEMPLATES', requiredGrants: ['org.template.read'] },
        },
        {
          path: 'templates/new',
          name: 'manage-template-create',
          component: () => import('./views/TemplateCreateView.vue'),
          meta: {
            title: '新建模板',
            code: 'CREATE TEMPLATE',
            requiredGrants: ['org.template.manage'],
          },
        },
        {
          path: 'templates/:templateId/html',
          name: 'manage-html-template-editor',
          component: () => import('./views/HtmlTemplateEditorView.vue'),
          meta: {
            title: 'HTML 模板编辑',
            code: 'HTML TEMPLATE',
            requiredGrants: ['org.template.read'],
          },
        },
        {
          path: 'templates/:templateId',
          name: 'manage-template-editor',
          component: () => import('./views/TemplateEditorView.vue'),
          meta: {
            title: '模板编辑',
            code: 'TEMPLATE EDITOR',
            requiredGrants: ['org.template.read'],
          },
        },
        {
          path: 'settings',
          name: 'manage-settings',
          component: () => import('./views/ManagementSettingsView.vue'),
          meta: {
            title: '系统设置',
            code: 'SYSTEM',
            requiredGrants: ['org.settings.read', 'org.member.read'],
          },
          children: [
            {
              path: 'general',
              name: 'manage-settings-general',
              redirect: { name: 'manage-settings' },
            },
            {
              path: 'website',
              name: 'manage-settings-website',
              component: () => import('./views/ManagementWebsiteSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
            },
            {
              path: 'payment',
              name: 'manage-settings-payment',
              component: () => import('./views/ManagementPaymentSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
            },
            {
              path: 'sms',
              name: 'manage-settings-sms',
              component: () => import('./views/ManagementSmsSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
            },
            {
              path: 'analytics',
              name: 'manage-settings-analytics',
              redirect: { name: 'manage-settings' },
            },
            {
              path: 'integrations',
              name: 'manage-settings-integrations',
              redirect: { name: 'manage-settings' },
            },
            {
              path: 'customers',
              name: 'manage-settings-customers',
              component: () => import('./views/ManagementCustomerSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
            },
            {
              path: 'team',
              name: 'manage-settings-team',
              component: () => import('./views/OrganizationView.vue'),
              meta: { requiredGrants: ['org.member.read'] },
            },
          ],
        },
      ],
    },
    {
      path: '/account',
      component: () => import('./components/ManagementShell.vue'),
      meta: { scope: 'account' },
      children: [
        {
          path: '',
          name: 'account-profile',
          component: () => import('./views/AccountProfileView.vue'),
          meta: { title: '个人中心', code: 'ACCOUNT' },
        },
      ],
    },
    {
      path: '/events/:eventId',
      component: () => import('./components/EventShell.vue'),
      meta: { scope: 'event' },
      children: [
        {
          path: '',
          redirect: (to) =>
            session.identity.value
              ? {
                  name: session.eventLandingRouteName(),
                  params: to.params,
                }
              : {
                  name: 'login',
                  query: { redirect: to.fullPath },
                },
        },
        {
          path: 'overview',
          name: 'event-overview',
          component: () => import('./views/DashboardView.vue'),
          meta: {
            title: '数据概览',
            code: 'OVERVIEW',
            requiredGrants: ['event.dashboard.read'],
          },
        },
        {
          path: 'settings',
          redirect: (to) =>
            session.identity.value
              ? {
                  name: session.can('event.manage')
                    ? 'event-settings-general'
                    : session.can('event.site.read')
                      ? 'event-settings-general'
                      : 'event-settings-registration',
                  params: to.params,
                }
              : {
                  name: 'login',
                  query: { redirect: to.fullPath },
                },
        },
        {
          path: 'settings/general',
          name: 'event-settings-general',
          component: () => import('./views/EventView.vue'),
          meta: {
            title: '大会配置',
            code: 'GENERAL',
            requiredGrants: ['event.manage', 'event.site.read'],
          },
        },
        {
          path: 'settings/site',
          name: 'event-settings-site',
          redirect: (to) => ({
            name: 'event-settings-general',
            params: to.params,
            query: to.query,
            hash: '#public-page',
          }),
        },
        {
          path: 'settings/registration',
          name: 'event-settings-registration',
          component: () => import('./views/EventRegistrationSettingsView.vue'),
          meta: {
            title: '大会配置',
            code: 'REGISTRATION',
            requiredGrants: [
              'event.manage',
              'event.site.read',
              'event.registration.manage',
              'event.inventory.read',
              'event.inventory.manage',
            ],
          },
        },
        {
          path: 'settings/form',
          name: 'event-settings-form',
          component: () => import('./views/FormsView.vue'),
          meta: {
            title: '大会配置',
            code: 'FORM',
            requiredGrants: ['event.registration.manage'],
          },
        },
        {
          path: 'settings/changes',
          name: 'event-settings-changes',
          component: () => import('./views/EventChangesView.vue'),
          meta: {
            title: '大会配置',
            code: 'CHANGES',
            requiredGrants: ['event.site.read', 'event.registration.manage'],
          },
        },
        {
          path: 'settings/content',
          name: 'event-content',
          redirect: (to) =>
            legacyContentWorkspaceRoute(to.params, to.query, to.hash),
        },
        {
          path: 'content/ai',
          name: 'event-ai',
          redirect: (to) =>
            legacyContentWorkspaceRoute(to.params, to.query, to.hash || '#public-page'),
        },
        {
          path: 'content',
          redirect: (to) =>
            legacyContentWorkspaceRoute(to.params, to.query, to.hash),
        },
        {
          path: 'settings/content/ai',
          redirect: (to) =>
            legacyContentWorkspaceRoute(to.params, to.query, to.hash || '#public-page'),
        },
        {
          path: 'registrations',
          name: 'event-registrations',
          component: () => import('./views/RegistrationsView.vue'),
          meta: {
            title: '报名管理',
            code: 'REGISTRATIONS',
            requiredGrants: ['event.registration.read'],
          },
        },
        {
          path: 'registrations/:registrationId',
          name: 'event-registration-detail',
          component: () => import('./views/RegistrationDetailView.vue'),
          meta: {
            title: '报名详情',
            code: 'REGISTRATION DETAIL',
            requiredGrants: ['event.registration.read'],
          },
        },
        {
          path: 'invoices/:invoiceId?',
          name: 'event-invoices',
          component: () => import('./views/InvoicesView.vue'),
          meta: {
            title: '发票管理',
            code: 'INVOICES',
            requiredAllGrants: ['event.read', 'org.invoice.read'],
          },
        },
        {
          path: 'orders',
          name: 'event-orders',
          component: () => import('./views/OrdersView.vue'),
          beforeEnter: (to) =>
            session.can('event.registration.read')
              ? { name: 'event-registrations', params: to.params, query: to.query }
              : true,
          meta: { title: '订单管理', code: 'ORDERS', requiredGrants: ['event.order.read'] },
        },
        {
          path: 'notifications',
          name: 'event-notifications',
          component: () => import('./views/NotificationsView.vue'),
          meta: {
            title: '通知中心',
            code: 'NOTIFICATIONS',
            requiredGrants: ['event.notification.read'],
          },
        },
        {
          path: 'notifications/new',
          name: 'event-notification-create',
          component: () => import('./views/NotificationCreateView.vue'),
          meta: {
            title: '新建消息通知',
            code: 'NEW MESSAGE',
            requiredGrants: ['event.notification.send'],
          },
        },
        {
          path: 'activity',
          name: 'event-activity',
          component: () => import('./views/AuditView.vue'),
          meta: { title: '操作记录', code: 'ACTIVITY', requiredGrants: ['event.audit.read'] },
        },
      ],
    },
    {
      path: '/403',
      name: 'forbidden',
      component: () => import('./views/ForbiddenView.vue'),
      meta: { title: '无权访问' },
    },

    // One-release compatibility layer for bookmarks from the flat administration shell.
    { path: '/events', redirect: { name: 'manage-events' } },
    { path: '/organization', redirect: { name: 'manage-settings-team' } },
    {
      path: '/dashboard',
      redirect: (to) =>
        recentEventRoute('event-overview', to.query as Record<string, string | string[]>),
    },
    {
      path: '/event',
      redirect: (to) =>
        recentEventRoute('event-settings-general', to.query as Record<string, string | string[]>),
    },
    {
      path: '/publishing',
      redirect: (to) =>
        recentEventRoute('event-settings-general', to.query as Record<string, string | string[]>),
    },
    {
      path: '/forms',
      redirect: (to) =>
        recentEventRoute('event-settings-form', to.query as Record<string, string | string[]>),
    },
    {
      path: '/registrations',
      redirect: (to) =>
        recentEventRoute('event-registrations', to.query as Record<string, string | string[]>),
    },
    {
      path: '/orders',
      redirect: (to) =>
        recentEventRoute('event-orders', to.query as Record<string, string | string[]>),
    },
    {
      path: '/content',
      redirect: (to) =>
        recentEventRoute(
          'event-settings-general',
          to.query as Record<string, string | string[]>,
          to.hash || '#public-page',
        ),
    },
    {
      path: '/notifications',
      redirect: (to) =>
        recentEventRoute('event-notifications', to.query as Record<string, string | string[]>),
    },
    {
      path: '/ai',
      redirect: (to) =>
        recentEventRoute(
          'event-settings-general',
          to.query as Record<string, string | string[]>,
          to.hash || '#public-page',
        ),
    },
    {
      path: '/audit',
      redirect: (to) =>
        recentEventRoute('event-activity', to.query as Record<string, string | string[]>),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('./views/NotFoundView.vue'),
      meta: { public: true, title: '页面未找到' },
    },
  ],
});

const routeLoadRecovery = createRouteLoadRecovery({
  origin: window.location.origin,
  storage: window.sessionStorage,
  navigate: (target) => window.location.assign(target),
});

function knownAdminRoute(path: string) {
  const resolved = router.resolve(path);
  return resolved.matched.length > 0 && resolved.name !== 'not-found';
}

function markEventRedirect(path: string) {
  const resolved = router.resolve(path);
  const value = Array.isArray(resolved.params.eventId)
    ? resolved.params.eventId[0]
    : resolved.params.eventId;
  const eventId = parseEventId(value);
  if (eventId) session.markExplicitEventRoute(eventId);
}

function eventIdFromDestination(destination: RouteLocationRaw) {
  const resolved = router.resolve(destination);
  const value = Array.isArray(resolved.params.eventId)
    ? resolved.params.eventId[0]
    : resolved.params.eventId;
  return parseEventId(value);
}

let entryResolvedEventId: ReturnType<typeof parseEventId>;

function initialNavigationCanBeRemembered() {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return true;
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  return navigation?.type !== 'reload';
}

export async function resolveAuthenticatedEntry(redirect?: unknown): Promise<RouteLocationRaw> {
  const currentIdentity = session.identity.value;
  const grants = currentIdentity?.membership.grants ?? [];
  const safeRedirect = safeRedirectPath(redirect, knownAdminRoute);
  if (safeRedirect) {
    markEventRedirect(safeRedirect);
    return safeRedirect;
  }

  if (!hasEventWorkspaceLanding(grants) || !session.can('event.read')) {
    return resolveAdminEntry({ grants, events: [] }).route;
  }

  try {
    const events = await session.loadEventOptions();
    const localEventId = session.recentEventId();
    const serverEventId = currentIdentity?.adminPreferences.lastEventId ?? undefined;
    const result = resolveAdminEntry({
      grants,
      events,
      ...(localEventId === undefined ? {} : { localEventId }),
      ...(serverEventId === undefined ? {} : { serverEventId }),
    });
    if (result.clearLocalPreference) session.forgetRecentEvent();
    if (result.clearServerPreference) session.clearServerRecentEvent();
    if (result.seedLocalEventId) session.setRecentEventId(result.seedLocalEventId);
    session.entryNotice.value = adminEntryPreferenceNotice(result);
    return result.route;
  } catch {
    session.entryNotice.value = '大会列表暂时无法读取，请重试。';
    return { name: session.managementLandingRouteName() };
  }
}

router.beforeEach(async (to, from) => {
  routeLoadRecovery.begin(router.resolve(to).href);
  if (!to.meta.public && !session.token.value) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (session.token.value && !session.identity.value && (!to.meta.public || to.name === 'login')) {
    try {
      session.setIdentity(await conferenceApi.getMe());
    } catch {
      session.clear();
      return { name: 'login', query: { redirect: to.fullPath } };
    }
  }
  if (to.name === 'login' && session.token.value) {
    const destination = await resolveAuthenticatedEntry(to.query.redirect);
    entryResolvedEventId = eventIdFromDestination(destination);
    return destination;
  }

  const requiredGrants = to.meta.requiredGrants as string[] | undefined;
  if (requiredGrants?.length && !session.canAny(requiredGrants)) {
    return { name: 'forbidden' };
  }

  const requiredAllGrants = to.meta.requiredAllGrants as string[] | undefined;
  if (requiredAllGrants?.length && !requiredAllGrants.every((grant) => session.can(grant))) {
    return { name: 'forbidden' };
  }

  if (to.name === 'manage-settings') {
    return {
      name: session.can('org.settings.read') ? 'manage-settings-payment' : 'manage-settings-team',
    };
  }

  const eventId = Array.isArray(to.params.eventId) ? to.params.eventId[0] : to.params.eventId;
  if (typeof eventId === 'string' && eventId) {
    const parsedEventId = parseEventId(eventId);
    if (!parsedEventId) return { name: 'manage-events' };
    const resolvedFromEntry = entryResolvedEventId === parsedEventId;
    entryResolvedEventId = undefined;
    if (!resolvedFromEntry && !from.matched.length && initialNavigationCanBeRemembered()) {
      session.markExplicitEventRoute(parsedEventId);
    }
  }
  return true;
});

router.onError((error, to) => {
  routeLoadRecovery.recover(error, router.resolve(to).href);
});

router.afterEach((to, _from, failure) => {
  if (!failure) routeLoadRecovery.complete(router.resolve(to).href);
  const title = typeof to.meta.title === 'string' ? to.meta.title : '后台管理';
  document.title = `${title} · TokEMS 运营台`;
});
