import { createHash, randomUUID } from 'node:crypto';
import {
  ConferenceTemplateDefinitionSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  type ConferenceTemplateDefinition,
} from '@conference/contracts';
import { and, asc, desc, eq, inArray, isNull, sum } from 'drizzle-orm';
import { createDatabase } from './index.js';
import {
  conferenceTemplateDrafts,
  conferenceTemplates,
  conferenceTemplateVersions,
  eventBlueprints,
  events,
  eventTemplateBindings,
  invoiceRequests,
  invoiceStateLogs,
  orders,
  organizations,
  outboxEvents,
  refunds,
  registrations,
  templatePackages,
} from './schema.js';

const apply = process.argv.includes('--apply');
const { db, pool } = createDatabase();

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requestNo() {
  return `INV${new Date().getFullYear()}${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function legacyDefinition(
  snapshot: Record<string, unknown>,
  clonePolicy: Record<string, 'COPY' | 'RESET' | 'REFERENCE' | 'EXCLUDE'>,
) {
  const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
  const faqs = Array.isArray(snapshot.faqs) ? snapshot.faqs : [];
  definition.faq.items = faqs.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.question !== 'string' || typeof record.answer !== 'string') return [];
    return [
      {
        nodeKey: `faq.legacy-${index + 1}`,
        category: '常见问题',
        question: record.question,
        answer: record.answer,
        enabled: true,
      },
    ];
  });
  const ticketTypes = Array.isArray(snapshot.ticketTypes)
    ? snapshot.ticketTypes.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
      )
    : [];
  const form = snapshot.registrationForm;
  const fields =
    form && typeof form === 'object' && Array.isArray((form as Record<string, unknown>).fields)
      ? (form as { fields: unknown[] }).fields
      : [];
  definition.initialization = {
    ...definition.initialization,
    copyPolicy: clonePolicy,
    ticketTypes,
    registrationFields: fields.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const field = item as Record<string, unknown>;
      if (
        typeof field.key !== 'string' ||
        !/^[a-z][a-z0-9_]*$/.test(field.key) ||
        typeof field.label !== 'string' ||
        !['text', 'email', 'tel', 'select'].includes(String(field.type)) ||
        typeof field.required !== 'boolean'
      ) {
        return [];
      }
      return [
        {
          key: field.key,
          label: field.label,
          type: field.type as 'text' | 'email' | 'tel' | 'select',
          required: field.required,
          ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder } : {}),
          ...(Array.isArray(field.options) &&
          field.options.every((option) => typeof option === 'string')
            ? { options: field.options as string[] }
            : {}),
        },
      ];
    }),
  };
  return ConferenceTemplateDefinitionSchema.parse(definition);
}

async function inspect() {
  const [organizationRows, blueprintRows, eventRows, invoiceIntents, templateRows] =
    await Promise.all([
      db.select().from(organizations),
      db.select().from(eventBlueprints),
      db
        .select({ id: events.id })
        .from(events)
        .leftJoin(eventTemplateBindings, eq(eventTemplateBindings.eventId, events.id))
        .where(isNull(eventTemplateBindings.eventId)),
      db
        .select({ id: orders.id })
        .from(orders)
        .innerJoin(registrations, eq(registrations.id, orders.registrationId))
        .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
        .where(
          and(
            eq(registrations.invoiceRequired, true),
            inArray(orders.status, ['paid', 'partially_refunded']),
            isNull(invoiceRequests.id),
          ),
        ),
      db.select({ id: conferenceTemplates.id }).from(conferenceTemplates),
    ]);
  return {
    organizations: organizationRows.length,
    legacyBlueprints: blueprintRows.length,
    existingTemplates: templateRows.length,
    unboundEvents: eventRows.length,
    paidInvoiceIntents: invoiceIntents.length,
  };
}

const preview = await inspect();
console.info(
  JSON.stringify(
    {
      mode: apply ? 'apply' : 'dry-run',
      ...preview,
      note: apply
        ? 'Migration changes will be committed.'
        : 'No changes were made. Re-run with --apply to migrate.',
    },
    null,
    2,
  ),
);

if (apply) {
  await db.transaction(async (tx) => {
    const rendererRows = await tx
      .select()
      .from(templatePackages)
      .where(eq(templatePackages.status, 'published'))
      .orderBy(asc(templatePackages.name), desc(templatePackages.version));
    const [renderer] = rendererRows;
    if (!renderer) throw new Error('At least one published template package is required');

    const organizationRows = await tx.select().from(organizations);
    const blueprintRows = await tx.select().from(eventBlueprints);
    const blueprintTemplates = new Map<string, { rootId: string; versionId: string }>();
    const organizationDefaults = new Map<string, { rootId: string; versionId: string }>();

    for (const organization of organizationRows) {
      const code = 'base-blank-v1';
      const [existing] = await tx
        .select()
        .from(conferenceTemplates)
        .where(
          and(
            eq(conferenceTemplates.organizationId, organization.id),
            eq(conferenceTemplates.code, code),
          ),
        )
        .limit(1);
      if (existing?.currentPublishedVersionId) {
        organizationDefaults.set(organization.id, {
          rootId: existing.id,
          versionId: existing.currentPublishedVersionId,
        });
      } else if (!existing) {
        const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
        const [root] = await tx
          .insert(conferenceTemplates)
          .values({
            organizationId: organization.id,
            code,
            name: '基础空白模板',
            description: '迁移生成的基础模板，适用于新建大会和历史大会兜底。',
            tags: ['系统基础'],
          })
          .returning();
        const contentDigest = digest(definition);
        const [version] = await tx
          .insert(conferenceTemplateVersions)
          .values({
            templateId: root!.id,
            version: 1,
            rendererPackageId: renderer.id,
            schemaVersion: 2,
            definition,
            contentDigest,
            changeSummary: '历史数据迁移生成 V1',
          })
          .returning();
        await tx.insert(conferenceTemplateDrafts).values({
          templateId: root!.id,
          rendererPackageId: renderer.id,
          schemaVersion: 2,
          definition,
          contentDigest,
        });
        await tx
          .update(conferenceTemplates)
          .set({ currentPublishedVersionId: version!.id })
          .where(eq(conferenceTemplates.id, root!.id));
        organizationDefaults.set(organization.id, {
          rootId: root!.id,
          versionId: version!.id,
        });
      }
    }

    for (const blueprint of blueprintRows) {
      const code = `legacy-${blueprint.id}`;
      const [existing] = await tx
        .select()
        .from(conferenceTemplates)
        .where(
          and(
            eq(conferenceTemplates.organizationId, blueprint.organizationId),
            eq(conferenceTemplates.code, code),
          ),
        )
        .limit(1);
      if (existing?.currentPublishedVersionId) {
        blueprintTemplates.set(blueprint.id, {
          rootId: existing.id,
          versionId: existing.currentPublishedVersionId,
        });
        continue;
      }
      if (existing) continue;
      const definition: ConferenceTemplateDefinition = legacyDefinition(
        blueprint.snapshot,
        blueprint.clonePolicy,
      );
      const blueprintTemplateKey =
        typeof blueprint.snapshot.templateKey === 'string'
          ? blueprint.snapshot.templateKey
          : undefined;
      const blueprintRenderer = blueprintTemplateKey
        ? rendererRows.find((item) => item.key === blueprintTemplateKey)
        : renderer;
      if (!blueprintRenderer) {
        throw new Error(
          `Blueprint ${blueprint.id} requires unavailable renderer ${blueprintTemplateKey}`,
        );
      }
      const contentDigest = digest(definition);
      const [root] = await tx
        .insert(conferenceTemplates)
        .values({
          organizationId: blueprint.organizationId,
          code,
          name: blueprint.name,
          description: `由历史大会蓝图 V${blueprint.version} 迁移生成。`,
          tags: ['历史蓝图'],
        })
        .returning();
      const [version] = await tx
        .insert(conferenceTemplateVersions)
        .values({
          templateId: root!.id,
          version: 1,
          rendererPackageId: blueprintRenderer.id,
          schemaVersion: 2,
          definition,
          contentDigest,
          changeSummary: `由历史蓝图 V${blueprint.version} 迁移生成`,
        })
        .returning();
      await tx.insert(conferenceTemplateDrafts).values({
        templateId: root!.id,
        rendererPackageId: blueprintRenderer.id,
        schemaVersion: 2,
        definition,
        contentDigest,
      });
      await tx
        .update(conferenceTemplates)
        .set({ currentPublishedVersionId: version!.id })
        .where(eq(conferenceTemplates.id, root!.id));
      blueprintTemplates.set(blueprint.id, {
        rootId: root!.id,
        versionId: version!.id,
      });
    }

    for (const organization of organizationRows) {
      const settings = organization.settings;
      const mapped =
        settings.defaultBlueprintId && blueprintTemplates.get(settings.defaultBlueprintId);
      const fallback = organizationDefaults.get(organization.id);
      const selected = mapped ?? fallback;
      if (!selected) continue;
      await tx
        .update(organizations)
        .set({
          settings: { ...settings, defaultTemplateId: selected.rootId },
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organization.id));
    }

    const unboundEvents = await tx
      .select({ event: events })
      .from(events)
      .leftJoin(eventTemplateBindings, eq(eventTemplateBindings.eventId, events.id))
      .where(isNull(eventTemplateBindings.eventId));
    for (const { event } of unboundEvents) {
      const sourceBlueprintId =
        typeof event.settings.sourceBlueprintId === 'string'
          ? event.settings.sourceBlueprintId
          : undefined;
      const selected =
        (sourceBlueprintId ? blueprintTemplates.get(sourceBlueprintId) : undefined) ??
        organizationDefaults.get(event.organizationId);
      if (!selected) continue;
      await tx
        .insert(eventTemplateBindings)
        .values({ eventId: event.id, templateVersionId: selected.versionId })
        .onConflictDoNothing();
    }

    const invoiceIntents = await tx
      .select({ order: orders, registration: registrations })
      .from(orders)
      .innerJoin(registrations, eq(registrations.id, orders.registrationId))
      .leftJoin(invoiceRequests, eq(invoiceRequests.orderId, orders.id))
      .where(
        and(
          eq(registrations.invoiceRequired, true),
          inArray(orders.status, ['paid', 'partially_refunded']),
          isNull(invoiceRequests.id),
        ),
      );
    for (const { order, registration } of invoiceIntents) {
      const [refundTotal] = await tx
        .select({ amount: sum(refunds.amount) })
        .from(refunds)
        .where(and(eq(refunds.orderId, order.id), eq(refunds.status, 'succeeded')));
      const netPaidAmount = Math.max(0, order.amount - Number(refundTotal?.amount ?? 0));
      if (netPaidAmount <= 0) continue;
      const [invoice] = await tx
        .insert(invoiceRequests)
        .values({
          requestNo: requestNo(),
          organizationId: order.organizationId,
          eventId: order.eventId,
          orderId: order.id,
          registrationId: registration.id,
          amount: netPaidAmount,
          currency: order.currency,
          netPaidAmount,
        })
        .onConflictDoNothing()
        .returning();
      if (!invoice) continue;
      await tx.insert(invoiceStateLogs).values({
        invoiceRequestId: invoice.id,
        fromStatus: null,
        toStatus: 'awaiting_details',
        reason: '历史开票意向迁移生成',
        metadata: { source: 'migration' },
      });
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
      await tx.insert(outboxEvents).values({
        organizationId: order.organizationId,
        eventId: order.eventId,
        eventType: 'InvoiceDetailsRequested',
        correlationId: `invoice:migration:${invoice.id}`,
        payload: {
          invoiceId: invoice.id,
          orderId: order.id,
          recipient: registration.attendee.email,
          expiresAt: expiresAt.toISOString(),
        },
      });
    }
  });
  console.info(JSON.stringify({ mode: 'apply', completed: true, after: await inspect() }, null, 2));
}

await pool.end();
