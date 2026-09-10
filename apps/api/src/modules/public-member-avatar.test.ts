import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { HttpStatus } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { API_ERROR_CODES } from '@conference/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendeeNeedsService } from '../common/attendee-needs.service.js';
import { AttendeeShowcaseService } from '../common/attendee-showcase.service.js';
import { ConferenceRepository } from '../common/conference.repository.js';
import { DomainError } from '../common/domain-error.js';
import { EventPublicMetricsService } from '../common/event-public-metrics.service.js';
import { HtmlTemplateOperationsService } from '../common/html-template-operations.service.js';
import { EventsController } from './public.module.js';

describe('public member avatar resource policy', () => {
  let app: NestFastifyApplication;
  const publicAvatarContent = vi.fn();
  const avatar = Buffer.from('public-avatar-content');
  const url = '/events/tokems26/members/public-member/avatar?organization=geo-conference';
  const headers = {
    host: '127.0.0.1:4100',
    origin: 'http://127.0.0.1:3000',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'image',
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: ConferenceRepository, useValue: {} },
        { provide: HtmlTemplateOperationsService, useValue: {} },
        { provide: AttendeeShowcaseService, useValue: { publicAvatarContent } },
        { provide: AttendeeNeedsService, useValue: {} },
        { provide: EventPublicMetricsService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.register(helmet, { contentSecurityPolicy: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    publicAvatarContent.mockReset().mockResolvedValue(avatar);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('allows a separate frontend origin to embed an eligible public avatar', async () => {
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(avatar);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(publicAvatarContent).toHaveBeenCalledWith('tokems26', 'geo-conference', 'public-member');
  });

  it('rechecks public eligibility and keeps a withdrawn avatar protected', async () => {
    const initial = await app.inject({ method: 'GET', url, headers });
    expect(initial.statusCode).toBe(200);
    publicAvatarContent.mockRejectedValueOnce(
      new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '参会名片不存在或已停止公开',
        HttpStatus.NOT_FOUND,
      ),
    );
    const withdrawn = await app.inject({ method: 'GET', url, headers });
    expect(publicAvatarContent).toHaveBeenCalledTimes(2);
    expect(withdrawn.statusCode).toBe(404);
    expect(withdrawn.headers['content-type']).toContain('application/json');
    expect(withdrawn.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(withdrawn.rawPayload).not.toEqual(avatar);
  });

  it('rejects an invalid organization before reading or exposing an avatar', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url.replace('geo-conference', 'invalid%2Forganization'),
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(publicAvatarContent).not.toHaveBeenCalled();
  });
});
