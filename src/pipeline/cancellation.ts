/** Error codes thrown by the offline segment orchestrator. */
export const OrchestrationErrorCode = {
  /** The run was stopped through `signal`. */
  CANCELLED: 'ORCHESTRATION_CANCELLED',
} as const;

/**
 * Error thrown when a run is stopped through `signal`:
 * `name` is `'AbortError'`, `code` is `'ORCHESTRATION_CANCELLED'`.
 */
export type OrchestrationCancelledError = Error & {
  name: 'AbortError';
  code: typeof OrchestrationErrorCode.CANCELLED;
};

/** Creates the error thrown when a run is stopped through `signal`. */
export function createOrchestrationCancelledError(): OrchestrationCancelledError {
  return Object.assign(
    new Error(`${OrchestrationErrorCode.CANCELLED}: operation cancelled`),
    {
      name: 'AbortError' as const,
      code: OrchestrationErrorCode.CANCELLED,
    }
  );
}

/** True when `err` is the error thrown for a run stopped through `signal`. */
export function isOrchestrationCancelledError(
  err: unknown
): err is OrchestrationCancelledError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === OrchestrationErrorCode.CANCELLED
  );
}

/**
 * Throws {@link OrchestrationCancelledError} when `signal` is aborted.
 * @throws {Error} `ORCHESTRATION_CANCELLED` — `signal` is aborted.
 */
export function throwIfOrchestrationAborted(
  signal: AbortSignal | undefined
): void {
  if (signal?.aborted) {
    throw createOrchestrationCancelledError();
  }
}
