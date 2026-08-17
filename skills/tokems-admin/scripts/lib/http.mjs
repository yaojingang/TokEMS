const allowedRoutes = [
  { path: '/.well-known/', prefix: true },
  { path: '/api/v1/oauth/', prefix: true },
  { path: '/api/v1/agent/', prefix: true },
  { path: '/api/v1/admin/', prefix: true },
  { path: '/api/v1/events/', prefix: true },
  { path: '/api/v1/homepage', prefix: false },
];

function allowedPath(pathname) {
  return allowedRoutes.some((route) =>
    route.prefix
      ? pathname.startsWith(route.path)
      : pathname === route.path || pathname.startsWith(`${route.path}/`),
  );
}

export async function readBoundedResponse(response, maxBytes = 32 * 1024 * 1024) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error(`TokEMS response exceeds the ${maxBytes}-byte safety limit`);
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  if (!response.body) return new Uint8Array().buffer;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      const error = new Error(`TokEMS response exceeds the ${maxBytes}-byte safety limit`);
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, size);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    } catch {
      return {};
    }
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function loopback(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export function normalizeOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TokEMS origin must be an absolute URL');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TokEMS origin must contain only scheme, host, and optional port');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
    throw new Error('Remote TokEMS origin must use HTTPS');
  }
  return url.origin;
}

export function endpoint(origin, path) {
  const pinnedOrigin = normalizeOrigin(origin);
  const requestedPathname = path.split('?')[0].split('#')[0];
  if (!path.startsWith('/') || path.includes('\\') || !allowedPath(requestedPathname)) {
    const error = new Error('TokEMS connector rejected a free or unsupported request path');
    error.code = 'UNSUPPORTED_PATH';
    throw error;
  }
  const url = new URL(path, pinnedOrigin);
  if (url.origin !== pinnedOrigin) throw new Error('TokEMS request escaped the approved origin');
  if (url.pathname !== requestedPathname) {
    const error = new Error('TokEMS connector rejected a normalized or traversal request path');
    error.code = 'UNSUPPORTED_PATH';
    throw error;
  }
  return url.toString();
}

export async function fetchBound(origin, path, options = {}) {
  const url = endpoint(origin, path);
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeout ?? 20_000),
  });
  if (response.status >= 300 && response.status < 400) {
    const error = new Error('TokEMS connector rejected an HTTP redirect');
    error.code = 'CROSS_ORIGIN_REDIRECT_REJECTED';
    throw error;
  }
  const value = await readBoundedResponse(response, options.maxBytes);
  if (!response.ok) {
    const error = new Error(
      value?.message || value?.error_description || `TokEMS request failed (${response.status})`,
    );
    error.code = value?.code || value?.error || `HTTP_${response.status}`;
    error.details = value?.details;
    error.status = response.status;
    throw error;
  }
  return { value, response, url };
}

export function formBody(value) {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)),
  ).toString();
}
