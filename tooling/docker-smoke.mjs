import { execFileSync } from 'node:child_process';
import { assertBuildSourceState, assertBuildsConsistent } from './lib/build-version.mjs';
import { localComposeEnvironment } from './lib/local-compose-environment.mjs';

const environment = localComposeEnvironment();

function composeUrl(service, containerPort, fallback) {
  try {
    const binding = execFileSync('docker', ['compose', 'port', service, String(containerPort)], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const hostPort = binding.match(/:(\d+)$/)?.[1];
    return hostPort ? `http://localhost:${hostPort}` : fallback;
  } catch {
    return fallback;
  }
}

const gateway =
  process.env.DOCKER_GATEWAY_URL ??
  environment.PUBLIC_ORIGIN ??
  composeUrl('gateway', 8080, 'http://localhost:8088');
const adminGateway = process.env.DOCKER_ADMIN_ORIGIN ?? environment.ADMIN_ORIGIN ?? gateway;
const endpoints = {
  api: process.env.DOCKER_API_URL ?? `${gateway}/api/v1`,
  web: process.env.DOCKER_WEB_URL ?? gateway,
  admin: process.env.DOCKER_ADMIN_URL ?? `${adminGateway}/admin`,
  minio: process.env.DOCKER_MINIO_URL ?? composeUrl('minio', 9000, 'http://localhost:9000'),
  mailpit: process.env.DOCKER_MAILPIT_URL ?? composeUrl('mailpit', 8025, 'http://localhost:8025'),
  notificationSink:
    process.env.DOCKER_NOTIFICATION_SINK_URL ??
    composeUrl('notification-sink', 4080, 'http://localhost:4080'),
};
const adminUsername = environment.ADMIN_USERNAME;
const adminPassword = environment.ADMIN_PASSWORD;
const notificationToken = environment.NOTIFICATION_WEBHOOK_TOKEN;
const publicOrganizationSlug = environment.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo';
const expectedEventSlug = process.env.DOCKER_EXPECTED_EVENT_SLUG ?? 'tokems26';
const isProduction = environment.DEPLOYMENT_MODE === 'production';
const customerSmokeMobile = `139${String(Date.now()).slice(-8)}`;
const deadline = Date.now() + Number(process.env.DOCKER_VERIFY_TIMEOUT_MS ?? 180_000);
let apiBuild;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok)
    throw new Error(`${options.method ?? 'GET'} ${url} returned ${response.status}`);
  return { response, body };
}

async function waitFor(label, probe) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      console.info(`✓ ${label}`);
      return result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`${label} verification timed out: ${lastError?.message ?? 'unknown error'}`);
}

await waitFor('API 与 PostgreSQL 健康', async () => {
  const { body } = await request(`${endpoints.api}/health`);
  assert(body.status === 'ok', `API status is ${body.status}`);
  assert(body.database?.mode === 'postgresql', 'API is not using PostgreSQL');
  assert(body.database?.ok === true, 'PostgreSQL ping failed');
  assert(body.database?.migration?.ok === true, 'PostgreSQL migration hash is not current');
  apiBuild = body.build;
});

const verifiedBuild = await waitFor('五个运行服务版本一致', async () => {
  const [{ body: gatewayBuild }, { body: webBuild }, { body: adminBuild }] = await Promise.all([
    request(`${gateway}/version.json`),
    request(`${gateway}/web-version.json`),
    request(`${endpoints.admin}/version.json`),
  ]);
  const workerBuild = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'worker',
        'node',
        '-e',
        "console.log(JSON.stringify({service:'worker',sha:process.env.BUILD_SHA,builtAt:process.env.BUILD_TIME,migration:process.env.BUILD_MIGRATION,migrationHash:process.env.BUILD_MIGRATION_HASH}))",
      ],
      { encoding: 'utf8', env: environment },
    ).trim(),
  );
  return assertBuildsConsistent({
    api: apiBuild,
    worker: workerBuild,
    web: webBuild,
    admin: adminBuild,
    gateway: gatewayBuild,
  });
});
assertBuildSourceState({
  expectedSha: verifiedBuild.sha,
  actualSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf8',
  }).trim(),
});

