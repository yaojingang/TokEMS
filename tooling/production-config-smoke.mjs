import { spawnSync } from 'node:child_process';
import {
  localComposeEnvironment,
  resolveGatewayEnvironment,
} from './lib/local-compose-environment.mjs';

function composeConfig(environment) {
  return spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
}

const missingSecrets = composeConfig({
  DEPLOYMENT_MODE: 'production',
  PUBLIC_ORIGIN: 'https://conference.example.com',
  ADMIN_ORIGIN: 'https://admin.conference.example.com',
  JWT_SECRET: '',
  CUSTOMER_OTP_PEPPER: '',
  CUSTOMER_SESSION_SECRET: '',
  NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET: '',
  NOTIFICATION_WEBHOOK_TOKEN: '',
});
if (missingSecrets.status === 0) {
  throw new Error('Production Compose accepted missing authentication secrets');
}

const validSecrets = composeConfig({
  DEPLOYMENT_MODE: 'production',
  PUBLIC_ORIGIN: 'https://conference.example.com',
  ADMIN_ORIGIN: 'https://admin.conference.example.com',
  PAYMENT_PUBLIC_ORIGIN: 'https://www.example.com',
  PAYMENT_PUBLIC_BASE_PATH: '/pay/hui',
  PAYMENT_PUBLIC_URL: 'https://www.example.com/pay/hui',
  JWT_SECRET: 'jwt-secret-for-config-test-at-least-32-characters',
  CUSTOMER_OTP_PEPPER: 'otp-pepper-for-config-test-at-least-32-characters',
  CUSTOMER_SESSION_SECRET: 'session-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET:
    'notification-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_WEBHOOK_TOKEN: 'notification-webhook-token-for-config-test',
  NOTIFICATION_WEBHOOK_URL: 'https://notifications.example.com/hooks/tokems',
  CUSTOMER_OTP_PLATFORM_HOURLY_LIMIT: '12',
  DATABASE_POOL_SIZE: '20',
  INVOICE_DOWNLOAD_SIGNING_SECRET: 'invoice-download-secret-for-config-test-at-least-32-characters',
  DOCKER_S3_ENDPOINT: 'https://s3-internal.example.com',
  S3_PUBLIC_ENDPOINT: 'https://assets.example.com',
  S3_ACCESS_KEY: 'production-s3-access-key',
  S3_SECRET_KEY: 'production-s3-secret-key',
  S3_REGION: 'cn-east-1',
  AI_API_URL: 'https://ai.example.com/v1/chat/completions',
  AI_API_KEY: 'ai-key-for-config-test',
  AI_MODEL: 'tokems-copywriter',
  ADMIN_USER_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
});
if (validSecrets.status !== 0) {
  throw new Error(`Production Compose rejected valid secrets: ${validSecrets.stderr}`);
}

const missingOrigin = composeConfig({
  DEPLOYMENT_MODE: 'production',
  PUBLIC_ORIGIN: '',
  ADMIN_ORIGIN: 'https://admin.conference.example.com',
  JWT_SECRET: 'jwt-secret-for-config-test-at-least-32-characters',
  CUSTOMER_OTP_PEPPER: 'otp-pepper-for-config-test-at-least-32-characters',
  CUSTOMER_SESSION_SECRET: 'session-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET:
    'notification-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_WEBHOOK_TOKEN: 'notification-webhook-token-for-config-test',
});
if (missingOrigin.status === 0) {
  throw new Error('Production Compose accepted a missing PUBLIC_ORIGIN');
}

const missingAdminOrigin = composeConfig({
  DEPLOYMENT_MODE: 'production',
  PUBLIC_ORIGIN: 'https://conference.example.com',
  ADMIN_ORIGIN: '',
  JWT_SECRET: 'jwt-secret-for-config-test-at-least-32-characters',
  CUSTOMER_OTP_PEPPER: 'otp-pepper-for-config-test-at-least-32-characters',
  CUSTOMER_SESSION_SECRET: 'session-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET:
    'notification-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_WEBHOOK_TOKEN: 'notification-webhook-token-for-config-test',
});
if (missingAdminOrigin.status === 0) {
  throw new Error('Production Compose accepted a missing ADMIN_ORIGIN');
}

