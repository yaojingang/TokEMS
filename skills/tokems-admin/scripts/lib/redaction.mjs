const secretKey =
  /(authorization|token|secret|password|credential|private.?key|dpop|cookie|mobile|phone|email|address|identity|id.?card|tax.?id|tax.?number|bank|invoice.?title|real.?name|display.?name|nickname|attendee.?name|buyer.?name|recipient.?name|display.?company|company|wechat.?id|form.?answers|^(?:name|title|city|bio)$|(?:upload|download|preview|signed).?url)/iu;

export function redact(value, depth = 0) {
  if (depth > 8) return '[depth-limited]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretKey.test(key) ? '[redacted]' : redact(item, depth + 1),
    ]),
  );
}

export function safeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'TOKEMS_ADMIN_ERROR';
  const message = error instanceof Error ? error.message : 'TokEMS Admin request failed';
  return { ok: false, code, message, details: redact(error?.details ?? {}) };
}
