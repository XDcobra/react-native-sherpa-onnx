# Sub-Plan 03: Source Fetcher, Headers, Retry Policy & Error Mapping

## Status
- Phase: **3**
- Depends on: sub-01 (contract), sub-02 (source registry).
- Prerequisite for: sub-05 (Hugging Face), sub-06 (download engine), sub-07 (registry cache).

## Cross-references
- Overview: [`download_manager_overview.md`](./download_manager_overview.md)
- Existing retry helper to remove: `src/download/retry.ts`.
- Existing direct `fetch(...)` call sites this sub-plan replaces: `src/download/registry.ts → refreshModels`, `src/download/registry.ts → fetchChecksumsFromRelease`, plus the inline `fetch(...)` introduced in sub-02's `github-k2-fsa.ts` / `github-xdcobra.ts`.

## Purpose

Introduce **`sourceFetch(url, ctx, opts?)`** as the single entry point every source provider and registry orchestrator uses to talk to the network:

1. Merges headers from `SourceProvider.defaultHeaders()`, `configureSource({ headers })`, and per-call overrides.
2. Folds `SourceFetchContext.token` into the `Authorization` header.
3. Applies `RequestPolicy` (default **retries off**) with exponential backoff *only when explicitly opted in*.
4. Maps every failure mode to a typed `DownloadError` with a `DOWNLOAD_*` code.
5. Threads `AbortSignal` end-to-end, including across retry waits.

After this phase, **no `fetch(...)` is called directly** in any download-manager production code path, and `src/download/retry.ts` is deleted.

---

## Design principles

1. **One fetcher, one error contract.** Providers awaiting `sourceFetch(...)` get either a `Response` (success) or a thrown `DownloadError`. There is no third option.
2. **Retry must be opt-in.** The fetcher's `requestPolicy.retries` default is `0`. Internal call sites in the registry/orchestration layer pass `requestPolicy` only when the caller explicitly supplied one via the public API.
3. **Tokens never appear in logs.** `Authorization` is built inside the fetcher and never inserted into error messages, even when the request fails. Tests assert this explicitly.
4. **HTTP status taxonomy is rigid.** 401/403 → `DOWNLOAD_SOURCE_AUTH_FAILED`. Other non-2xx → `DOWNLOAD_HTTP_STATUS`. Transport failures (no response) → `DOWNLOAD_NETWORK_FAILED`. Aborts → `DOWNLOAD_CANCELLED`. No fuzzy mappings.
5. **Per-call overrides augment, do not replace.** A per-call `{ headers: { 'X-Foo': 'bar' } }` is merged on top of the source's configured headers; no per-call call can wipe out the source's `Authorization`.

---

## Files to add / modify

```
src/download/sources/
  fetch.ts                      // sourceFetch implementation
  __tests__/fetch.test.ts

src/download/
  retry.ts                      // DELETE (no remaining call sites after this phase)
  registry.ts                   // refreshModels no longer wraps retryWithBackoff
                                // (caller may opt in via opts.requestPolicy → sourceFetch retries)

src/download/sources/builtin/
  github-k2-fsa.ts              // Direct fetch(...) → sourceFetch(...)
  github-xdcobra.ts             // Direct fetch(...) → sourceFetch(...)
```

---

## TypeScript shapes

### `SourceFetchOptions`

```ts
// src/download/sources/fetch.ts
import type { SourceFetchContext, RequestPolicy } from './types';
import type { DownloadErrorCode } from './errors';
import { DownloadError } from './errors';

export interface SourceFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  /** Per-call header overrides, merged on top of provider+source headers. */
  headers?: Record<string, string>;
  /** Per-call body (rarely used). */
  body?: BodyInit;
  /** Per-call policy override; otherwise uses ctx.requestPolicy. */
  requestPolicy?: RequestPolicy;
}

export interface SourceFetchResult {
  response: Response;
  /** Attempt index (0 = first try, 1 = first retry, …). */
  attempt: number;
}
```

### `sourceFetch`

