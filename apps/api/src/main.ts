import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { Logger, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { isLoopbackHostname, resolveDeploymentOrigins } from '@conference/security';
import type { FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';

function requestId(request: IncomingMessage) {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

async function bootstrap() {
  const fakeOtpEnabled =
    process.env.CUSTOMER_OTP_MODE === 'fake' ||
    (!process.env.CUSTOMER_OTP_MODE && process.env.DEPLOYMENT_MODE === 'local');
  const bindAddress = process.env.API_BIND_ADDRESS ?? (fakeOtpEnabled ? '127.0.0.1' : '0.0.0.0');
  if (
    fakeOtpEnabled &&
    !isLoopbackHostname(bindAddress) &&
    process.env.API_INTERNAL_CONTAINER !== 'true'
  ) {
    throw new Error('Local fake OTP source deployment requires API_BIND_ADDRESS to be loopback');
  }
  const trustProxy =
    process.env.TRUST_PROXY?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? (process.env.NODE_ENV === 'production' ? false : ['127.0.0.1', '::1']);
  const adapter = new FastifyAdapter({
    trustProxy,
    logger:
      process.env.NODE_ENV === 'production'
        ? {
            serializers: {
              req(request: FastifyRequest) {
                return {
                  method: request.method,
                  url: String(request.url).split('?')[0] ?? '/',
                  remoteAddress: request.ip,
                };
              },
            },
          }
        : false,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: requestId,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true,
  });
  const port = Number(process.env.API_PORT ?? 4100);

  await app.register(
    helmet,
    process.env.NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false },
  );
  await app.register(cookie);
  app.enableCors({
    origin: resolveDeploymentOrigins().corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'DPoP',
      'Idempotency-Key',
      'X-Agent-Operation-Id',
      'X-Agent-Request-Hash',
      'X-Agent-Before-Fingerprint',
      'X-Agent-Current-State-Token',
      'X-Agent-Purpose',
      'X-Request-Id',
      'X-Organization-Slug',
      'X-Device-Token',
      'X-Payment-Timestamp',
      'X-Payment-Signature',
      'X-CSRF-Token',
      'X-Wechat-OAuth-Session',
      'X-Payment-Channel',
    ],
    exposedHeaders: ['Content-Disposition', 'X-Export-Row-Count', 'X-Agent-State-Token'],
  });
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: '.well-known/tokems-agent', method: RequestMethod.GET },
      { path: '.well-known/oauth-authorization-server', method: RequestMethod.GET },
    ],
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle('大会报名与运营平台 API')
    .setDescription('大会、报名、订单、支付、票证、签到与运营后台 API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, openApi);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });

  await app.listen(port, bindAddress);
  Logger.log(`Conference API is listening on http://localhost:${port}/api/v1`, 'Bootstrap');
}

void bootstrap();
