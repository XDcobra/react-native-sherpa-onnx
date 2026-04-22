import { NativeEventEmitter, NativeModules } from 'react-native';
import type { VADEvent } from './types';

type NativeSubscription = { remove: () => void };

const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx);

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseVadEvent(raw: unknown): VADEvent | null {
  const event = raw as Record<string, unknown> | null;
  if (event == null) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  const instanceId =
    typeof event.instanceId === 'string' ? event.instanceId : undefined;
  const pipelineId =
    typeof event.pipelineId === 'string' ? event.pipelineId : undefined;
  const ts = toNumber(event.ts, Date.now());
  if (!instanceId || !pipelineId) return null;

  switch (type) {
    case 'pipeline.started':
      return { type, instanceId, pipelineId, ts };
    case 'pipeline.progress':
      return {
        type,
        instanceId,
        pipelineId,
        ts,
        chunksProcessed: toNumber(event.chunksProcessed),
        unitsRead: toNumber(event.unitsRead),
        unitsWritten: toNumber(event.unitsWritten),
        queueDepth: toNumber(event.queueDepth),
      };
    case 'vad.stateChanged':
      return {
        type,
        instanceId,
        pipelineId,
        ts,
        isSpeechDetected: event.isSpeechDetected === true,
      };
    case 'segment.appended':
      return {
        type,
        instanceId,
        pipelineId,
        ts,
        segmentId: typeof event.segmentId === 'string' ? event.segmentId : '',
        segmentIndex: toNumber(event.segmentIndex),
      };
    case 'pipeline.flushed':
      return { type, instanceId, pipelineId, ts };
    case 'pipeline.completed':
      return {
        type,
        instanceId,
        pipelineId,
        ts,
        summary: {
          chunksProcessed: toNumber(event.chunksProcessed),
          unitsRead: toNumber(event.unitsRead),
          unitsWritten: toNumber(event.unitsWritten),
          segmentCount: toNumber(event.segmentCount),
          speechDurationMs: toNumber(event.speechDurationMs),
        },
      };
    case 'pipeline.error':
      return {
        type,
        instanceId,
        pipelineId,
        ts,
        error:
          typeof event.error === 'string' ? event.error : 'Unknown VAD error',
      };
    default:
      return null;
  }
}

export function subscribeVadEvents(
  instanceId: string,
  listener: (event: VADEvent) => void
): () => void {
  const sub: NativeSubscription = emitter.addListener(
    'vadEvent',
    (raw: unknown) => {
      const event = parseVadEvent(raw);
      if (!event || event.instanceId !== instanceId) return;
      listener(event);
    }
  );
  return () => {
    sub.remove();
  };
}
