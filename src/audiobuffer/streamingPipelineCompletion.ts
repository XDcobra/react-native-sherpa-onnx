import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  StreamingPipelineCompletion,
  StreamingPipelineCompletionReason,
  StreamingPipelineStatus,
} from './streamingPipelineTypes';

type NativeSubscription = { remove: () => void };

type PendingCompletion = {
  promise: Promise<StreamingPipelineCompletion>;
  resolve: (value: StreamingPipelineCompletion) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
};

const pendingCompletions = new Map<string, PendingCompletion>();
let completionSubscription: NativeSubscription | null = null;

function normalizeReason(value: unknown): StreamingPipelineCompletionReason {
  if (value === 'stopped' || value === 'error' || value === 'completed') {
    return value;
  }
  return 'completed';
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function normalizeCompletionEvent(
  event: unknown
): StreamingPipelineCompletion | null {
  const raw = event as Record<string, unknown> | null;
  if (raw == null) {
    return null;
  }

  const pipelineId = typeof raw.pipelineId === 'string' ? raw.pipelineId : null;
  if (!pipelineId) {
    return null;
  }

  const reason = normalizeReason(raw.reason);
  const error =
    raw.error == null
      ? null
      : typeof raw.error === 'string'
      ? raw.error
      : String(raw.error);

  return {
    pipelineId,
    reason,
    chunksProcessed: toSafeNumber(raw.chunksProcessed),
    unitsRead: toSafeNumber(raw.unitsRead),
    unitsWritten: toSafeNumber(raw.unitsWritten),
    error,
  };
}

function statusToCompletion(
  status: StreamingPipelineStatus
): StreamingPipelineCompletion {
  return {
    pipelineId: status.pipelineId,
    reason: status.error ? 'error' : 'completed',
    chunksProcessed: status.chunksProcessed,
    unitsRead: status.unitsRead,
    unitsWritten: status.unitsWritten,
    error: status.error,
  };
}

function maybeTearDownCompletionSubscription(): void {
  if (pendingCompletions.size > 0) return;
  completionSubscription?.remove();
  completionSubscription = null;
}

function settlePendingCompletion(
  completion: StreamingPipelineCompletion
): void {
  const pending = pendingCompletions.get(completion.pipelineId);
  if (!pending || pending.settled) return;

  pending.settled = true;
  pendingCompletions.delete(completion.pipelineId);

  if (completion.reason === 'error') {
    const error = Object.assign(
      new Error(
        completion.error ??
          `Streaming pipeline ${completion.pipelineId} failed with unknown error`
      ),
      {
        code: 'STREAMING_PIPELINE_ERROR',
        completion,
      }
    );
    pending.reject(error);
  } else {
    pending.resolve(completion);
  }

  maybeTearDownCompletionSubscription();
}

function ensureCompletionSubscription(): void {
  if (completionSubscription) return;

  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx);
  completionSubscription = emitter.addListener(
    'streamingPipelineCompleted',
    (event: unknown) => {
      const completion = normalizeCompletionEvent(event);
      if (!completion) return;
      settlePendingCompletion(completion);
    }
  );
}

function startImmediateStatusFallback(pipelineId: string): void {
  // Covers a rare race where native completion can happen before JS subscribes.
  Promise.resolve()
    .then(async () => {
      const pending = pendingCompletions.get(pipelineId);
      if (!pending || pending.settled) return;

      try {
        const status = await SherpaOnnx.getStreamingPipelineStatus(pipelineId);
        if (!status.isRunning) {
          settlePendingCompletion(statusToCompletion(status));
        }
      } catch {
        // Ignore and continue waiting for the native completion event.
      }
    })
    .catch(() => {
      // Ignore fallback errors.
    });
}

export function createStreamingPipelineCompletionPromise(
  pipelineId: string
): Promise<StreamingPipelineCompletion> {
  const trimmedPipelineId = pipelineId.trim();
  if (trimmedPipelineId.length === 0) {
    throw new Error(
      'pipelineId is required to create pipeline completion promise'
    );
  }

  const existing = pendingCompletions.get(trimmedPipelineId);
  if (existing) {
    return existing.promise;
  }

  ensureCompletionSubscription();

  let resolveFn: ((value: StreamingPipelineCompletion) => void) | null = null;
  let rejectFn: ((reason?: unknown) => void) | null = null;

  const promise = new Promise<StreamingPipelineCompletion>(
    (resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    }
  );

  pendingCompletions.set(trimmedPipelineId, {
    promise,
    resolve: resolveFn!,
    reject: rejectFn!,
    settled: false,
  });

  startImmediateStatusFallback(trimmedPipelineId);
  return promise;
}
