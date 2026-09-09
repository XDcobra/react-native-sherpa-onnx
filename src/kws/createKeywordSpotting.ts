import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolvePipelineTextBufferId } from '../textbuffer';
import { subscribeLiveTextBufferEvents } from '../textbuffer';
import type { LiveTextBufferSegmentEvent } from '../textbuffer/types';
import { detectKwsModel } from './detectKwsModel';
import { buildKeywordSpottingInitBridgeOptions } from './kwsNativeBridge';
import type {
  KeywordDetection,
  KeywordSpottingEngine,
  KeywordSpottingInitOptions,
  KeywordSpottingPipelineOptions,
} from './types';

let keywordSpottingInstanceCounter = 0;

function logKwsPipelineStart(args: {
  pipelineId: string;
  chunkSize: number | undefined;
  audioInLiveBufferId: string;
  textOutLiveBufferId: string;
}): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    return;
  }
  console.log('[SherpaOnnx:kws] spot started', {
    pipelineId: args.pipelineId,
    chunkSize:
      args.chunkSize === undefined ? '(native default)' : args.chunkSize,
    audioInLiveBufferId: args.audioInLiveBufferId,
    textOutLiveBufferId: args.textOutLiveBufferId,
  });
}

function mapSegmentToKeywordDetection(
  event: LiveTextBufferSegmentEvent
): (KeywordDetection & { segmentIndex: number }) | null {
  if (event.segment.domain !== 'text') {
    return null;
  }
  const meta = (event.segment.meta ?? {}) as Record<string, unknown>;
  // Segment.source collapses pipeline tags to segmentation_engine|manual|external;
  // KWS workers stamp public meta.source = 'kws_stream' (and keyword) for filtering.
  if (meta.source !== 'kws_stream') {
    return null;
  }
  const keyword = (event.segment.text ?? '').trim();
  if (!keyword) {
    return null;
  }
  const startTimeRaw = meta.startTime;
  const startTime =
    typeof startTimeRaw === 'number' && Number.isFinite(startTimeRaw)
      ? startTimeRaw
      : undefined;
  return {
    keyword,
    tokens: Array.isArray(event.segment.tokens) ? event.segment.tokens : [],
    timestamps: Array.isArray(event.segment.timestamps)
      ? event.segment.timestamps
      : [],
    ...(startTime !== undefined ? { startTime } : {}),
    segmentIndex: event.segment.segmentIndex,
  };
}

export async function createKeywordSpotting(
  options: KeywordSpottingInitOptions
): Promise<KeywordSpottingEngine> {
  if (options == null || typeof options !== 'object' || !options.modelSource) {
    throw new Error(
      'Keyword spotting initialization requires a modelSource option'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  const detected = await detectKwsModel(
    { kind: 'fs', path: modelDir },
    { quantization: options.quantization }
  );
  if (!detected.success) {
    throw new Error(
      `Keyword spotting model detection failed for ${modelDir}: ${
        detected.error ?? 'Unknown error'
      }`
    );
  }
  if (!detected.isStreaming) {
    throw new Error(
      `Keyword spotting requires a streaming (online) KWS pack for ${modelDir}`
    );
  }
  if (!detected.paths) {
    throw new Error(
      `Keyword spotting model detection returned no paths for ${modelDir}`
    );
  }

  const bridgeOptions = buildKeywordSpottingInitBridgeOptions(
    detected.paths,
    options
  );
  const instanceId = `keyword_spotting_${++keywordSpottingInstanceCounter}`;
  const result = await SherpaOnnx.initializeKeywordSpotting(
    instanceId,
    bridgeOptions
  );
  if (!result.success) {
    const error = result.error?.trim();
    throw new Error(
      error
        ? `Keyword spotting initialization failed: ${error}`
        : `Keyword spotting initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  let activePipelineId: string | null = null;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Keyword spotting engine ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: KeywordSpottingEngine = {
    get instanceId() {
      return instanceId;
    },

    async spot(
      audioIn,
      textOut,
      pipelineOptions?: KeywordSpottingPipelineOptions
    ): Promise<StreamingPipelineHandle & { instanceId: string }> {
      guard();

      if (activePipelineId) {
        const status = await SherpaOnnx.getStreamingPipelineStatus(
          activePipelineId
        );
        if (status.isRunning) {
          throw new Error(
            `Keyword spotting pipeline already running for engine ${instanceId}`
          );
        }
      }

      const audioInLiveBufferId = resolvePipelineAudioBufferId(audioIn);
      const textOutLiveBufferId = resolvePipelineTextBufferId(textOut);

      const started = await SherpaOnnx.startKeywordSpottingPipeline(
        instanceId,
        audioInLiveBufferId,
        textOutLiveBufferId,
        pipelineOptions?.chunkSize,
        pipelineOptions?.keywords
      );
      logKwsPipelineStart({
        pipelineId: started.pipelineId,
        chunkSize: pipelineOptions?.chunkSize,
        audioInLiveBufferId,
        textOutLiveBufferId,
      });
      activePipelineId = started.pipelineId;

      let unsubscribeKeyword: (() => void) | null = null;
      if (pipelineOptions?.onKeyword) {
        const onKeyword = pipelineOptions.onKeyword;
        unsubscribeKeyword = subscribeLiveTextBufferEvents(
          textOutLiveBufferId,
          {
            onSegment: (event) => {
              const mapped = mapSegmentToKeywordDetection(event);
              if (mapped) {
                onKeyword(mapped);
              }
            },
          }
        );
      }

      const completed = createStreamingPipelineCompletionPromise(
        started.pipelineId
      ).finally(() => {
        unsubscribeKeyword?.();
        unsubscribeKeyword = null;
        if (activePipelineId === started.pipelineId) {
          activePipelineId = null;
        }
      });

      const handle: StreamingPipelineHandle & { instanceId: string } = {
        instanceId,
        get pipelineId() {
          return started.pipelineId;
        },
        completed,
        async stop(): Promise<void> {
          await SherpaOnnx.stopStreamingPipeline(started.pipelineId);
          unsubscribeKeyword?.();
          unsubscribeKeyword = null;
          if (activePipelineId === started.pipelineId) {
            activePipelineId = null;
          }
        },
        async flush(): Promise<void> {
          if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log('[SherpaOnnx:kws] flush', {
              pipelineId: started.pipelineId,
            });
          }
          await SherpaOnnx.flushStreamingPipeline(started.pipelineId);
        },
        async reset(): Promise<void> {
          await SherpaOnnx.resetStreamingPipeline(started.pipelineId);
        },
        async getStatus() {
          return SherpaOnnx.getStreamingPipelineStatus(started.pipelineId);
        },
      };

      return handle;
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;

      if (activePipelineId) {
        try {
          await SherpaOnnx.stopStreamingPipeline(activePipelineId);
        } catch {
          // Ignore teardown race if already removed.
        }
        activePipelineId = null;
      }

      await SherpaOnnx.unloadKeywordSpotting(instanceId);
    },
  };

  return engine;
}

export const createStreamingKWS = createKeywordSpotting;