if (!isProduction) {
  await waitFor('本地演示大会发布数据可读取', async () => {
    const { body } = await request(`${endpoints.api}/homepage`, {
      headers: { 'X-Organization-Slug': publicOrganizationSlug },
    });
    assert(body.slug === expectedEventSlug, 'Unexpected event slug');
    assert(body.status === 'registration_open', 'Event is not open for registration');
    assert(Array.isArray(body.tickets) && body.tickets.length === 1, 'Ticket data is incomplete');
    assert(body.tickets[0]?.name === '大会通票', 'Unexpected default ticket');
    assert(body.tickets[0]?.price === 39_900, 'Unexpected default ticket price');
    assert(body.tickets[0]?.benefits?.length === 8, 'Default ticket benefits are incomplete');
  });
}

await waitFor('Swagger 契约可读取', async () => {
  const apiOrigin = new URL(endpoints.api).origin;
  const { body } = await request(`${apiOrigin}/api/openapi.json`);
  assert(
    Object.keys(body.paths ?? {}).length >= 40,
    'OpenAPI path count is below the expected floor',
  );
});

if (!isProduction) {
  await waitFor('本地运营后台账号可登录', async () => {
    const { body } = await request(`${endpoints.api}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    assert(typeof body.accessToken === 'string' && body.accessToken.length > 20, 'JWT is missing');
  });

  {
    const mobile = customerSmokeMobile;
    const organizationHeaders = {
      'Content-Type': 'application/json',
      'X-Organization-Slug': publicOrganizationSlug,
    };
    const { body: challenge } = await request(`${endpoints.api}/customer-auth/otp`, {
      method: 'POST',
      headers: organizationHeaders,
      body: JSON.stringify({ mobile }),
    });
    assert(challenge.developmentCode === '123456', 'Local fake OTP code is unavailable');
    const { response: verifiedResponse, body: session } = await request(
      `${endpoints.api}/customer-auth/verify`,
      {
        method: 'POST',
        headers: organizationHeaders,
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          mobile,
          code: '123456',
          consentAccepted: true,
          termsVersion: '',
          privacyVersion: '',
        }),
      },
    );
    assert(session.authenticated === true, 'Customer session was not created');
    assert(session.customer?.mobile === `+86${mobile}`, 'Customer mobile was not normalized');
    const sessionCookie = verifiedResponse.headers.get('set-cookie')?.split(';', 1)[0];
    assert(sessionCookie, 'Customer session cookie is missing');
    const { body: restored } = await request(`${endpoints.api}/customer-auth/session`, {
      headers: {
        'X-Organization-Slug': publicOrganizationSlug,
        Cookie: sessionCookie,
      },
    });
    assert(restored.authenticated === true, 'Customer session cookie was not restored');
    assert(restored.customer?.id === session.customer?.id, 'Restored customer identity changed');
    console.info('✓ 前台手机号验证码可登录并恢复会话');
  }
}

await waitFor('前后台独立来源的 CORS 均可用', async () => {
  for (const origin of [gateway, adminGateway]) {
    const response = await fetch(`${endpoints.api}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert(response.status === 204, `CORS preflight returned ${response.status}`);
    assert(
      response.headers.get('access-control-allow-origin') === origin,
      `${origin} is not allowed by CORS`,
    );
  }
});

const paymentOrigin = process.env.DOCKER_PAYMENT_ORIGIN ?? environment.PAYMENT_PUBLIC_ORIGIN ?? '';
const paymentBasePath = (environment.PAYMENT_PUBLIC_BASE_PATH || '/pay/hui').replace(/\/+$/, '');

if (paymentOrigin) {
  await waitFor('支付独立来源无法跨域读取大会会话', async () => {
    const response = await fetch(`${endpoints.api}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: paymentOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,x-wechat-oauth-session',
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert(response.status === 204, `Payment CORS preflight returned ${response.status}`);
    assert(
      response.headers.get('access-control-allow-origin') !== paymentOrigin,
      `${paymentOrigin} unexpectedly received credentialed CORS access`,
    );
  });

  await waitFor('支付入口 /pay/hui 规范化与页面可访问', async () => {
    const bare = await fetch(`${gateway}${paymentBasePath}`, {
      redirect: 'manual',
      headers: { Host: new URL(paymentOrigin).host },
      signal: AbortSignal.timeout(5_000),
    });
    assert(bare.status === 308, `Payment bare path returned ${bare.status}`);
    assert(
      (bare.headers.get('location') ?? '').endsWith(`${paymentBasePath}/`),
      `Payment bare path redirected to ${bare.headers.get('location')}`,
    );

    const page = await fetch(`${gateway}${paymentBasePath}/`, {
      headers: { Host: new URL(paymentOrigin).host },
      signal: AbortSignal.timeout(5_000),
    });
    assert(page.ok, `Payment page returned ${page.status}`);
    const body = await page.text();
    assert(body.length > 0, 'Payment page body is empty');
  });

  await waitFor('支付入口 API 前缀可到达健康检查', async () => {
    const response = await fetch(`${gateway}${paymentBasePath}/api/v1/health`, {
      headers: { Host: new URL(paymentOrigin).host },
      signal: AbortSignal.timeout(5_000),
    });
    assert(response.ok, `Payment API health returned ${response.status}`);
    const body = await response.json();
    assert(body.status === 'ok', `Payment API health status is ${body.status}`);
  });
}

await waitFor('Nuxt 大会前台可访问', async () => {
  const { body } = await request(endpoints.web);
  assert(body.includes('中国第二届GEO大会'), 'Web page did not render the conference shell');
  assert(
    body.includes('customer-account-action'),
    'Web page did not render the customer account entry',
  );
});

await waitFor('Vue 运营后台与 SPA 回退可访问', async () => {
  const [
    entryResponse,
    { response: rootResponse, body: root },
    { response: nestedResponse, body: nested },
  ] = await Promise.all([
    fetch(endpoints.admin, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    }),
    request(`${endpoints.admin}/login`),
    request(`${endpoints.admin}/manage/events`),
  ]);
  assert(entryResponse.status === 308, `Admin entry returned ${entryResponse.status}`);
  assert(
    entryResponse.headers.get('location') === '/admin/',
    `Admin entry redirected to ${entryResponse.headers.get('location')}`,
  );
  assert(root.includes('id="app"'), 'Admin app mount point is missing');
  assert(nested.includes('id="app"'), 'Admin SPA fallback is missing');
  assert(
    rootResponse.headers.get('cache-control')?.includes('no-cache'),
    'Admin HTML is missing a revalidation cache policy',
  );
  assert(
    nestedResponse.headers.get('cache-control')?.includes('no-cache'),
    'Admin SPA fallback is missing a revalidation cache policy',
  );
});

await waitFor('公开站来源无法读取运营后台', async () => {
  const response = await fetch(`${gateway}/admin/login`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  assert(response.status === 404, `Public origin exposed admin with ${response.status}`);
});

await waitFor('MinIO 健康', () => request(`${endpoints.minio}/minio/health/live`));
await waitFor('Mailpit 健康', () => request(`${endpoints.mailpit}/livez`));

if (!isProduction) {
  await waitFor('本地通知 Webhook 可接收消息', async () => {
    const { response, body } = await request(`${endpoints.notificationSink}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${notificationToken}`,
      },
      body: JSON.stringify({
        id: 'docker-smoke-notification',
        channel: 'email',
        recipient: 'docker-smoke@example.invalid',
        subject: 'Docker smoke',
        body: 'Local container verification',
        scheduledAt: new Date().toISOString(),
      }),
    });
    assert(body.accepted === true, 'Notification was not accepted');
    assert(Boolean(response.headers.get('x-message-id')), 'Notification message id is missing');
  });
}

console.info(
  `${isProduction ? 'Production-safe' : 'Local'} Docker deployment smoke verification passed`,
);
