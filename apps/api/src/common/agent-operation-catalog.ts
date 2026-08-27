import { RequestMethod, SetMetadata } from '@nestjs/common';
import {
  AgentActionSchema,
  TOKEMS_AGENT_CATALOG_VERSION,
  TOKEMS_AGENT_MIN_CLIENT_VERSION,
  type AgentAction as AgentActionDefinition,
  type AgentDataClass,
  type AgentIdempotencyStrategy,
  type AgentRisk,
  type AgentScope,
} from '@conference/contracts';

export const AGENT_SURFACE_METADATA = 'tokems.agent.surface';
export const AGENT_ACTION_METADATA = 'tokems.agent.action';
export const AGENT_EXCLUDED_METADATA = 'tokems.agent.excluded';
const NEST_PATH_METADATA = 'path';
const NEST_METHOD_METADATA = 'method';

export interface AgentSurfaceOptions {
  defaultExclusionReason?: string;
}

const requestMethodNames: Partial<Record<RequestMethod, AgentActionDefinition['method']>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

function paths(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : [value ?? ''];
}

function joinedRoute(controllerPath: string, handlerPath: string) {
  return `/api/v1/${controllerPath}/${handlerPath}`.replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
}

export function AgentSurface(options: AgentSurfaceOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AGENT_SURFACE_METADATA, options, target);
    const controllerPaths = paths(
      Reflect.getMetadata(NEST_PATH_METADATA, target) as string | string[] | undefined,
    );
    for (const name of Object.getOwnPropertyNames(target.prototype)) {
      if (name === 'constructor') continue;
      const handler = target.prototype[name] as object;
      const method =
        requestMethodNames[Reflect.getMetadata(NEST_METHOD_METADATA, handler) as RequestMethod];
      if (!method) continue;
      const handlerPaths = paths(
        Reflect.getMetadata(NEST_PATH_METADATA, handler) as string | string[] | undefined,
      );
      const released = controllerPaths
        .flatMap((controllerPath) =>
          handlerPaths.map((handlerPath) =>
            findAgentActionTemplate(method, joinedRoute(controllerPath, handlerPath)),
          ),
        )
        .find(Boolean);
      if (released) {
        Reflect.defineMetadata(AGENT_ACTION_METADATA, released.actionId, handler);
      } else if (
        options.defaultExclusionReason &&
        !Reflect.getMetadata(AGENT_EXCLUDED_METADATA, handler)
      ) {
        Reflect.defineMetadata(AGENT_EXCLUDED_METADATA, options.defaultExclusionReason, handler);
      }
    }
  };
}
export const AgentAction = (actionId: string) => SetMetadata(AGENT_ACTION_METADATA, actionId);
export const AgentExcluded = (reason: string) => SetMetadata(AGENT_EXCLUDED_METADATA, reason);

type ActionOptions = {
  grant: string;
  grants?: string[];
  scopes?: AgentScope[];
  dataClass?: AgentDataClass;
  risk?: AgentRisk;
  dynamicRiskPolicy?: string;
  strategy?: AgentIdempotencyStrategy;
  confirmation?: AgentActionDefinition['confirmation'];
  verifyActionId?: string;
  reconcileActionId?: string;
  rollback?: string;
  description: string;
};

function action(
  actionId: string,
  method: AgentActionDefinition['method'],
  path: string,
  options: ActionOptions,
): AgentActionDefinition {
  const risk = options.risk ?? (method === 'GET' ? 'read' : 'routine-write');
  return AgentActionSchema.parse({
    actionId,
    method,
    routeName: actionId.replaceAll('.', '_'),
    path,
    requiredGrants: options.grants ?? [options.grant],
    agentScopes:
      options.scopes ??
      (method === 'GET'
        ? ['tokems:read']
        : risk === 'critical'
          ? ['tokems:write', 'tokems:dangerous']
          : ['tokems:write']),
    dataClass: options.dataClass ?? 'internal',
    riskBase: risk,
    dynamicRiskPolicy: options.dynamicRiskPolicy,
    confirmation:
      options.confirmation ??
      (risk === 'critical'
        ? 'step-up'
        : risk === 'controlled'
          ? 'browser'
          : method === 'GET'
            ? 'none'
            : 'intent'),
    idempotencyStrategy:
      method === 'GET' && !options.strategy
        ? undefined
        : (options.strategy ?? 'transactional-command'),
    retryPolicy: method === 'GET' ? 'safe' : 'query-before-retry',
    targetResolver: `${actionId}-target`,
    verifyActionId: options.verifyActionId,
    reconcileActionId: options.reconcileActionId ?? options.verifyActionId,
    rollback: options.rollback ?? (method === 'GET' ? 'not-applicable' : 'use-domain-history'),
    minClientVersion: TOKEMS_AGENT_MIN_CLIENT_VERSION,
    description: options.description,
  });
}

