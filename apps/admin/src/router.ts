import { createRouter, createWebHistory, type RouteLocationRaw } from 'vue-router';
import { conferenceApi, session } from './lib/api';
import { parseEventId } from './lib/route-scope';

function recentEventRoute(
  name: string,
  query: Record<string, string | string[]> = {},
): RouteLocationRaw {
  return {
    name,
    params: { eventId: session.activeEventId.value },
    query,
  };
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
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
          name: 'manage-invoices',
          component: () => import('./views/InvoicesView.vue'),
          meta: { title: '发票管理', code: 'INVOICES', requiredGrants: ['org.invoice.read'] },
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
              component: () => import('./views/ManagementGeneralSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
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
              component: () => import('./views/ManagementAnalyticsSettingsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
            },
            {
              path: 'integrations',
              name: 'manage-settings-integrations',
              component: () => import('./views/ManagementIntegrationsView.vue'),
              meta: { requiredGrants: ['org.settings.read'] },
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
            title: '大会概览',
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
                      ? 'event-settings-site'
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
          meta: { title: '大会配置', code: 'GENERAL', requiredGrants: ['event.manage'] },
        },
        {
          path: 'settings/site',
          name: 'event-settings-site',
          component: () => import('./views/PublishingView.vue'),
          meta: {
            title: '大会配置',
            code: 'SITE',
            requiredGrants: ['event.site.read'],
          },
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
          path: 'content',
          name: 'event-content',
          component: () => import('./views/ContentView.vue'),
          meta: { title: '内容运营', code: 'CONTENT', requiredGrants: ['event.content.manage'] },
        },
        {
          path: 'content/ai',
          name: 'event-ai',
          component: () => import('./views/AiView.vue'),
          meta: { title: '内容运营', code: 'AI COPY', requiredGrants: ['event.ai.read'] },
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
          path: 'orders',
          name: 'event-orders',
          component: () => import('./views/OrdersView.vue'),
          meta: { title: '订单与退款', code: 'ORDERS', requiredGrants: ['event.order.read'] },
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
          path: 'check-in',
          name: 'event-check-in',
          component: () => import('./views/CheckInView.vue'),
          meta: {
            title: '现场签到',
            code: 'CHECK IN',
            requiredGrants: ['event.checkin.execute', 'event.checkin.manage'],
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
        recentEventRoute('event-settings-site', to.query as Record<string, string | string[]>),
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
      path: '/checkin',
      redirect: (to) =>
        recentEventRoute('event-check-in', to.query as Record<string, string | string[]>),
    },
    {
      path: '/content',
      redirect: (to) =>
        recentEventRoute('event-content', to.query as Record<string, string | string[]>),
    },
    {
      path: '/notifications',
      redirect: (to) =>
        recentEventRoute('event-notifications', to.query as Record<string, string | string[]>),
    },
    {
      path: '/ai',
      redirect: (to) => recentEventRoute('event-ai', to.query as Record<string, string | string[]>),
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

router.beforeEach(async (to) => {
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
    const redirect = String(to.query.redirect ?? '');
    if (redirect.startsWith('/') && !redirect.startsWith('//')) return redirect;
    return { name: session.landingRouteName() };
  }

  const requiredGrants = to.meta.requiredGrants as string[] | undefined;
  if (requiredGrants?.length && !session.canAny(requiredGrants)) {
    return { name: 'forbidden' };
  }

  if (to.name === 'manage-settings') {
    return {
      name: session.can('org.settings.read') ? 'manage-settings-general' : 'manage-settings-team',
    };
  }

  const eventId = Array.isArray(to.params.eventId) ? to.params.eventId[0] : to.params.eventId;
  if (typeof eventId === 'string' && eventId) {
    const parsedEventId = parseEventId(eventId);
    if (!parsedEventId) return { name: 'manage-events' };
    session.setActiveEvent(parsedEventId);
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '后台管理';
  document.title = `${title} · TokEMS 运营台`;
});
