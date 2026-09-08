import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

@Controller('compatibility')
class CompatibilityController {
  @Get('limited')
  limited() {
    return { ok: true };
  }

  @Get('skipped')
  @SkipThrottle()
  skipped() {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1 }])],
  controllers: [CompatibilityController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class CompatibilityModule {}

describe('Nest runtime dependency compatibility', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      CompatibilityModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('generates OpenAPI routes using the installed core and Swagger packages', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Compatibility verification').setVersion('1').build(),
    );
    expect(document.paths['/compatibility/limited']?.get).toBeDefined();
    expect(document.paths['/compatibility/skipped']?.get).toBeDefined();
  });

  it('enforces the global throttler and honors SkipThrottle', async () => {
    const server = app.getHttpAdapter().getInstance();
    const first = await server.inject({ method: 'GET', url: '/compatibility/limited' });
    const repeated = await server.inject({ method: 'GET', url: '/compatibility/limited' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    expect(repeated.statusCode).toBe(429);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const skipped = await server.inject({ method: 'GET', url: '/compatibility/skipped' });
      expect(skipped.statusCode).toBe(200);
    }
  });
});
