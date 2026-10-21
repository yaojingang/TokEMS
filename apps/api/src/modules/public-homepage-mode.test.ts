import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import type { OrganizationAdminService } from '../common/organization-admin.service.js';
import type { ConferenceRepository } from '../common/conference.repository.js';
import type { HtmlTemplateOperationsService } from '../common/html-template-operations.service.js';
import type { DatabaseService } from '../common/database.service.js';
import { HomepageController } from './public.module.js';

describe('root homepage mode', () => {
  it('keeps structured demo root rendering available without PostgreSQL', async () => {
    const organization = {
      getHomepageConfigurationBySlug: vi.fn().mockRejectedValue(new Error('PostgreSQL required')),
    };
    const repository = { getPublicHomepageEvent: vi.fn().mockResolvedValue({ slug: 'demo' }) };
    const templates = { renderPublishedHome: vi.fn().mockResolvedValue(undefined) };
    const reply = {
      code: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const controller = new HomepageController(
      organization as unknown as OrganizationAdminService,
      repository as unknown as ConferenceRepository,
      templates as unknown as HtmlTemplateOperationsService,
      { persistent: false } as DatabaseService,
    );
    await controller.getHomeDocument('geo-conference', undefined, reply as unknown as FastifyReply);
    expect(organization.getHomepageConfigurationBySlug).not.toHaveBeenCalled();
    expect(repository.getPublicHomepageEvent).toHaveBeenCalledWith('geo-conference');
    expect(reply.code).toHaveBeenCalledWith(204);
  });
});
