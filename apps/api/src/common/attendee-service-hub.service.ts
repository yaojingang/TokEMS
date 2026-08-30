import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  CustomerAttendeeServiceHubSchema,
  EventAttendeeServiceConfigurationSchema,
  type AttendeeServiceQrUpload,
  type ConfirmAttendeeServiceQrAsset,
  type CustomerAttendeeServiceHub,
  type CustomerPurchasedOrder,
  type CustomerServiceHubItem,
  type UpdateEventAttendeeServiceConfiguration,
} from '@conference/contracts';
import {
  auditLogs,
  eventAttendeeServiceConfigs,
  events,
  payments,
  registrationServiceAcknowledgements,
  templateAssets,
} from '@conference/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AttendeeNeedsService } from './attendee-needs.service.js';
import { AttendeeShowcaseService } from './attendee-showcase.service.js';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import { CustomerAccountService } from './customer-account.service.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import {
  ATTENDEE_SERVICE_QR_ALT_TEXT,
  TemplateOperationsService,
} from './template-operations.service.js';

const ORGANIZER_CONTACT_ACTION = 'organizer_contact_confirmed' as const;
const ACTIVE_REGISTRATION_STATUSES = ['confirmed', 'checked_in', 'completed'] as const;
const ACTIVE_TICKET_STATUSES = ['valid', 'used'] as const;
const INVOICE_ACTION_REQUIRED_STATUSES = [
  'awaiting_details',
  'issue_failed',
  'rejected',
  'adjustment_required',
] as const;
const INVOICE_PROCESSING_STATUSES = ['pending_review', 'issuing'] as const;

function asIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

export function deriveServiceHubTicketItem(
  registration: CustomerAttendeeServiceHub['registration'],
  latestPaymentStatus: CustomerPurchasedOrder['paymentStatus'] = null,
): CustomerServiceHubItem {
  if (registration.ticketStatus === 'valid') {
    return {
      code: 'ticket',
      state: 'complete',
      label: '电子票已生成',
      description: '现场出示二维码即可签到',
    };
  }
  if (registration.ticketStatus === 'used') {
    return {
      code: 'ticket',
      state: 'complete',
      label: '已完成签到',
      description: '本张电子票已经完成现场核验',
    };
  }
  if (registration.registrationStatus === 'pending_payment') {
    if (latestPaymentStatus === 'failed' || latestPaymentStatus === 'closed') {
      return {
        code: 'ticket',
        state: 'attention',
        label: latestPaymentStatus === 'failed' ? '上一笔支付未完成' : '支付单已关闭',
        description: '可重新发起支付，成功后系统会自动生成电子票',
      };
    }
    if (
      latestPaymentStatus &&
      ['preparing', 'processing', 'query_pending'].includes(latestPaymentStatus)
    ) {
      return {
        code: 'ticket',
        state: 'available',
        label: '支付结果确认中',
        description: '请先查看支付进度，避免重复发起付款',
      };
    }
    return {
      code: 'ticket',
      state: 'attention',
      label: '等待完成支付',
      description: '支付确认后系统会自动生成电子票',
    };
  }
  if (registration.registrationStatus === 'pending_review') {
    return {
      code: 'ticket',
      state: 'available',
      label: '报名审核中',
      description: '审核通过后将继续进入支付或出票',
    };
  }
  return {
    code: 'ticket',
    state: 'unavailable',
    label: registration.ticketStatus === 'cancelled' ? '电子票已失效' : '暂未生成电子票',
    description: '可在报名详情中查看当前处理原因',
  };
}

export function deriveServiceHubInvoiceItem(
  registration: CustomerAttendeeServiceHub['registration'],
): CustomerServiceHubItem {
  if (!registration.canManageOrder) {
    return {
      code: 'invoice',
      state: 'unavailable',
      label: '由购票人管理',
      description: '发票资料仅向订单购买人开放',
    };
  }
  if (registration.invoiceStatus === 'issued') {
    return {
      code: 'invoice',
      state: 'complete',
      label: '发票已开具',
      description: '可进入发票中心下载或重新发送',
    };
  }
  if (
    registration.invoiceStatus &&
    INVOICE_ACTION_REQUIRED_STATUSES.includes(registration.invoiceStatus as never)
  ) {
    return {
      code: 'invoice',
      state: 'attention',
      label: '发票资料待处理',
      description: '请进入发票中心完善或调整资料',
    };
  }
  if (
    registration.invoiceStatus &&
    INVOICE_PROCESSING_STATUSES.includes(registration.invoiceStatus as never)
  ) {
    return {
      code: 'invoice',
      state: 'available',
      label: '发票处理中',
      description: '审核与开具进度会在发票中心更新',
    };
  }
  if (
    !registration.invoiceId &&
    registration.amount > 0 &&
    ['paid', 'partially_refunded'].includes(registration.orderStatus)
  ) {
    return {
      code: 'invoice',
      state: 'available',
      label: '当前可以申请',
      description: '提交公司抬头、税号和接收邮箱',
    };
  }
  return {
    code: 'invoice',
    state: 'unavailable',
    label: registration.invoiceStatus ? '查看发票记录' : '当前不可申请',
    description: '收费订单完成支付后开放发票服务',
  };
}