export const AGENT_ACTIONS = [
  action('organization.members.list', 'GET', '/api/v1/admin/organization/members', {
    grant: 'org.member.read',
    dataClass: 'pii',
    risk: 'sensitive-read',
    scopes: ['tokems:read', 'tokems:pii'],
    description: '按明确用途读取组织成员和管理员资料。',
  }),
  action(
    'organization.members.update',
    'PATCH',
    '/api/v1/admin/organization/members/:membershipId',
    {
      grant: 'org.member.manage',
      risk: 'critical',
      description: '更新组织成员角色与授权。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action(
    'organization.members.status',
    'PATCH',
    '/api/v1/admin/organization/members/:membershipId/status',
    {
      grant: 'org.member.manage',
      risk: 'critical',
      description: '启用或停用组织成员。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action(
    'organization.members.delete',
    'DELETE',
    '/api/v1/admin/organization/members/:membershipId',
    {
      grant: 'org.member.manage',
      risk: 'critical',
      description: '永久移除组织成员。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action(
    'organization.administrators.create',
    'POST',
    '/api/v1/admin/organization/administrators',
    {
      grant: '*',
      risk: 'critical',
      strategy: 'one-time-secret',
      description: '创建组织管理员并安全交接一次性凭据。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action(
    'organization.administrators.update',
    'PATCH',
    '/api/v1/admin/organization/administrators/:membershipId',
    {
      grant: '*',
      risk: 'critical',
      strategy: 'one-time-secret',
      description: '更新管理员身份、角色、授权或凭据。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action(
    'organization.administrators.delete',
    'DELETE',
    '/api/v1/admin/organization/administrators/:membershipId',
    {
      grant: '*',
      risk: 'critical',
      description: '删除组织管理员。',
      verifyActionId: 'organization.members.list',
    },
  ),
  action('organization.settings.get', 'GET', '/api/v1/admin/organization/settings', {
    grant: 'org.settings.read',
    description: '读取组织与前台网站设置。',
  }),
  action('organization.settings.update', 'PATCH', '/api/v1/admin/organization/settings', {
    grant: 'org.settings.manage',
    risk: 'controlled',
    dynamicRiskPolicy: 'published-site-upgrade',
    description: '更新组织及前台网站设置。',
    verifyActionId: 'organization.settings.get',
  }),
  action('organization.analytics.update', 'PUT', '/api/v1/admin/organization/analytics', {
    grant: 'org.analytics.manage',
    risk: 'critical',
    description: '确认、启用或停用组织公开页面的网站统计配置。',
    verifyActionId: 'organization.settings.get',
    rollback: '调用同一接口停用网站统计。',
  }),
  action('organization.homepage-event.update', 'PUT', '/api/v1/admin/organization/homepage-event', {
    grant: 'org.settings.manage',
    risk: 'controlled',
    description: '修改组织首页绑定大会。',
    verifyActionId: 'organization.settings.get',
  }),
  action('events.list', 'GET', '/api/v1/admin/events', {
    grant: 'event.read',
    description: '读取当前组织的大会列表。',
  }),
  action('events.get', 'GET', '/api/v1/admin/events/:eventId', {
    grant: 'event.read',
    description: '读取大会配置。',
  }),
  action('events.create', 'POST', '/api/v1/admin/events', {
    grant: 'event.manage',
    grants: ['event.manage', 'org.template.use'],
    description: '创建大会。',
    verifyActionId: 'events.get',
  }),
  action('events.update', 'PATCH', '/api/v1/admin/events/:eventId', {
    grant: 'event.manage',
    dynamicRiskPolicy: 'published-event-upgrade',
    description: '更新大会基础配置与公开文案。',
    verifyActionId: 'events.get',
  }),
  action('events.public-url.update', 'PATCH', '/api/v1/admin/events/:eventId/public-url', {
    grant: 'event.manage',
    risk: 'controlled',
    description: '修改大会公开路径。',
    verifyActionId: 'events.get',
  }),
  action('events.releases.list', 'GET', '/api/v1/admin/events/:eventId/releases', {
    grant: 'event.site.read',
    description: '读取大会发布历史。',
  }),
  action('events.releases.publish', 'POST', '/api/v1/admin/events/:eventId/releases', {
    grant: 'event.site.publish',
    risk: 'controlled',
    strategy: 'domain-key',
    description: '发布大会公开版本。',
    verifyActionId: 'events.releases.list',
    rollback: 'rollback-to-prior-release',
  }),
  action(
    'events.releases.rollback',
    'POST',
    '/api/v1/admin/events/:eventId/releases/:releaseId/rollback',
    {
      grant: 'event.site.publish',
      risk: 'controlled',
      strategy: 'domain-key',
      description: '回滚大会公开版本。',
      verifyActionId: 'events.releases.list',
    },
  ),
  action('content.get', 'GET', '/api/v1/admin/events/:eventId/content', {
    grant: 'event.content.manage',
    description: '读取大会内容、票种、嘉宾与议程。',
  }),
  action('content.speakers.list', 'GET', '/api/v1/admin/events/:eventId/speakers', {
    grant: 'event.content.manage',
    description: '读取嘉宾列表。',
  }),
  action('content.speakers.create', 'POST', '/api/v1/admin/events/:eventId/speakers', {
    grant: 'event.content.manage',
    dynamicRiskPolicy: 'published-event-upgrade',
    description: '创建大会嘉宾。',
    verifyActionId: 'content.speakers.list',
  }),
  action('content.speakers.update', 'PATCH', '/api/v1/admin/events/:eventId/speakers/:speakerId', {
    grant: 'event.content.manage',
    dynamicRiskPolicy: 'published-event-upgrade',
    description: '更新大会嘉宾。',
    verifyActionId: 'content.speakers.list',
  }),
  action('content.speakers.delete', 'DELETE', '/api/v1/admin/events/:eventId/speakers/:speakerId', {
    grant: 'event.content.manage',
    risk: 'controlled',
    description: '删除大会嘉宾。',
    verifyActionId: 'content.speakers.list',
  }),
  action('content.sessions.create', 'POST', '/api/v1/admin/events/:eventId/sessions', {
    grant: 'event.content.manage',
    dynamicRiskPolicy: 'published-event-upgrade',
    description: '创建大会日程。',
    verifyActionId: 'content.get',
  }),
  action('content.sessions.update', 'PATCH', '/api/v1/admin/events/:eventId/sessions/:sessionId', {
    grant: 'event.content.manage',
    dynamicRiskPolicy: 'published-event-upgrade',
    description: '更新大会日程。',
    verifyActionId: 'content.get',
  }),
  action('content.sessions.delete', 'DELETE', '/api/v1/admin/events/:eventId/sessions/:sessionId', {
    grant: 'event.content.manage',
    risk: 'controlled',
    description: '删除大会日程。',
    verifyActionId: 'content.get',
  }),
  action(
    'content.registration-forms.get',
    'GET',
    '/api/v1/admin/events/:eventId/registration-forms',
    {
      grant: 'event.registration.manage',
      description: '读取大会报名表。',
    },
  ),
  action(
    'content.registration-forms.publish',
    'POST',
    '/api/v1/admin/events/:eventId/registration-forms/publish',
    {
      grant: 'event.registration.manage',
      risk: 'controlled',
      strategy: 'domain-key',
      description: '发布大会报名表。',
      verifyActionId: 'content.registration-forms.get',
    },
  ),
  action('templates.list', 'GET', '/api/v1/admin/templates', {
    grant: 'org.template.read',
    description: '读取结构化与 HTML 模板列表。',
  }),
  action('templates.create', 'POST', '/api/v1/admin/templates', {
    grant: 'org.template.manage',
    risk: 'controlled',
    description: '创建结构化模板并按明确选项决定是否发布。',
    verifyActionId: 'templates.list',
  }),
  action('templates.html-imports.list', 'GET', '/api/v1/admin/template-html-imports', {
    grant: 'org.template.read',
    description: '读取 HTML 模板导入任务。',
  }),
  action('templates.html-imports.get', 'GET', '/api/v1/admin/template-html-imports/:importId', {
    grant: 'org.template.read',
    description: '读取 HTML 模板导入状态与安全扫描摘要。',
  }),
  action('templates.html-imports.prepare', 'POST', '/api/v1/admin/template-html-imports', {
    grant: 'org.template.manage',
    dataClass: 'secret',
    risk: 'controlled',
    strategy: 'one-time-secret',
    description: '创建 HTML 包上传预留并安全交接短期上传信息。',
    verifyActionId: 'templates.html-imports.list',
  }),
  action(
    'templates.html-imports.scan',
    'POST',
    '/api/v1/admin/template-html-imports/:importId/scan',
    {
      grant: 'org.template.manage',
      risk: 'controlled',
      strategy: 'outbox-job',
      description: '扫描已上传 HTML 模板包。',
      verifyActionId: 'templates.html-imports.get',
    },
  ),
  action(
    'templates.html-imports.retry',
    'POST',
    '/api/v1/admin/template-html-imports/:importId/retry',
    {
      grant: 'org.template.manage',
      risk: 'controlled',
      strategy: 'outbox-job',
      description: '重试 HTML 模板安全扫描。',
      verifyActionId: 'templates.html-imports.get',
    },
  ),
  action(
    'templates.html-imports.cancel',
    'DELETE',
    '/api/v1/admin/template-html-imports/:importId',
    {
      grant: 'org.template.manage',
      risk: 'controlled',
      description: '取消 HTML 模板导入并清理预留。',
      verifyActionId: 'templates.html-imports.list',
    },
  ),
  action(
    'templates.html-imports.commit',
    'POST',
    '/api/v1/admin/template-html-imports/:importId/commit',
    {
      grant: 'org.template.manage',
      risk: 'controlled',
      strategy: 'domain-key',
      description: '提交通过安全扫描的 HTML 模板版本。',
      verifyActionId: 'templates.html-imports.get',
      rollback: 'archive-imported-template',
    },
  ),
  action('templates.get', 'GET', '/api/v1/admin/templates/:templateId', {
    grant: 'org.template.read',
    description: '读取模板详情。',
  }),
  action('templates.draft.get', 'GET', '/api/v1/admin/templates/:templateId/draft', {
    grant: 'org.template.read',
    description: '读取模板草稿与修订号。',
  }),
  action('templates.draft.update', 'PUT', '/api/v1/admin/templates/:templateId/draft', {
    grant: 'org.template.manage',
    dynamicRiskPolicy: 'published-template-upgrade',
    description: '按修订号更新结构化模板草稿。',
    verifyActionId: 'templates.draft.get',
    rollback: 'restore-prior-revision',
  }),
  action('templates.publish', 'POST', '/api/v1/admin/templates/:templateId/publish', {
    grant: 'org.template.publish',
    risk: 'controlled',
    strategy: 'domain-key',
    description: '发布不可变模板版本。',
    verifyActionId: 'templates.get',
    rollback: 'restore-prior-revision',
  }),
  action(
    'templates.html-document.get',
    'GET',
    '/api/v1/admin/templates/:templateId/html-document',
    {
      grant: 'org.template.read',
      description: '读取 HTML 模板净化文档和安全报告。',
    },
  ),
  action(
    'templates.html-bindings.update',
    'PUT',
    '/api/v1/admin/templates/:templateId/html-bindings',
    {
      grant: 'org.template.manage',
      dynamicRiskPolicy: 'published-template-upgrade',
      description: '按修订号更新 HTML 模板绑定。',
      verifyActionId: 'templates.html-document.get',
      rollback: 'restore-prior-revision',
    },
  ),
  action(
    'templates.html-preview.create',
    'POST',
    '/api/v1/admin/templates/:templateId/html-preview',
    {
      grant: 'org.template.read',
      dataClass: 'secret',
      strategy: 'one-time-secret',
      description: '生成 HTML 模板安全预览。',
    },
  ),
  action('templates.assets.list', 'GET', '/api/v1/admin/template-assets', {
    grant: 'org.template.read',
    description: '读取模板资产及脱敏预览元数据。',
  }),
  action('templates.assets.upload.prepare', 'POST', '/api/v1/admin/template-assets/uploads', {
    grant: 'org.template.manage',
    dataClass: 'secret',
    risk: 'controlled',
    strategy: 'one-time-secret',
    description: '创建短期模板资产上传预留并安全交接上传信息。',
    verifyActionId: 'templates.assets.list',
  }),
  action('templates.assets.create', 'POST', '/api/v1/admin/template-assets', {
    grant: 'org.template.manage',
    dynamicRiskPolicy: 'published-template-upgrade',
    description: '登记已上传且通过摘要验证的模板资产。',
    verifyActionId: 'templates.assets.list',
  }),
  action('templates.assets.delete', 'DELETE', '/api/v1/admin/template-assets/:assetId', {
    grant: 'org.template.manage',
    risk: 'controlled',
    description: '删除未被模板引用的资产。',
    verifyActionId: 'templates.assets.list',
  }),
  action('templates.event-binding.get', 'GET', '/api/v1/admin/events/:eventId/template-binding', {
    grant: 'event.site.read',
    description: '读取大会模板绑定。',
  }),
  action(
    'templates.event-binding.update',
    'PUT',
    '/api/v1/admin/events/:eventId/template-binding',
    {
      grant: 'event.manage',
      grants: ['event.manage', 'org.template.use'],
      risk: 'controlled',
      description: '绑定或升级大会模板。',
      verifyActionId: 'templates.event-binding.get',
      rollback: 'restore-prior-binding',
    },
  ),
  action('registrations.list', 'GET', '/api/v1/admin/events/:eventId/registrations', {
    grant: 'event.registration.read',
    dataClass: 'pii',
    scopes: ['tokems:read'],
    description: '读取默认掩码的报名列表。',
  }),
  action(
    'registrations.get',
    'GET',
    '/api/v1/admin/events/:eventId/registrations/:registrationId',
    {
      grant: 'event.registration.read',
      dataClass: 'pii',
      risk: 'sensitive-read',
      scopes: ['tokems:read', 'tokems:pii'],
      description: '读取最小化的报名详情。',
    },
  ),
  action(
    'registrations.attendee.update',
    'PATCH',
    '/api/v1/admin/events/:eventId/registrations/:registrationId/attendee',
    {
      grant: 'event.registration.manage',
      dataClass: 'pii',
      scopes: ['tokems:write', 'tokems:pii'],
      description: '更新参会人资料。',
      verifyActionId: 'registrations.get',
    },
  ),
  action(
    'registrations.review',
    'POST',
    '/api/v1/admin/events/:eventId/registrations/:registrationId/review',
    {
      grant: 'event.registration.manage',
      risk: 'controlled',
      strategy: 'domain-key',
      description: '审核报名。',
      verifyActionId: 'registrations.get',
    },
  ),
  action('attendee-needs.list', 'GET', '/api/v1/admin/events/:eventId/attendee-needs', {
    grant: 'event.registration.read',
    dataClass: 'pii',
    risk: 'sensitive-read',
    scopes: ['tokems:read', 'tokems:pii'],
    description: '按明确用途读取参会者提交的问题与治理状态。',
  }),
  action(
    'attendee-needs.update',
    'PATCH',
    '/api/v1/admin/events/:eventId/attendee-needs/:questionId',
    {
      grant: 'event.registration.manage',
      dataClass: 'pii',
      scopes: ['tokems:write', 'tokems:pii'],
      risk: 'controlled',
      description: '按版本和原因修改参会问题正文与标签。',
      verifyActionId: 'attendee-needs.list',
      rollback: 'restore-prior-revision',
    },
  ),
  action(
    'attendee-needs.moderate',
    'PATCH',
    '/api/v1/admin/events/:eventId/attendee-needs/:questionId/moderation',
    {
      grant: 'event.registration.manage',
      dataClass: 'pii',
      scopes: ['tokems:write', 'tokems:pii'],
      risk: 'controlled',
      description: '按版本和原因隐藏、恢复、删除或匿名化参会问题。',
      verifyActionId: 'attendee-needs.list',
      rollback: 'use-attendee-needs-moderation-history',
    },
  ),
  action(
    'attendee-needs.export',
    'GET',
    '/api/v1/admin/events/:eventId/attendee-needs/export.csv',
    {
      grant: 'event.registration.read',
      grants: ['event.registration.read', 'event.registration.export'],
      dataClass: 'pii',
      scopes: ['tokems:read', 'tokems:pii', 'tokems:export', 'tokems:dangerous'],
      risk: 'critical',
      confirmation: 'step-up',
      strategy: 'outbox-job',
      description: '导出参会需求文件；嘉宾版必须匿名。',
    },
  ),
  action('customers.list', 'GET', '/api/v1/admin/customers', {
    grant: 'customer.read',
    dataClass: 'pii',
    description: '读取默认掩码的普通用户列表。',
  }),
  action('customers.get', 'GET', '/api/v1/admin/customers/:userId', {
    grant: 'customer.read',
    dataClass: 'pii',
    risk: 'sensitive-read',
    scopes: ['tokems:read', 'tokems:pii'],
    description: '读取最小化普通用户详情。',
  }),
  action('customers.create', 'POST', '/api/v1/admin/customers', {
    grant: 'customer.manage',
    dataClass: 'pii',
    scopes: ['tokems:write', 'tokems:pii'],
    description: '创建普通用户。',
    verifyActionId: 'customers.get',
  }),
  action('customers.update', 'PATCH', '/api/v1/admin/customers/:userId', {
    grant: 'customer.manage',
    dataClass: 'pii',
    scopes: ['tokems:write', 'tokems:pii'],
    risk: 'controlled',
    description: '更新普通用户资料、标签或状态。',
    verifyActionId: 'customers.get',
  }),
  action('customers.delete', 'DELETE', '/api/v1/admin/customers/:userId', {
    grant: 'customer.delete',
    dataClass: 'pii',
    scopes: ['tokems:write', 'tokems:pii', 'tokems:dangerous'],
    risk: 'critical',
    description: '永久删除普通用户并保留审计历史。',
    verifyActionId: 'customers.list',
  }),
  action('customers.export', 'GET', '/api/v1/admin/customers/export.csv', {
    grant: 'customer.export',
    grants: ['customer.read', 'customer.export'],
    dataClass: 'pii',
    scopes: ['tokems:read', 'tokems:pii', 'tokems:export', 'tokems:dangerous'],
    risk: 'critical',
    confirmation: 'step-up',
    strategy: 'outbox-job',
    description: '导出普通用户 PII 文件。',
  }),
  action('commerce.orders.list', 'GET', '/api/v1/admin/events/:eventId/orders', {
    grant: 'event.order.read',
    dataClass: 'pii',
    description: '读取掩码后的订单列表。',
  }),
  action('commerce.refunds.create', 'POST', '/api/v1/admin/orders/:orderId/refunds', {
    grant: 'event.order.refund',
    scopes: ['tokems:write', 'tokems:finance', 'tokems:dangerous'],
    dataClass: 'pii',
    risk: 'critical',
    strategy: 'domain-key',
    description: '按可退上限创建退款。',
    verifyActionId: 'commerce.refunds.list',
  }),
  action('commerce.refunds.list', 'GET', '/api/v1/admin/refunds', {
    grant: 'event.order.read',
    scopes: ['tokems:read', 'tokems:finance'],
    dataClass: 'pii',
    description: '读取退款记录。',
  }),
  action('invoices.list', 'GET', '/api/v1/admin/events/:eventId/invoices', {
    grant: 'event.read',
    grants: ['event.read', 'org.invoice.read'],
    scopes: ['tokems:read', 'tokems:finance'],
    dataClass: 'pii',
    description: '读取发票列表。',
  }),
  action('invoices.get', 'GET', '/api/v1/admin/events/:eventId/invoices/:invoiceId', {
    grant: 'event.read',
    grants: ['event.read', 'org.invoice.read'],
    scopes: ['tokems:read', 'tokems:finance', 'tokems:pii'],
    dataClass: 'pii',
    risk: 'sensitive-read',
    description: '读取最小化发票详情。',
  }),
  action('invoices.approve', 'POST', '/api/v1/admin/events/:eventId/invoices/:invoiceId/approve', {
    grant: 'event.read',
    grants: ['event.read', 'org.invoice.manage'],
    scopes: ['tokems:write', 'tokems:finance'],
    risk: 'controlled',
    strategy: 'domain-key',
    description: '批准发票申请。',
    verifyActionId: 'invoices.get',
  }),
  action(
    'invoices.documents.replace',
    'POST',
    '/api/v1/admin/events/:eventId/invoices/:invoiceId/documents/:documentId/replace-file',
    {
      grant: 'event.read',
      grants: ['event.read', 'org.invoice.manage'],
      scopes: ['tokems:write', 'tokems:finance', 'tokems:dangerous'],
      dataClass: 'pii',
      risk: 'critical',
      strategy: 'outbox-job',
      description: '替换关键发票文件。',
      verifyActionId: 'invoices.get',
    },
  ),
  action('communications.notifications.queue', 'POST', '/api/v1/admin/notifications/queue', {
    grant: 'event.notification.send',
    scopes: ['tokems:write', 'tokems:communications', 'tokems:dangerous'],
    risk: 'critical',
    dynamicRiskPolicy: 'notification-audience-upgrade',
    strategy: 'outbox-job',
    description: '锁定受众快照并排队通知。',
    verifyActionId: 'communications.deliveries.list',
  }),
  action('communications.deliveries.list', 'GET', '/api/v1/admin/notification-deliveries', {
    grant: 'event.notification.read',
    scopes: ['tokems:read', 'tokems:communications'],
    description: '读取通知投递状态。',
  }),
  action('checkin.devices.list', 'GET', '/api/v1/admin/events/:eventId/checkin-devices', {
    grant: 'event.checkin.manage',
    description: '读取现场设备列表。',
  }),
  action('checkin.devices.create', 'POST', '/api/v1/admin/events/:eventId/checkin-devices', {
    grant: 'event.checkin.manage',
    scopes: ['tokems:write', 'tokems:security', 'tokems:dangerous'],
    risk: 'critical',
    strategy: 'one-time-secret',
    dataClass: 'secret',
    description: '创建现场设备并安全交接一次性令牌。',
    verifyActionId: 'checkin.devices.list',
  }),
  action('checkin.sync', 'POST', '/api/v1/admin/checkins/sync', {
    grant: 'event.checkin.execute',
    scopes: ['tokems:write', 'tokems:security', 'tokems:dangerous'],
    risk: 'critical',
    strategy: 'domain-key',
    description: '同步离线核销批次并拒绝同键异参。',
  }),
  action('integrations.status.get', 'GET', '/api/v1/admin/integrations/status', {
    grant: 'org.settings.read',
    dataClass: 'secret',
    scopes: ['tokems:read', 'tokems:security'],
    description: '读取脱敏后的集成配置状态。',
  }),
  action('integrations.feishu.get', 'GET', '/api/v1/admin/integrations/feishu-bot', {
    grant: 'org.settings.read',
    scopes: ['tokems:read', 'tokems:security'],
    description: '读取脱敏后的飞书机器人连接状态。',
  }),
  action('integrations.feishu.chats.list', 'GET', '/api/v1/admin/integrations/feishu-bot/chats', {
    grant: 'org.settings.manage',
    scopes: ['tokems:read', 'tokems:security'],
    description: '读取当前飞书应用可见的群聊列表。',
  }),
  action('communications.feishu-digest.get', 'GET', '/api/v1/admin/events/:eventId/feishu-digest', {
    grant: 'org.settings.read',
    scopes: ['tokems:read', 'tokems:communications'],
    description: '读取大会飞书日报配置与连接状态。',
  }),
  action(
    'communications.feishu-digest.preview',
    'GET',
    '/api/v1/admin/events/:eventId/feishu-digest/preview',
    {
      grant: 'org.settings.read',
      grants: ['org.settings.read', 'event.dashboard.read'],
      scopes: ['tokems:read', 'tokems:finance'],
      risk: 'sensitive-read',
      description: '按明确用途预览包含聚合经营数据的大会飞书日报。',
    },
  ),
  action(
    'communications.feishu-digest.deliveries.list',
    'GET',
    '/api/v1/admin/events/:eventId/feishu-digest/deliveries',
    {
      grant: 'org.settings.read',
      scopes: ['tokems:read', 'tokems:communications'],
      description: '读取大会飞书日报投递记录。',
    },
  ),
  action('integrations.wechat-pay.update', 'PATCH', '/api/v1/admin/integrations/wechat-pay', {
    grant: 'org.settings.manage',
    scopes: ['tokems:write', 'tokems:security', 'tokems:dangerous'],
    dataClass: 'secret',
    risk: 'critical',
    strategy: 'one-time-secret',
    description: '更新微信支付安全配置。',
    verifyActionId: 'integrations.status.get',
  }),
  action('integrations.aliyun-sms.update', 'PATCH', '/api/v1/admin/integrations/aliyun-sms', {
    grant: 'org.settings.manage',
    scopes: ['tokems:write', 'tokems:security', 'tokems:dangerous'],
    dataClass: 'secret',
    risk: 'critical',
    strategy: 'one-time-secret',
    description: '更新短信服务安全配置。',
    verifyActionId: 'integrations.status.get',
  }),
  action('audit.list', 'GET', '/api/v1/admin/audit-logs', {
    grant: 'event.audit.read',
    dataClass: 'pii',
    risk: 'sensitive-read',
    scopes: ['tokems:read', 'tokems:pii', 'tokems:security'],
    description: '按明确用途读取可能含个人信息的组织和大会审计摘要。',
  }),
  action(
    'exports.registrations.create',
    'GET',
    '/api/v1/admin/events/:eventId/registrations/export.csv',
    {
      grant: 'event.registration.export',
      scopes: ['tokems:read', 'tokems:pii', 'tokems:export', 'tokems:dangerous'],
      dataClass: 'pii',
      risk: 'critical',
      confirmation: 'step-up',
      strategy: 'outbox-job',
      description: '导出报名 PII 文件。',
    },
  ),
] as const satisfies readonly AgentActionDefinition[];

export const AGENT_ACTION_MAP = new Map(AGENT_ACTIONS.map((entry) => [entry.actionId, entry]));

if (AGENT_ACTION_MAP.size !== AGENT_ACTIONS.length) {
  throw new Error('TokEMS Agent action catalog contains duplicate action IDs');
}

const UUID_ROUTE_SEGMENT =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

function routeParameterPattern(name: string) {
  if (name === 'eventId') return '[1-9]\\d{2,9}';
  if (name === 'userId') return '[1-9]\\d*';
  if (name.endsWith('Id')) return UUID_ROUTE_SEGMENT;
  return '[^/]+';
}

function routePattern(path: string) {
  const escaped = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? routeParameterPattern(segment.slice(1))
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${escaped}/?$`, 'u');
}

const compiledRoutes = AGENT_ACTIONS.map((entry) => ({
  entry,
  pattern: routePattern(entry.path),
  dynamicSegments: entry.path.split('/').filter((segment) => segment.startsWith(':')).length,
})).sort(
  (left, right) =>
    left.dynamicSegments - right.dynamicSegments ||
    right.entry.path.length - left.entry.path.length,
);

export function findAgentAction(method: string, path: string) {
  return compiledRoutes.find(
    ({ entry, pattern }) => entry.method === method.toUpperCase() && pattern.test(path),
  )?.entry;
}

export function findAgentActionTemplate(method: string, path: string) {
  return AGENT_ACTIONS.find(
    (entry) => entry.method === method.toUpperCase() && entry.path === path,
  );
}

export function agentRequestTarget(action: AgentActionDefinition, rawUrl: string) {
  const url = new URL(rawUrl, 'http://tokems.invalid');
  const templateSegments = action.path.split('/').filter(Boolean);
  const requestSegments = url.pathname.split('/').filter(Boolean);
  if (templateSegments.length !== requestSegments.length) {
    throw new Error('Agent request path does not match its catalog template');
  }
  const target: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const template = templateSegments[index]!;
    if (!template.startsWith(':')) continue;
    const name = template.slice(1);
    const value = decodeURIComponent(requestSegments[index]!);
    if (!new RegExp(`^${routeParameterPattern(name)}$`, 'u').test(value)) {
      throw new Error('Agent request parameter does not match its catalog type');
    }
    target[name] = value;
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (key in target) throw new Error('Agent target key is ambiguous');
    target[key] = url.searchParams.getAll(key).join(',');
  }
  return target;
}

export function agentCatalogVersion() {
  return TOKEMS_AGENT_CATALOG_VERSION;
}
