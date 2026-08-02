import { Global, Module } from '@nestjs/common';
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

@Global()
@Module({
  providers: [
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
  ],
  exports: [
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
  ],
})
export class CoreModule {}