```ts
// src/download/sources/fetch.ts (continued)

export async function sourceFetch(
  url: string,
  ctx: SourceFetchContext,
  opts: SourceFetchOptions = {}
): Promise<SourceFetchResult> {
  const policy = normalizePolicy(opts.requestPolicy ?? ctx.requestPolicy);
  const headers = mergeHeaders(ctx, opts.headers);

  let attempt = 0;
  for (;;) {
    if (ctx.signal?.aborted) {
      throw new DownloadError('DOWNLOAD_CANCELLED', 'request aborted before send', {
        source: ctx.sourceId,
      });
    }

    let response: Response | null = null;
    let networkError: unknown = null;
    try {
      response = await fetchWithTimeout(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body,
        signal: ctx.signal,
      }, policy.timeoutMs);
    } catch (err) {
      networkError = err;
    }

    if (response && response.ok) {
      return { response, attempt };
    }

    const status = response?.status;
    const isAuth = status === 401 || status === 403;
    const isHttpFinal = !networkError && response && !response.ok;
    const isTransientHttp = isHttpFinal && retriableHttpStatus(status!);
    const isTransientNet = networkError != null && !isAbort(networkError);
    const isCancel = networkError != null && isAbort(networkError);

    if (isCancel) {
      throw new DownloadError('DOWNLOAD_CANCELLED', 'request aborted', {
        source: ctx.sourceId,
        cause: networkError,
      });
    }

    const canRetry = attempt < policy.retries && (isTransientHttp || isTransientNet);
    if (!canRetry) {
      if (isAuth) {
        throw new DownloadError(
          'DOWNLOAD_SOURCE_AUTH_FAILED',
          `auth failed (${status})`,
          { source: ctx.sourceId, status }
        );
      }
      if (isHttpFinal) {
        throw new DownloadError(
          'DOWNLOAD_HTTP_STATUS',
          `unexpected status ${status}`,
          { source: ctx.sourceId, status }
        );
      }
      throw new DownloadError(
        'DOWNLOAD_NETWORK_FAILED',
        toMessage(networkError),
        { source: ctx.sourceId, cause: networkError }
      );
    }

    attempt += 1;
    await sleepWithSignal(
      computeBackoffMs(attempt, policy),
      ctx.signal
    );
  }
}

function normalizePolicy(input?: RequestPolicy): Required<RequestPolicy> {
  return {
    retries: Math.max(0, input?.retries ?? 0),
    initialDelayMs: input?.initialDelayMs ?? 1000,
    maxDelayMs: input?.maxDelayMs ?? 10_000,
    timeoutMs: input?.timeoutMs ?? 30_000,
  };
}

function retriableHttpStatus(status: number): boolean {
  // 408 Request Timeout, 425 Too Early, 429 Too Many Requests, 5xx.
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

function mergeHeaders(
  ctx: SourceFetchContext,
  perCall: Record<string, string> | undefined
): Headers {
  const merged = new Headers();
  for (const [k, v] of Object.entries(ctx.headers)) merged.set(k, v);
  if (perCall) for (const [k, v] of Object.entries(perCall)) merged.set(k, v);
  if (ctx.token) {
    merged.set(
      'Authorization',
      `${ctx.tokenScheme ?? 'Bearer'} ${ctx.token}`
    );
  }
  return merged;
}
```

`fetchWithTimeout`, `sleepWithSignal`, `computeBackoffMs`, `isAbort`, `toMessage` are private helpers in `fetch.ts`. Tests assert their behaviour via `sourceFetch` end-to-end.

### Public re-exports

`src/download/index.ts` re-exports `sourceFetch` and `SourceFetchOptions` so SDK users implementing **custom** `SourceProvider`s can call it directly:

```ts
// src/download/index.ts (additions)
export { sourceFetch, type SourceFetchOptions } from './sources/fetch';
```

> Built-in providers (`github_k2_fsa`, `github_xdcobra`, `huggingface`) use the same `sourceFetch`; custom providers therefore have the same retry/headers/error guarantees as the built-ins.

---

## Header merge order

For every request the final `Headers` are built in this order (later wins for the same key):

1. `provider.defaultHeaders?.()` (from sub-02 — provider-internal defaults, e.g. `Accept: application/vnd.github+json`).
2. `getSourceConfig(sourceId).headers` (`configureSource({ headers: { ... } })`).
3. Per-call `SourceFetchOptions.headers`.
4. `Authorization: <scheme> <token>` derived from `ctx.token` (always last; per-call cannot override the token).

Step 4 is what guarantees `configureSource(id, { token })` survives every per-call `headers` override. The fetcher therefore explicitly **does not** allow per-call code to spoof / disable auth.

---

## Retry semantics

