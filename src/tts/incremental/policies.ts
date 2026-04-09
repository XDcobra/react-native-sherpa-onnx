import type {
  QueuePolicy,
  QueueMode,
  OverflowStrategy,
  SegmentId,
} from './types';

// ---------------------------------------------------------------------------
// Queued segment
// ---------------------------------------------------------------------------

export interface QueuedSegment {
  id: SegmentId;
  text: string;
}

// ---------------------------------------------------------------------------
// Resolved policy (defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedQueuePolicy {
  mode: QueueMode;
  maxSegments: number;
  maxBufferedChars: number;
  overflowStrategy: OverflowStrategy;
}

export function resolveQueuePolicy(policy?: QueuePolicy): ResolvedQueuePolicy {
  return {
    mode: policy?.mode ?? 'fifo',
    maxSegments: policy?.maxSegments ?? 50,
    maxBufferedChars: policy?.maxBufferedChars ?? 10000,
    overflowStrategy: policy?.overflowStrategy ?? 'drop-oldest',
  };
}

// ---------------------------------------------------------------------------
// Enqueue result
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  accepted: boolean;
  dropped: QueuedSegment[];
}

// ---------------------------------------------------------------------------
// Policy application
// ---------------------------------------------------------------------------

function queuedChars(queue: readonly QueuedSegment[]): number {
  let n = 0;
  for (const s of queue) n += s.text.length;
  return n;
}

/**
 * Apply the queue policy when a new segment is enqueued.
 * Mutates `queue` in-place. Returns which segments were dropped (if any).
 */
export function applyEnqueuePolicy(
  queue: QueuedSegment[],
  newSegment: QueuedSegment,
  policy: ResolvedQueuePolicy
): EnqueueResult {
  const dropped: QueuedSegment[] = [];

  switch (policy.mode) {
    // -----------------------------------------------------------------
    case 'latest-wins': {
      dropped.push(...queue);
      queue.length = 0;
      queue.push(newSegment);
      return { accepted: true, dropped };
    }

    // -----------------------------------------------------------------
    case 'replace-tail': {
      if (queue.length > 0) {
        dropped.push(queue.pop()!);
      }
      queue.push(newSegment);
      return { accepted: true, dropped };
    }

    // -----------------------------------------------------------------
    case 'fifo':
    default: {
      const overLimit =
        queue.length >= policy.maxSegments ||
        queuedChars(queue) + newSegment.text.length > policy.maxBufferedChars;

      if (!overLimit) {
        queue.push(newSegment);
        return { accepted: true, dropped };
      }

      switch (policy.overflowStrategy) {
        case 'drop-oldest': {
          while (
            queue.length > 0 &&
            (queue.length >= policy.maxSegments ||
              queuedChars(queue) + newSegment.text.length >
                policy.maxBufferedChars)
          ) {
            dropped.push(queue.shift()!);
          }
          queue.push(newSegment);
          return { accepted: true, dropped };
        }
        case 'drop-newest':
        case 'reject': {
          dropped.push(newSegment);
          return { accepted: false, dropped };
        }
      }
    }
  }
}