const configuration = JSON.parse(validSecrets.stdout);
if (configuration.name !== 'tokems') {
  throw new Error(`Compose project name must be tokems, received ${configuration.name}`);
}
for (const serviceName of ['api', 'web', 'payment-web', 'admin']) {
  if (configuration.services[serviceName].ports) {
    throw new Error(`${serviceName} unexpectedly publishes a host port`);
  }
}
if (!configuration.services.gateway.ports?.length) {
  throw new Error('Gateway does not publish the unified host port');
}
for (const serviceName of ['postgres', 'redis', 'minio', 'mailpit', 'notification-sink']) {
  const publishedPorts = configuration.services[serviceName].ports ?? [];
  if (!publishedPorts.length || publishedPorts.some((port) => port.host_ip !== '127.0.0.1')) {
    throw new Error(`${serviceName} host ports must stay bound to 127.0.0.1`);
  }
}
for (const [serviceName, imageName] of Object.entries({
  api: 'tokems-api:local',
  worker: 'tokems-worker:local',
  web: 'tokems-web:local',
  'payment-web': 'tokems-web:local',
  admin: 'tokems-admin:local',
  gateway: 'tokems-gateway:local',
  'notification-sink': 'tokems-notification-sink:local',
})) {
  if (configuration.services[serviceName].image !== imageName) {
    throw new Error(`${serviceName} image must be ${imageName}`);
  }
}
if (!configuration.services['payment-web']) {
  throw new Error('payment-web service is missing from Compose config');
}
if (
  configuration.services['payment-web'].environment.NUXT_PUBLIC_PAYMENT_SURFACE !== 'true' &&
  configuration.services['payment-web'].environment.NUXT_PUBLIC_PAYMENT_SURFACE !== true
) {
  throw new Error('payment-web must set NUXT_PUBLIC_PAYMENT_SURFACE=true');
}
if (
  !String(configuration.services['payment-web'].environment.NUXT_APP_BASE_URL ?? '').includes(
    '/pay/hui',
  )
) {
  throw new Error('payment-web must use /pay/hui/ as NUXT_APP_BASE_URL');
}
if (configuration.services.api.environment.PAYMENT_PUBLIC_ORIGIN !== 'https://www.example.com') {
  throw new Error('PAYMENT_PUBLIC_ORIGIN is not forwarded to the API container');
}
for (const volumeName of ['tokems-postgres', 'tokems-redis', 'tokems-minio']) {
  if (configuration.volumes[volumeName]?.name !== volumeName) {
    throw new Error(`${volumeName} must use an explicit TokEMS volume name`);
  }
}
if (
  configuration.services.worker.environment.NOTIFICATION_WEBHOOK_URL !==
  'https://notifications.example.com/hooks/tokems'
) {
  throw new Error('Production notification provider URL is not forwarded to the worker');
}
for (const [name, value] of Object.entries({
  CUSTOMER_OTP_PLATFORM_HOURLY_LIMIT: '12',
  DATABASE_POOL_SIZE: '20',
  INVOICE_DOWNLOAD_SIGNING_SECRET: 'invoice-download-secret-for-config-test-at-least-32-characters',
  S3_ENDPOINT: 'https://s3-internal.example.com',
  S3_PUBLIC_ENDPOINT: 'https://assets.example.com',
  S3_ACCESS_KEY: 'production-s3-access-key',
  S3_SECRET_KEY: 'production-s3-secret-key',
  S3_REGION: 'cn-east-1',
  AI_API_URL: 'https://ai.example.com/v1/chat/completions',
  AI_API_KEY: 'ai-key-for-config-test',
  AI_MODEL: 'tokems-copywriter',
  ADMIN_USER_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
})) {
  if (configuration.services.api.environment[name] !== value) {
    throw new Error(`Production ${name} is not forwarded to the API container`);
  }
}

