import 'reflect-metadata';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateOperationsService } from '../common/template-operations.service.js';
import { TemplateAssetsController } from './public.module.js';

describe('public template assets', () => {
  it('allows public sites on a separate origin to follow the asset redirect', async () => {
    const publicAssetUrl = vi.fn().mockResolvedValue('http://storage.test/logo.png?signature=valid');
    const templates = { publicAssetUrl } as unknown as TemplateOperationsService;
    const reply = {
      header: vi.fn(),
      code: vi.fn(),
      redirect: vi.fn().mockReturnValue('redirected'),
    };
    reply.header.mockReturnValue(reply);
    reply.code.mockReturnValue(reply);

    const result = await new TemplateAssetsController(templates).asset(
      'b31a178f-a55b-4363-9ca9-6da23ab8d54b',
      reply as unknown as FastifyReply,
    );

    expect(publicAssetUrl).toHaveBeenCalledWith('b31a178f-a55b-4363-9ca9-6da23ab8d54b');
    expect(reply.header).toHaveBeenCalledWith('Cross-Origin-Resource-Policy', 'cross-origin');
    expect(reply.code).toHaveBeenCalledWith(302);
    expect(reply.redirect).toHaveBeenCalledWith('http://storage.test/logo.png?signature=valid');
    expect(result).toBe('redirected');
  });
});
