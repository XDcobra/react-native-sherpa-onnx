/**
 * Generic streaming pipeline types.
 *
 * These are pipeline orchestration primitives shared by all streaming pipeline
 * types (enhancement, STT, TTS, alignment, etc.).  Field names are intentionally
 * generic ("units") because different pipelines produce/consume different data
 * types (audio samples, text characters, …).
 */

export interface StreamingPipelineStatus {
  pipelineId: string;
  isRunning: boolean;
  chunksProcessed: number;
  /** Total units read from the input buffer (audio samples, text chars, …). */
  unitsRead: number;
  /** Total units written to the output buffer (audio samples, text chars, …). */
  unitsWritten: number;
  error: string | null;
}

export type StreamingPipelineCompletionReason =
  | 'completed'
  | 'stopped'
  | 'error';

export interface StreamingPipelineCompletion {
  pipelineId: string;
  reason: StreamingPipelineCompletionReason;
  chunksProcessed: number;
  /** Total units read from the input buffer (audio samples, text chars, …). */
  unitsRead: number;
  /** Total units written to the output buffer (audio samples, text chars, …). */
  unitsWritten: number;
  error: string | null;
}

export interface StreamingPipelineHandle {
  readonly pipelineId: string;
  /**
   * Settles exactly once when the native pipeline reaches a terminal state.
   *
   * - Resolves with `reason: 'completed'` when normal drain/flush finished.
   * - Resolves with `reason: 'stopped'` when explicitly stopped.
   * - Rejects when `reason: 'error'` (the error details are attached on the thrown error as `completion`).
   */
  readonly completed: Promise<StreamingPipelineCompletion>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<StreamingPipelineStatus>;
}
