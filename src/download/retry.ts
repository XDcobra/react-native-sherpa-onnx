export type RetryOptions = {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  signal?: AbortSignal;
};

/**
 * Retry helper with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      const abortError = new Error('Operation aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (lastError.name === 'AbortError' || options.signal?.aborted) {
        throw lastError;
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt),
        maxDelayMs
      );

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);

        if (!options.signal) {
          return;
        }

        const onAbort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          const abortError = new Error('Operation aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        };

        options.signal.addEventListener('abort', onAbort);
      });
    }
  }

  throw lastError ?? new Error('Retry failed with no error');
}