const productionWrapper = localComposeEnvironment({
  DEPLOYMENT_MODE: 'production',
  PUBLIC_ORIGIN: 'https://conference.example.com',
  ADMIN_ORIGIN: 'https://admin.conference.example.com',
  JWT_SECRET: 'wrapper-jwt-secret-for-config-test-at-least-32-characters',
  CUSTOMER_OTP_PEPPER: 'wrapper-otp-pepper-for-config-test-at-least-32-characters',
  CUSTOMER_SESSION_SECRET: 'wrapper-session-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET:
    'wrapper-notification-secret-for-config-test-at-least-32-characters',
  NOTIFICATION_WEBHOOK_TOKEN: 'wrapper-notification-webhook-token-for-config-test',
  NOTIFICATION_WEBHOOK_URL: 'https://notifications.example.com/hooks/tokems',
  ADMIN_USERNAME: 'production-admin',
  ADMIN_USER_ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ADMIN_PASSWORD: 'production-admin-password-at-least-16',
  ALLOW_INSECURE_LOCAL_AUTH: 'true',
  CUSTOMER_OTP_MODE: 'fake',
  CUSTOMER_OTP_DEV_RESPONSE: 'true',
  NUXT_PUBLIC_SIMPLE_AUTH: 'true',
  VITE_SIMPLE_AUTH: 'true',
});
if (productionWrapper.DEPLOYMENT_MODE !== 'production') {
  throw new Error('Docker deployment wrapper replaced production mode with local mode');
}
for (const flag of ['ALLOW_INSECURE_LOCAL_AUTH', 'VITE_SIMPLE_AUTH']) {
  if (productionWrapper[flag] !== 'false') {
    throw new Error(`Production Docker deployment must force ${flag}=false`);
  }
}
if (productionWrapper.CUSTOMER_OTP_MODE !== 'provider') {
  throw new Error('Production Docker deployment must force CUSTOMER_OTP_MODE=provider');
}
for (const removedKey of ['CUSTOMER_OTP_DEV_RESPONSE', 'NUXT_PUBLIC_SIMPLE_AUTH']) {
  if (removedKey in productionWrapper) {
    throw new Error(`Production Docker deployment retained removed key ${removedKey}`);
  }
}
if (
  productionWrapper.ADMIN_USERNAME !== 'production-admin' ||
  productionWrapper.ADMIN_USER_ID !== 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' ||
  productionWrapper.ADMIN_PASSWORD !== 'production-admin-password-at-least-16'
) {
  throw new Error('Docker deployment wrapper replaced production administrator credentials');
}
const productionWrapperConfig = composeConfig(productionWrapper);
if (productionWrapperConfig.status !== 0) {
  throw new Error(`Docker deployment wrapper produced invalid Compose config`);
}
const wrappedConfiguration = JSON.parse(productionWrapperConfig.stdout);
if (wrappedConfiguration.services.admin.build.args.VITE_SIMPLE_AUTH !== 'false') {
  throw new Error('Production Docker image enabled the local administrator login interface');
}
if (
  'NUXT_PUBLIC_SIMPLE_AUTH' in (wrappedConfiguration.services.web.build.args ?? {}) ||
  'NUXT_PUBLIC_SIMPLE_AUTH' in (wrappedConfiguration.services.web.environment ?? {})
) {
  throw new Error('Web Docker image still exposes the removed password login flag');
}
if (wrappedConfiguration.services.api.environment.CUSTOMER_OTP_MODE !== 'provider') {
  throw new Error('Production API did not receive CUSTOMER_OTP_MODE=provider');
}

let externalLocalGatewayRejected = false;
try {
  localComposeEnvironment({
    DEPLOYMENT_MODE: 'local',
    GATEWAY_BIND_ADDRESS: '0.0.0.0',
  });
} catch (error) {
  externalLocalGatewayRejected = String(error).includes(
    'Local fake OTP deployment requires GATEWAY_BIND_ADDRESS to be loopback',
  );
}
if (!externalLocalGatewayRejected) {
  throw new Error('Local fake OTP deployment accepted a non-loopback gateway bind address');
}

const projectGateway = resolveGatewayEnvironment(
  {},
  {
    GATEWAY_PORT: '9090',
    PUBLIC_ORIGIN: 'http://localhost:9090',
    ADMIN_ORIGIN: 'http://admin.localhost:9090',
  },
  {},
);
if (
  projectGateway.GATEWAY_PORT !== '9090' ||
  projectGateway.PUBLIC_ORIGIN !== 'http://localhost:9090' ||
  projectGateway.ADMIN_ORIGIN !== 'http://admin.localhost:9090'
) {
  throw new Error('Project .env gateway values do not take effect');
}
const overriddenGateway = resolveGatewayEnvironment(
  {
    GATEWAY_PORT: '9191',
    PUBLIC_ORIGIN: 'http://localhost:9191',
    ADMIN_ORIGIN: 'http://admin.localhost:9191',
  },
  projectGateway,
  {},
);
if (
  overriddenGateway.GATEWAY_PORT !== '9191' ||
  overriddenGateway.PUBLIC_ORIGIN !== 'http://localhost:9191' ||
  overriddenGateway.ADMIN_ORIGIN !== 'http://admin.localhost:9191'
) {
  throw new Error('Process gateway overrides do not take precedence');
}

console.info('TokEMS Compose naming, secret, origin, and gateway gates verified');