| `RequestPolicy.retries` | Behaviour |
|---|---|
| `0` (default) | First failure (transient or final) throws immediately. |
| `> 0` | On transient failure (HTTP 408/425/429/5xx or network error), wait `min(initialDelayMs * 2^(attempt-1), maxDelayMs)`, retry. After `retries` retries, the **final** failure is thrown — never wrapped in a "retry exhausted" error. |
| `n` with non-transient failure (401/403/404/4xx other than retriable) | No retry. Thrown as the categorized `DownloadError`. |
| `signal.aborted` mid-wait | The wait is cancelled and `DOWNLOAD_CANCELLED` is thrown. |

> The default behaviour is identical for `sourceFetch` used by providers, by the registry, and by the download engine (sub-06). Each layer can pass a different `requestPolicy` per call if the user opted in.

---

## Registry / download-engine integration

After this phase:

- `refreshModels(category, options)` builds `ctx.requestPolicy` from `options?.requestPolicy ?? getSourceConfig(sourceId).requestPolicy ?? { retries: 0 }`.
- The pre-existing `retryWithBackoff(... { maxRetries: 3 })` block around `fetch(getReleaseUrl(category))` is **deleted**. If the caller didn't ask for retries, the fetch fails immediately on its first error.
- `fetchChecksumsFromRelease` (moved to `github-common.ts`'s `getChecksums` providers in sub-02) inherits the same default: no retry unless caller opts in.

`downloadModel` (sub-06) does not run its byte-stream through `sourceFetch` (it still uses `@kesha-antonov/react-native-background-downloader` for the long transfer); but every **preflight** call (`HEAD` for size check, optional manifest fetch in folder layouts, etc.) goes through `sourceFetch`. The internal `maxRetries: 2` loop currently in `downloadModel` is **removed**; pause-aware behaviour stays, only blind retries go.

---

## Implementation steps

1. Add `src/download/sources/fetch.ts` with `sourceFetch`, private helpers, and the policy normalizer.
2. Update `src/download/sources/builtin/github-k2-fsa.ts` and `.../github-xdcobra.ts` to call `sourceFetch(url, ctx)` instead of `fetch(url)`. Auth header is set automatically when configured.
3. Refactor `src/download/registry.ts → refreshModels`:
   - Remove `retryWithBackoff` wrapper.
   - Build `ctx` (including `requestPolicy` from caller).
   - Delegate `provider.listModels(category, ctx)`.
   - For checksums, call `provider.getChecksums?.(category, ctx)` (already in place from sub-02; behaviourally just loses the retry).
4. Refactor `src/download/downloadTask.ts → downloadModel`:
   - Remove the `while (true) { try { … } catch { … if (attempt >= maxRetries) throw; … } }` outer retry loop.
   - Keep the inner `downloadModelOnce` body verbatim — that's the actual transfer + post-processing.
   - Add a one-line guard: if caller passes `opts?.requestPolicy?.retries && opts.requestPolicy.retries > 0`, re-introduce a loop *exactly equivalent* to today's. Otherwise, single attempt.
5. Delete `src/download/retry.ts`. Verify no remaining importers (`rg --type ts retryWithBackoff`).
6. Add `src/download/sources/__tests__/fetch.test.ts`.

---

## Test matrix (Jest)

### `fetch.test.ts`

| # | Scenario | Expected |
|---|---|---|
| 1 | Mock `fetch` → 200 OK | `{ response, attempt: 0 }`. |
| 2 | Mock `fetch` → 401, default policy (`retries: 0`) | `DOWNLOAD_SOURCE_AUTH_FAILED`, `status: 401`. |
| 3 | Mock `fetch` → 403, default policy | `DOWNLOAD_SOURCE_AUTH_FAILED`, `status: 403`. |
| 4 | Mock `fetch` → 404, default policy | `DOWNLOAD_HTTP_STATUS`, `status: 404`. |
| 5 | Mock `fetch` → 500, default policy | `DOWNLOAD_HTTP_STATUS`, `status: 500`, **no retry** (retries default 0). |
| 6 | Mock `fetch` → 500 then 200, `policy.retries = 1` | `{ response, attempt: 1 }`. |
| 7 | Mock `fetch` → 500 always, `policy.retries = 3` | `DOWNLOAD_HTTP_STATUS`, attempts = 4. |
| 8 | Mock `fetch` → 429, `policy.retries = 2` | Two retries, then `DOWNLOAD_HTTP_STATUS`. |
| 9 | Mock `fetch` → network error (`TypeError: Network request failed`), `retries: 0` | `DOWNLOAD_NETWORK_FAILED`, cause carries the original. |
| 10 | Mock `fetch` → network error twice then 200, `retries: 2` | `attempt: 2`. |
| 11 | `signal.aborted = true` before send | `DOWNLOAD_CANCELLED`. |
| 12 | `signal` aborted mid-wait between retries | `DOWNLOAD_CANCELLED`, no further `fetch` calls. |
| 13 | `ctx.token = 'tok123'`, `ctx.tokenScheme` unset | Outgoing `Authorization` is `Bearer tok123`. |
| 14 | `ctx.token = 't'`, `ctx.tokenScheme = 'Token'` (GitHub style) | Outgoing `Authorization` is `Token t`. |
| 15 | Per-call `headers: { Authorization: 'X' }` and `ctx.token = 'tok'` | Outgoing `Authorization` is still `Bearer tok` (token wins per [Header merge order](#header-merge-order)). |
| 16 | `provider.defaultHeaders()` returns `Accept: 'A'`; `configureSource({ headers: { Accept: 'B' } })` | Outgoing `Accept: 'B'` (source config wins over provider defaults). |
| 17 | `provider.defaultHeaders()` returns `Accept: 'A'`; per-call `headers: { Accept: 'C' }` | Outgoing `Accept: 'C'`. |
| 18 | Logged error from #2 does not contain the literal `'tok123'` (token from #13) | Pass. |
| 19 | `policy.timeoutMs: 50`, `fetch` hangs > 50ms | `DOWNLOAD_NETWORK_FAILED` (timeout fires AbortController internally). |
| 20 | `policy.timeoutMs: 50`, `fetch` finishes in 10ms | `{ response, attempt: 0 }`. |

### Existing registry/download tests

- All today's `refreshModels(...)` tests stay green with `fetch` mocked to a single 200 response, because **no retries** happen by default.
- Add one new test: `refreshModels(category, { requestPolicy: { retries: 2 } })` with `fetch` returning 503 twice then 200 → succeeds.
- All today's `downloadModel(...)` tests pass; add: `downloadModel(category, id, { requestPolicy: { retries: 0 } })` with a transient setup failure throws on first attempt.

---

## Acceptance criteria

- `src/download/retry.ts` is deleted; `rg retryWithBackoff src/` returns no hits.
- All built-in providers call `sourceFetch(...)`; no direct `fetch(...)` survives outside of `src/download/sources/fetch.ts`.
- `sourceFetch` is part of the public surface (re-exported from `react-native-sherpa-onnx/download`) so custom `SourceProvider` authors can use it.
- Default behaviour: a single failing 5xx response **does not** retry. Existing apps that relied on the old `maxRetries: 3` for `refreshModels` must opt in explicitly.
- Token-from-config is never logged.
- Header merge order matches the spec in this sub-plan.
- IST/SOLL review: trace one `refreshModels(ModelCategory.Tts)` call end-to-end through `sourceFetch` and confirm the resulting URL and headers match what today's hard-coded code produces (modulo no implicit retry).

---

## Resolved decisions

### OQ-3.1 — Should the fetcher expose a streaming response for large blobs (folder downloads)?

**Decision: No (accepted).**

`sourceFetch` returns a `Response`; the download engine (sub-06) calls `@kesha-antonov/react-native-background-downloader` for actual byte transfers, which already handles streaming + background. `sourceFetch` is for **control-plane** requests (listings, checksums, optional HEADs, manifest fetches).

### OQ-3.2 — Should `Authorization` from `configureSource({ headers: { Authorization: ... } })` override `ctx.token`?

**Decision: No — explicit `token` always wins (accepted).**

If a user wants raw header control, they leave `token` undefined and set `headers: { Authorization: '...' }`. If both are set, `token` wins. This is the most common error path (a stale token in `headers` getting overridden by a fresh token in `token`) and the fetcher protects against it.

### OQ-3.3 — Retry on 401/403?

**Decision: Never (accepted).**

Auth failures are deterministic state; retrying never changes them. They map straight to `DOWNLOAD_SOURCE_AUTH_FAILED`. This is documented in the public error code table.

### OQ-3.4 — Should `requestPolicy` be configurable per source via `configureSource`?

**Decision: Yes (already in `SourceConfig`).**

`configureSource('huggingface', { requestPolicy: { retries: 2, initialDelayMs: 500 } })` is the per-source default. Per-call options still win.
