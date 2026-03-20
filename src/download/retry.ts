/**
 * Retry helper with exponential backoff
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries fail or AbortError if aborted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      const abortError = new Error('Operation aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort
      if (lastError.name === 'AbortError' || options.signal?.aborted) {
        throw lastError;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(
        initialDelayMs * Math.pow(backoffFactor, attempt),
        maxDelayMs
      );

      console.warn(
        `Retry attempt ${attempt + 1}/${maxRetries} after ${delayMs}ms due to:`,
        lastError.message
      );

      // Wait before retrying (abort-aware: cancel the delay if signal fires)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (options.signal) {
          const onAbort = () => {
            clearTimeout(timer);
            options.signal!.removeEventListener('abort', onAbort);
            const abortErr = new Error('Operation aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          };
          options.signal.addEventListener('abort', onAbort);
        }
      });
    }
  }

  throw lastError ?? new Error('Retry failed with no error');
}