export function serviceHubActionRequiredCount(items: CustomerServiceHubItem[]) {
  return items.filter(
    (item) =>
      !['poster', 'invoice'].includes(item.code) &&
      ['pending', 'attention'].includes(item.state),
  ).length;
}

@Injectable()
export class AttendeeServiceHubService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomerAccountService) private readonly accounts: CustomerAccountService,
    @Inject(AttendeeShowcaseService) private readonly showcases: AttendeeShowcaseService,
    @Inject(AttendeeNeedsService) private readonly needs: AttendeeNeedsService,
    @Inject(TemplateOperationsService) private readonly templates: TemplateOperationsService,
  ) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '大会服务台需要启用数据库后使用',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private async configurationRow(organizationId: string, eventId: number) {
    const [row] = await this.db()
      .select({
        config: eventAttendeeServiceConfigs,
        asset: templateAssets,
      })
      .from(eventAttendeeServiceConfigs)
      .leftJoin(
        templateAssets,
        eq(templateAssets.id, eventAttendeeServiceConfigs.organizerQrAssetId),
      )
      .where(
        and(
          eq(eventAttendeeServiceConfigs.organizationId, organizationId),
          eq(eventAttendeeServiceConfigs.eventId, eventId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async ensureEvent(organizationId: string, eventId: number) {
    const [event] = await this.db()
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
      .limit(1);
    if (!event) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在', HttpStatus.NOT_FOUND);
    }
  }

  private async latestPaymentStatus(orderId: string | null) {
    if (!orderId) return null;
    const [payment] = await this.db()
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
    return payment?.status ?? null;
  }

  async adminConfiguration(organizationId: string, eventId: number) {
    await this.ensureEvent(organizationId, eventId);
    const row = await this.configurationRow(organizationId, eventId);
    return EventAttendeeServiceConfigurationSchema.parse({
      eventId,
      enabled: row?.config.enabled ?? false,
      organizerName: row?.config.organizerName ?? '',
      organizerRole: row?.config.organizerRole ?? '',
      wechatId: row?.config.wechatId ?? '',
      instructions: row?.config.instructions ?? '',
      qrAssetId: row?.config.organizerQrAssetId ?? null,
      qrPreviewUrl: row?.asset
        ? await this.templates.protectedAssetUrl(organizationId, row.asset.id)
        : null,
      version: row?.config.version ?? 0,
      updatedAt: asIso(row?.config.updatedAt),
    });
  }

  async updateAdminConfiguration(
    organizationId: string,
    eventId: number,
    actorId: string,
    input: UpdateEventAttendeeServiceConfiguration,
  ) {
    const db = this.db();
    if (input.qrAssetId) {
      const [asset] = await db
        .select({
          id: templateAssets.id,
          mediaType: templateAssets.mediaType,
          size: templateAssets.size,
          altText: templateAssets.altText,
        })
        .from(templateAssets)
        .where(
          and(
            eq(templateAssets.id, input.qrAssetId),
            eq(templateAssets.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (
        !asset ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mediaType) ||
        asset.size > 2 * 1024 * 1024 ||
        asset.altText !== ATTENDEE_SERVICE_QR_ALT_TEXT
      ) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '组织者二维码不存在或无权使用',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`attendee-services:${organizationId}:${eventId}`}, 0))`,
      );
      const [event] = await tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
        .limit(1);
      if (!event) {
        throw new DomainError(API_ERROR_CODES.NOT_FOUND, '大会不存在', HttpStatus.NOT_FOUND);
      }
      const [current] = await tx
        .select()
        .from(eventAttendeeServiceConfigs)
        .where(eq(eventAttendeeServiceConfigs.eventId, eventId))
        .for('update')
        .limit(1);
      if ((current?.version ?? 0) !== input.version) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '参会者服务配置已被其他管理员更新，请刷新后重试',
          HttpStatus.CONFLICT,
          { currentVersion: current?.version ?? 0 },
        );
      }
      const values = {
        organizationId,
        eventId,
        enabled: input.enabled,
        organizerName: input.organizerName,
        organizerRole: input.organizerRole,
        wechatId: input.wechatId,
        instructions: input.instructions,
        organizerQrAssetId: input.qrAssetId,
        version: (current?.version ?? 0) + 1,
        updatedBy: actorId,
        updatedAt: new Date(),
      };
      if (current) {
        await tx
          .update(eventAttendeeServiceConfigs)
          .set(values)
          .where(eq(eventAttendeeServiceConfigs.eventId, eventId));
      } else {
        await tx.insert(eventAttendeeServiceConfigs).values(values);
      }
      await tx.insert(auditLogs).values({
        organizationId,
        eventId,
        actorId,
        action: 'event.attendee_service.update',
        resourceType: 'event_attendee_service',
        resourceId: String(eventId),
        before: current
          ? {
              enabled: current.enabled,
              organizerQrAssetId: current.organizerQrAssetId,
              version: current.version,
            }
          : null,
        after: {
          enabled: input.enabled,
          organizerQrAssetId: input.qrAssetId,
          version: values.version,
        },
        traceId: randomUUID(),
      });
    });
    return this.adminConfiguration(organizationId, eventId);
  }

  async prepareQrUpload(
    organizationId: string,
    eventId: number,
    actorId: string,
    input: AttendeeServiceQrUpload,
    commandKey: string,
  ) {
    await this.ensureEvent(organizationId, eventId);
    return this.templates.prepareAssetUpload(
      organizationId,
      actorId,
      { ...input, altText: ATTENDEE_SERVICE_QR_ALT_TEXT },
      commandKey,
    );
  }

  async confirmQrAsset(
    organizationId: string,
    eventId: number,
    actorId: string,
    input: ConfirmAttendeeServiceQrAsset,
  ) {
    await this.ensureEvent(organizationId, eventId);
    const asset = await this.templates.createAsset(organizationId, actorId, {
      ...input,
      altText: ATTENDEE_SERVICE_QR_ALT_TEXT,
    });
    return { assetId: asset.id, previewUrl: asset.previewUrl };
  }

  private async acknowledgement(
    organizationId: string,
    registrationId: string,
    customerUserId: string,
  ) {
    const [row] = await this.db()
      .select({ completedAt: registrationServiceAcknowledgements.completedAt })
      .from(registrationServiceAcknowledgements)
      .where(
        and(
          eq(registrationServiceAcknowledgements.organizationId, organizationId),
          eq(registrationServiceAcknowledgements.registrationId, registrationId),
          eq(registrationServiceAcknowledgements.customerUserId, customerUserId),
          eq(registrationServiceAcknowledgements.actionCode, ORGANIZER_CONTACT_ACTION),
        ),
      )
      .limit(1);
    return row?.completedAt ?? null;
  }

  private async organizerAccess(session: AuthenticatedCustomer, registrationId: string) {
    const registration = await this.accounts.registration(session, registrationId);
    const activeRegistration = ACTIVE_REGISTRATION_STATUSES.includes(
      registration.registrationStatus as never,
    );
    const activeTicket = ACTIVE_TICKET_STATUSES.includes(registration.ticketStatus as never);
    const configuration = await this.configurationRow(
      session.organizationId,
      registration.eventId,
    );
    const enabled = Boolean(
      configuration?.config.enabled &&
      configuration.config.organizerQrAssetId &&
      configuration.asset,
    );
    if (!activeRegistration || !activeTicket || !enabled || !configuration?.asset) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '当前报名不能访问组织者服务',
        HttpStatus.FORBIDDEN,
      );
    }
    return { registration, configuration };
  }

  async customerHub(
    session: AuthenticatedCustomer,
    registrationId: string,
  ): Promise<CustomerAttendeeServiceHub> {
    const registration = await this.accounts.registration(session, registrationId);
    const [showcaseResult, needsResult, configRow, confirmedAt, latestPaymentStatus] =
      await Promise.all([
        this.showcases.customerShowcase(session, registrationId).catch(() => null),
        this.needs.customerNeeds(session, registrationId).catch(() => null),
        this.configurationRow(session.organizationId, registration.eventId),
        this.acknowledgement(session.organizationId, registrationId, session.customerUserId),
        this.latestPaymentStatus(registration.orderId),
      ]);
    const activeRegistration = ACTIVE_REGISTRATION_STATUSES.includes(
      registration.registrationStatus as never,
    );
    const activeTicket = ACTIVE_TICKET_STATUSES.includes(registration.ticketStatus as never);
    const organizerEligible = activeRegistration && activeTicket;
    const organizerEnabled = Boolean(
      configRow?.config.enabled && configRow.config.organizerQrAssetId && configRow.asset,
    );

    const poster: CustomerServiceHubItem =
      !activeRegistration || !activeTicket
        ? {
            code: 'poster',
            state: showcaseResult?.id ? 'attention' : 'unavailable',
            label: showcaseResult?.id ? '参会资格已失效' : '取得电子票后开放',
            description: showcaseResult?.id
              ? '已有海报资料仍可进入查看'
              : '完成报名后可生成分享海报',
          }
        : showcaseResult?.id
          ? {
              code: 'poster',
              state: 'complete',
              label: '海报资料已就绪',
              description: '可随时生成并下载 1080 × 1440 分享海报',
            }
          : {
              code: 'poster',
              state: 'available',
              label: '可以生成海报',
              description: '完善姓名、公司与头像后分享效果更完整',
            };

    let showcase: CustomerServiceHubItem;
    if (!showcaseResult) {
      showcase = {
        code: 'showcase',
        state: 'attention',
        label: '名片状态读取失败',
        description: '可刷新服务台或直接进入参会名片页',
      };
    } else if (showcaseResult.adminHidden || (showcaseResult.id && !activeRegistration)) {
      showcase = {
        code: 'showcase',
        state: 'attention',
        label: showcaseResult.adminHidden ? '名片已被下架' : '展示资格已失效',
        description: showcaseResult.adminHiddenReason || '已有资料仍可进入管理',
      };
    } else if (showcaseResult.isPublic && showcaseResult.effectivePublic) {
      showcase = {
        code: 'showcase',
        state: 'complete',
        label: '已在大会首页展示',
        description: `资料完整度 ${showcaseResult.completion.score}%`,
      };
    } else if (showcaseResult.id) {
      showcase = {
        code: 'showcase',
        state: 'available',
        label: '已设置 · 仅自己可见',
        description: `资料完整度 ${showcaseResult.completion.score}%`,
      };
    } else if (activeRegistration && activeTicket) {
      showcase = {
        code: 'showcase',
        state: 'pending',
        label: '待完善首页名片',
        description: '可选择公开范围，保存后随时修改',
      };
    } else {
      showcase = {
        code: 'showcase',
        state: 'unavailable',
        label: '当前不可创建',
        description: '完成报名并取得有效电子票后开放',
      };
    }

    let needs: CustomerServiceHubItem;
    if (!needsResult) {
      needs = {
        code: 'needs',
        state: 'attention',
        label: '需求状态读取失败',
        description: '可刷新服务台后重新读取',
      };
    } else if (!needsResult.id && !needsResult.featureEnabled) {
      needs = {
        code: 'needs',
        state: 'unavailable',
        label: '大会暂未开放',
        description: '开放后可提交希望大会解决的问题',
      };
    } else if (!needsResult.id) {
      needs = {
        code: 'needs',
        state: needsResult.canCreate ? 'pending' : 'unavailable',
        label: needsResult.canCreate ? '待提交参会需求' : '当前不可提交',
        description: '最多提交 3 个问题，帮助嘉宾调整分享重点',
      };
    } else if (
      needsResult.adminRemovedCount > 0 ||
      needsResult.questions.some((question) => question.adminHidden || question.deletedByAdmin) ||
      !needsResult.qualified
    ) {
      needs = {
        code: 'needs',
        state: 'attention',
        label: needsResult.qualified ? '部分内容已隐藏' : '公开资格已失效',
        description: '进入参会需求页查看和调整已有内容',
      };
    } else {
      needs = {
        code: 'needs',
        state: needsResult.isPublic && needsResult.effectivePublic ? 'complete' : 'available',
        label: needsResult.isPublic
          ? needsResult.isAnonymous
            ? '已匿名提交'
            : '已实名提交'
          : '已提交 · 仅自己可见',
        description: `已保存 ${needsResult.questions.filter((question) => question.id).length} 个问题`,
      };
    }

    const organizer: CustomerServiceHubItem = !organizerEnabled
      ? {
          code: 'organizer_contact',
          state: 'unavailable',
          label: '暂未开放',
          description: '大会团队配置后可在这里添加组织者',
        }
      : !organizerEligible
        ? {
            code: 'organizer_contact',
            state: 'unavailable',
            label: '当前无参会资格',
            description: '仅向持有有效电子票的实际参会人开放',
          }
        : confirmedAt
          ? {
              code: 'organizer_contact',
              state: 'complete',
              label: '已确认添加',
              description: '等待大会组织者邀请进入参会群',
            }
          : {
              code: 'organizer_contact',
              state: 'pending',
              label: '待添加组织者',
              description: '扫码添加微信并申请进入参会群',
            };

    const items = [
      deriveServiceHubTicketItem(registration, latestPaymentStatus),
      poster,
      showcase,
      needs,
      organizer,
      deriveServiceHubInvoiceItem(registration),
    ];
    return CustomerAttendeeServiceHubSchema.parse({
      registration,
      items,
      organizerContact: {
        enabled: organizerEnabled,
        eligible: organizerEligible,
        organizerName:
          organizerEnabled && organizerEligible ? configRow!.config.organizerName : null,
        organizerRole:
          organizerEnabled && organizerEligible ? configRow!.config.organizerRole : null,
        wechatId: organizerEnabled && organizerEligible ? configRow!.config.wechatId : null,
        instructions: organizerEnabled && organizerEligible ? configRow!.config.instructions : null,
        qrAvailable: organizerEnabled && organizerEligible,
        confirmedAt: organizerEnabled && organizerEligible ? asIso(confirmedAt) : null,
      },
      latestPaymentStatus,
      actionRequiredCount: serviceHubActionRequiredCount(items),
      updatedAt: new Date().toISOString(),
    });
  }

  async setOrganizerContactConfirmed(
    session: AuthenticatedCustomer,
    registrationId: string,
    confirmed: boolean,
  ) {
    const { registration } = await this.organizerAccess(session, registrationId);
    const now = new Date();
    await this.db().transaction(async (tx) => {
      if (confirmed) {
        await tx
          .insert(registrationServiceAcknowledgements)
          .values({
            organizationId: session.organizationId,
            eventId: registration.eventId,
            registrationId,
            customerUserId: session.customerUserId,
            actionCode: ORGANIZER_CONTACT_ACTION,
            completedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              registrationServiceAcknowledgements.registrationId,
              registrationServiceAcknowledgements.actionCode,
            ],
            set: { customerUserId: session.customerUserId, completedAt: now },
          });
      } else {
        await tx
          .delete(registrationServiceAcknowledgements)
          .where(
            and(
              eq(registrationServiceAcknowledgements.organizationId, session.organizationId),
              eq(registrationServiceAcknowledgements.registrationId, registrationId),
              eq(registrationServiceAcknowledgements.customerUserId, session.customerUserId),
              eq(registrationServiceAcknowledgements.actionCode, ORGANIZER_CONTACT_ACTION),
            ),
          );
      }
      await tx.insert(auditLogs).values({
        organizationId: session.organizationId,
        eventId: registration.eventId,
        actorId: session.customerUserId,
        actorType: 'customer',
        action: confirmed
          ? 'registration_service.organizer_contact.confirm'
          : 'registration_service.organizer_contact.reopen',
        resourceType: 'registration_service_acknowledgement',
        resourceId: registrationId,
        after: { actionCode: ORGANIZER_CONTACT_ACTION, confirmed },
        traceId: randomUUID(),
      });
    });
    return { confirmed, confirmedAt: confirmed ? now.toISOString() : null };
  }

  async customerOrganizerQrContent(session: AuthenticatedCustomer, registrationId: string) {
    const { configuration } = await this.organizerAccess(session, registrationId);
    const url = await this.templates.protectedAssetUrl(
      session.organizationId,
      configuration.asset!.id,
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (!response?.ok) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '组织者二维码暂时无法读取，请稍后重试',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ||
      configuration.asset!.size > 2 * 1024 * 1024
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '组织者二维码文件校验失败',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength !== configuration.asset!.size) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '组织者二维码文件大小校验失败',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return { body, contentType };
  }
}
