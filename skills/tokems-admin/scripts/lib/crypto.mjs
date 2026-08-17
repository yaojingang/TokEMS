import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

export function generateDpopKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const thumbprint = sha256Base64Url(
    JSON.stringify({ crv: 'P-256', kty: 'EC', x: publicJwk.x, y: publicJwk.y }),
  );
  return { publicJwk, privateJwk, thumbprint };
}

export function dpopProof({ keys, method, url, accessToken }) {
  const now = Math.floor(Date.now() / 1000);
  const proofUrl = new URL(url);
  proofUrl.search = '';
  proofUrl.hash = '';
  const header = Buffer.from(
    JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: keys.publicJwk }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      htm: method.toUpperCase(),
      htu: proofUrl.toString(),
      iat: now,
      jti: crypto.randomUUID(),
      ...(accessToken ? { ath: sha256Base64Url(accessToken) } : {}),
    }),
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey({ key: keys.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export function generateDataKey() {
  return randomBytes(32).toString('base64');
}

export function encryptJson(value, encodedKey, additionalData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encodedKey, 'base64'), iv);
  cipher.setAAD(Buffer.from(additionalData));
  const ciphertext = Buffer.concat([cipher.update(stableStringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptJson(envelope, encodedKey, additionalData) {
  if (envelope?.version !== 1) throw new Error('Pending operation encryption version is invalid');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encodedKey, 'base64'),
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(additionalData));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  );
}
