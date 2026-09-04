import { Global, Module } from '@nestjs/common';
import { RefundWorkflowService } from './refund-workflow.service.js';
import { WeChatRefundService } from './wechat-refund.service.js';
import { AuthGuard } from './auth.guard.js';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { CommerceOperationsService } from './commerce-operations.service.js';
import { EngagementOperationsService } from './engagement-operations.service.js';
import { EventOperationsService } from './event-operations.service.js';
import { EventReleaseActivationService } from './event-release-activation.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import { TemplateOperationsService } from './template-operations.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { WeChatPayService } from './wechat-pay.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CustomerAuthGuard } from './customer-auth.guard.js';
import { CustomerAccountService } from './customer-account.service.js';
import { AliyunSmsService } from './aliyun-sms.service.js';
import { HtmlTemplateOperationsService } from './html-template-operations.service.js';
import { RedisService } from './redis.service.js';
import { AdminRegistrationOperationsService } from './admin-registration-operations.service.js';
import { AttendeeShowcaseService } from './attendee-showcase.service.js';
import { AttendeeNeedsService } from './attendee-needs.service.js';
import { CooperationRequestService } from './cooperation-request.service.js';
import { AgentAuthorizationService } from './agent-authorization.service.js';
import { AgentOperationService } from './agent-operation.service.js';
import { AgentPolicyService } from './agent-policy.service.js';
import { AgentPrincipalService } from './agent-principal.service.js';
import { AgentOperationInterceptor } from './agent-operation.interceptor.js';
import { EventPublicMetricsService } from './event-public-metrics.service.js';
import { FeishuDigestService } from './feishu-digest.service.js';
import { AttendeeServiceHubService } from './attendee-service-hub.service.js';

@Global()
@Module({
  providers: [
    RefundWorkflowService,
    WeChatRefundService,
    DatabaseService,
    ConferenceRepository,
    EventReleaseActivationService,
    EventOperationsService,
    CommerceOperationsService,
    EngagementOperationsService,
    OrganizationAdminService,
    InvoiceOperationsService,
    TemplateOperationsService,
    IdempotencyService,
    RedisService,
    WeChatPayService,
    AuthGuard,
    CustomerAuthService,
    CustomerAuthGuard,
    CustomerAccountService,
    AliyunSmsService,
    HtmlTemplateOperationsService,
    AdminRegistrationOperationsService,
    AttendeeShowcaseService,
    AttendeeNeedsService,
    CooperationRequestService,
    AgentAuthorizationService,
    AgentOperationService,
    AgentPolicyService,
    AgentPrincipalService,
    AgentOperationInterceptor,
    EventPublicMetricsService,
    FeishuDigestService,
    AttendeeServiceHubService,
  ],
  exports: [
    RefundWorkflowService,
    DatabaseService,
    ConferenceRepository,
    EventReleaseActivationService,
    EventOperationsService,
    CommerceOperationsService,
    EngagementOperationsService,
    OrganizationAdminService,
    InvoiceOperationsService,
    TemplateOperationsService,
    IdempotencyService,
    RedisService,
    WeChatPayService,
    AuthGuard,
    CustomerAuthService,
    CustomerAuthGuard,
    CustomerAccountService,
    AliyunSmsService,
    HtmlTemplateOperationsService,
    AdminRegistrationOperationsService,
    AttendeeShowcaseService,
    AttendeeNeedsService,
    CooperationRequestService,
    AgentAuthorizationService,
    AgentOperationService,
    AgentPolicyService,
    AgentPrincipalService,
    AgentOperationInterceptor,
    EventPublicMetricsService,
    FeishuDigestService,
    AttendeeServiceHubService,
  ],
})
export class CoreModule {}
