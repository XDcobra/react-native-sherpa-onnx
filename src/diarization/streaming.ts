import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import { resolvePipelineSegmentBufferId } from '../segmentbuffer';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import {
  assertDiarizationCustomConfig,
  resolveDiarizationCustomConfigPaths,
} from './customConfig';
import { detectDiarizationModel } from './index';
import type {
  DiarizationPipelineHandle,
  StreamingDiarizationEngine,
  StreamingDiarizationInitializeOptions,
  StreamingDiarizationOptions,
} from './streamingTypes';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { LiveSegmentBufferIdSource } from '../segmentbuffer/types';

let streamingDiarizationInstanceCounter = 0;

function createDiarizationPipelineHandle(
  instanceId: string,
  pipelineId: string
): DiarizationPipelineHandle {
  const completed = createStreamingPipelineCompletionPromise(pipelineId);

  return {
    instanceId,
    get pipelineId() {
      return pipelineId;
    },
    completed,
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus(): Promise<StreamingPipelineStatus> {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

export async function createStreamingDiarization(
  options: StreamingDiarizationInitializeOptions
): Promise<StreamingDiarizationEngine> {
  const instanceId = `diar_stream_${++streamingDiarizationInstanceCounter}`;

  let modelPath: string;
  let metadataPath: string | undefined;

  if (options.initMode === 'custom') {
    assertDiarizationCustomConfig(
      options.customConfig as unknown as Record<string, unknown>
    );
    const resolvedPaths = await resolveDiarizationCustomConfigPaths(
      options.modelType,
      options.customConfig
    );
    if (!resolvedPaths.model) {
      throw new Error('Custom config missing required model path');
    }
    modelPath = resolvedPaths.model;
    metadataPath = resolvedPaths.metadata;
  } else {
    const detected = await detectDiarizationModel(options.modelSource, {
      modelType: options.modelType ?? 'auto',
    });

    if (!detected.isStreaming) {
      throw new Error(
        'Detected model is an offline diarization model. Use createDiarization for offline diarization.'
      );
    }
    if (!detected.paths || !detected.paths.model) {
      throw new Error('Failed to resolve streaming diarization model path');
    }
    modelPath = detected.paths.model;
    metadataPath = detected.paths.metadata;
  }

  const initResult = await SherpaOnnx.initializeStreamingDiarization(
    instanceId,
    {
      model: modelPath,
      metadata: metadataPath,
      numThreads: options.numThreads ?? 1,
      provider: options.provider ?? 'cpu',
      debug: options.debug ?? false,
      onset: options.onset ?? 0.5,
      offset: options.offset ?? 0.5,
      padOnset: options.padOnset ?? 0.0,
      padOffset: options.padOffset ?? 0.0,
      minDurationOn: options.minDurationOn ?? 0.0,
      minDurationOff: options.minDurationOff ?? 0.5,
      medianWindow: options.medianWindow ?? 11,
    }
  );

  if (!initResult.success) {
    throw new Error(
      initResult.error ??
        'Failed to initialize streaming diarization native engine'
    );
  }

  let released = false;

  const assertNotReleased = () => {
    if (released) {
      throw new Error(
        `StreamingDiarizationEngine [${instanceId}] has already been released`
      );
    }
  };

  return {
    instanceId,
    sampleRate: initResult.sampleRate ?? 16000,
    maxSpeakers: initResult.maxSpeakers ?? 4,
    feedSamples: initResult.feedSamples ?? 160000,
    strideSamples: initResult.strideSamples ?? 158720,
    latencySeconds: initResult.latencySeconds ?? 10.0,

    async startPipeline(
      audioIn: LiveAudioBufferIdSource,
      segmentOut: LiveSegmentBufferIdSource,
      pipelineOptions?: StreamingDiarizationOptions
    ): Promise<DiarizationPipelineHandle> {
      assertNotReleased();
      const audioInId = resolvePipelineAudioBufferId(audioIn);
      const segmentOutId = resolvePipelineSegmentBufferId(segmentOut);

      if (!audioInId.startsWith('live_')) {
        throw new Error(
          `Expected live audio buffer (live_*) for audioIn, got: ${audioInId}`
        );
      }
      if (!segmentOutId.startsWith('seg_live_')) {
        throw new Error(
          `Expected live segment buffer (seg_live_*) for segmentOut, got: ${segmentOutId}`
        );
      }

      const res = await SherpaOnnx.startStreamingDiarizationPipeline(
        instanceId,
        audioInId,
        segmentOutId,
        pipelineOptions as unknown as Record<string, unknown>
      );

      return createDiarizationPipelineHandle(instanceId, res.pipelineId);
    },

    async feed(
      audioIn: OfflineAudioBufferIdSource
    ): Promise<Array<{ start: number; end: number; speaker: number }>> {
      assertNotReleased();
      const audioInId = resolvePipelineAudioBufferId(audioIn);
      const res = await SherpaOnnx.feedStreamingDiarization(
        instanceId,
        audioInId
      );
      if (!res.success) {
        throw new Error(res.error ?? 'Feed streaming diarization failed');
      }
      return res.segments ?? [];
    },

    async flush(): Promise<
      Array<{ start: number; end: number; speaker: number }>
    > {
      assertNotReleased();
      const res = await SherpaOnnx.flushStreamingDiarization(instanceId);
      if (!res.success) {
        throw new Error(res.error ?? 'Flush streaming diarization failed');
      }
      return res.segments ?? [];
    },

    async reset(): Promise<void> {
      assertNotReleased();
      await SherpaOnnx.resetStreamingDiarization(instanceId);
    },

    async release(): Promise<void> {
      if (released) return;
      released = true;
      await SherpaOnnx.releaseStreamingDiarization(instanceId);
    },
  };
}
