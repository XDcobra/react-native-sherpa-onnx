import SherpaOnnx from '../NativeSherpaOnnx';
import { runOfflineTextToAudioPipeline } from '../pipeline/offlineOrchestrator';
import type { TextToAudioOrchestrationResult } from '../pipeline/offlineOrchestrator';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type { SegmentationPolicy } from '../segment/engine-types';
import { validateSegmentationConfig } from '../segment/validation';
import { toNativeSynthesisOptions } from './ttsNativeBridge';
import {
  createTtsProgressEmitter,
  synthesizeTtsWithProgress,
} from './synthesizeWithProgress';
import type { TtsSynthesisOptions } from './types';

const DEFAULT_TTS_SEGMENTATION_POLICY: SegmentationPolicy = {
  evaluator: 'text_synthetic_auto',
  sentenceBoundary: true,
  maxLengthChars: 500,
};

export async function runOfflineTtsPipeline(
  textIn: OfflineTextBufferIdSource,
  instanceId: string,
  options: TtsSynthesisOptions = {}
): Promise<TextToAudioOrchestrationResult> {
  const segmentation = validateSegmentationConfig({
    mode: options.segmentation?.mode,
    policy: options.segmentation?.policy,
    featureName: 'offline TTS',
    domain: 'text',
    supportsManual: false,
    defaultPolicy: DEFAULT_TTS_SEGMENTATION_POLICY,
  });

  const sampleRate = await SherpaOnnx.getTtsSampleRate(instanceId);
  const startedAtMs = Date.now();
  const emit = createTtsProgressEmitter(options.onProgress, startedAtMs);
  const nativeOptions = toNativeSynthesisOptions(options) ?? undefined;

  return runOfflineTextToAudioPipeline(
    textIn,
    async (segIn, segOut, ctx) => {
      emit({
        segmentIndex: ctx.segmentIndex,
        segmentCount: ctx.segmentCount,
        generateFraction: 0,
      });
      await synthesizeTtsWithProgress(
        instanceId,
        segIn.bufferId,
        segOut.bufferId,
        nativeOptions,
        options.onProgress
          ? (generateFraction) => {
              emit({
                segmentIndex: ctx.segmentIndex,
                segmentCount: ctx.segmentCount,
                generateFraction,
                elapsedMs: Date.now() - startedAtMs,
              });
            }
          : undefined
      );
      emit({
        segmentIndex: ctx.segmentIndex,
        segmentCount: ctx.segmentCount,
        generateFraction: 1,
        elapsedMs: Date.now() - startedAtMs,
      });
    },
    {
      segmentation,
      errorRecovery: options.errorRecovery,
      maxRetriesPerSegment: options.maxRetriesPerSegment,
      retryExhaustedFallback: options.retryExhaustedFallback,
      deferProgressToConsumer: true,
      overlapChars: options.overlapChars,
      textSkipPlaceholder: options.textSkipPlaceholder,
      linkMap: options.linkMap,
      sampleRate,
      channels: 1,
    }
  );
}
