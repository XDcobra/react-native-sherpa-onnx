import { DownloadError, DOWNLOAD_ERROR_CODES, isDownloadError } from './errors';
import type { RequestPolicy, SourceFetchContext } from './types';

export interface SourceFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: RequestInit['body'];
  requestPolicy?: RequestPolicy;
}

export interface SourceFetchResult {
  response: Response;
  attempt: number;
}

type NormalizedPolicy = {
  retries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  timeoutMs?: number;
};

function normalizePolicy(input?: RequestPolicy): NormalizedPolicy {
  return {
    retries: Math.max(0, input?.retries ?? 0),
    initialDelayMs: input?.initialDelayMs ?? 1000,
    maxDelayMs: input?.maxDelayMs ?? 10000,
    timeoutMs: input?.timeoutMs,
  };
}

function computeBackoffMs(attempt: number, policy: NormalizedPolicy): number {
  const delay = policy.initialDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, policy.maxDelayMs);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function retriableHttpStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) {
    return true;
  }
  return status >= 500 && status < 600;
}

function mergeHeaders(
  ctx: SourceFetchContext,
  perCall?: Record<string, string>
): Headers {
  const merged = new Headers();

  for (const [k, v] of Object.entries(ctx.headers)) {
    merged.set(k, v);
  }

  if (perCall) {
    for (const [k, v] of Object.entries(perCall)) {
      merged.set(k, v);
    }
  }

  if (ctx.token) {
    merged.set('Authorization', `${ctx.tokenScheme ?? 'Bearer'} ${ctx.token}`);
  }

  return merged;
}

async function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (!signal) {
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const abortError = new Error('Operation aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };

    signal.addEventListener('abort', onAbort);
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, init);
  }

  const timeoutController = new AbortController();
  const upstream = init.signal;

  const onUpstreamAbort = () => {
    timeoutController.abort();
  };

  if (upstream) {
    if (upstream.aborted) {
      timeoutController.abort();
    } else {
      upstream.addEventListener('abort', onUpstreamAbort);
    }
  }

  const timer = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: timeoutController.signal,
    });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}

export async function sourceFetch(
  url: string,
  ctx: SourceFetchContext,
  options: SourceFetchOptions = {}
): Promise<SourceFetchResult> {
  const policy = normalizePolicy(options.requestPolicy ?? ctx.requestPolicy);
  const headers = mergeHeaders(ctx, options.headers);

  let attempt = 0;

  while (true) {
    if (ctx.signal?.aborted) {
      throw new DownloadError(
        DOWNLOAD_ERROR_CODES.CANCELLED,
        'request aborted before send',
        {
          source: ctx.sourceId,
        }
      );
    }

    let response: Response | null = null;
    let transportError: unknown = null;

    try {
      response = await fetchWithTimeout(
        url,
        {
          method: options.method ?? 'GET',
          headers,
          body: options.body,
          signal: ctx.signal,
        },
        policy.timeoutMs
      );
    } catch (error) {
      transportError = error;
    }

    if (response?.ok) {
      return {
        response,
        attempt,
      };
    }

    if (transportError && isAbortError(transportError)) {
      throw new DownloadError(
        DOWNLOAD_ERROR_CODES.CANCELLED,
        'request aborted',
        {
          source: ctx.sourceId,
          cause: transportError,
        }
      );
    }

    const status = response?.status;
    const isAuth = status === 401 || status === 403;
    const isHttpFailure = response != null && !response.ok;
    const canRetry =
      attempt < policy.retries &&
      ((isHttpFailure && status != null && retriableHttpStatus(status)) ||
        transportError != null);

    if (!canRetry) {
      if (isAuth) {
        throw new DownloadError(
          DOWNLOAD_ERROR_CODES.SOURCE_AUTH_FAILED,
          `auth failed (${status})`,
          {
            source: ctx.sourceId,
            status,
          }
        );
      }

      if (isHttpFailure) {
        throw new DownloadError(
          DOWNLOAD_ERROR_CODES.HTTP_STATUS,
          `unexpected status ${status}`,
          {
            source: ctx.sourceId,
            status,
          }
        );
      }

      if (isDownloadError(transportError)) {
        throw transportError;
      }

      throw new DownloadError(
        DOWNLOAD_ERROR_CODES.NETWORK_FAILED,
        transportError instanceof Error
          ? transportError.message
          : 'network request failed',
        {
          source: ctx.sourceId,
          cause: transportError,
        }
      );
    }

    attempt += 1;
    await waitWithSignal(computeBackoffMs(attempt, policy), ctx.signal);
  }
}
