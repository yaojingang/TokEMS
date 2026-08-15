const RETRYABLE_TRANSACTION_CODES = new Set(['40P01', '40001']);

export function postgresErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return postgresErrorCode(error.cause);
  return '';
}

export async function withPostgresTransactionRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    jitter?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 3);
  const baseDelayMs = Math.min(Math.max(options.baseDelayMs ?? 8, 1), 50);
  const jitter = options.jitter ?? Math.random;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!RETRYABLE_TRANSACTION_CODES.has(postgresErrorCode(error)) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(jitter() * baseDelayMs);
      await sleep(delayMs);
    }
  }
  throw new Error('transaction retry exhausted');
}
