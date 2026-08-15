import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './modules/admin.module.js';
import { AuthModule } from './modules/auth.module.js';
import { HealthModule } from './modules/health.module.js';
import { PublicModule } from './modules/public.module.js';
import { OperationsModule } from './modules/operations.module.js';
import { CoreModule } from './common/core.module.js';
import { TemplateInvoiceModule } from './modules/template-invoice.module.js';
import { CustomerModule } from './modules/customer.module.js';
import { configuredSuperAdministratorId } from './common/staff-account.js';

const jwtSecret = process.env.JWT_SECRET ?? 'conference-local-development-secret-2026';
configuredSuperAdministratorId();
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET ||
    jwtSecret.length < 32 ||
    [
      'conference-local-development-secret-2026',
      'conference-local-docker-jwt-secret-change-me-2026',
      'replace-with-at-least-32-random-characters',
    ].includes(jwtSecret))
) {
  throw new Error('JWT_SECRET with at least 32 characters is required in production');
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      global: true,
      secret: jwtSecret,
      signOptions: { expiresIn: '8h' },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 5_000),
      },
    ]),
    CoreModule,
    AuthModule,
    PublicModule,
    AdminModule,
    OperationsModule,
    TemplateInvoiceModule,
    CustomerModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
