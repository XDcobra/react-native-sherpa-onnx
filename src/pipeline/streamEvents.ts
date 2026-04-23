/**
 * Shared opt-in + throttle shape for high-frequency **stream** events (native → JS)
 * for live audio, text, segment buffers, etc.
 */

export type StreamEventSpec = {
  /** When true, the native side may emit events for this stream class. */
  enabled: boolean;
  /** Minimum time between events in ms. `0` means unthrottled. */
  minIntervalMs: number;
};
