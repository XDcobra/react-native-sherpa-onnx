import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { buildAudioTaggingInitBridgeOptions } from './audioTaggingNativeBridge';
import {
  normalizeAudioTaggingNativeResult,
  runOfflineAudioTaggingSegmentation,
} from './orchestrate';
import {
  AudioTaggingErrorCode,
  type AudioTaggingEngine,
  type AudioTaggingInitializeOptions,
  type AudioTaggingResult,
  type AudioTaggingTagOptions,
  type SegmentedAudioTaggingResult,
} from './types';

let instanceCounter = 0;

export async function createAudioTagging(
  options: AudioTaggingInitializeOptions
): Promise<AudioTaggingEngine> {
  if (options == null || typeof options !== 'object') {
    throw new Error(
      `${AudioTaggingErrorCode.INVALID_ARGUMENT}: options must be an object`
    );
  }

  if (options.initMode === 'custom') {
    if (options.customConfig == null) {
      throw new Error(
        `${AudioTaggingErrorCode.INVALID_ARGUMENT}: custom init requires customConfig`
      );
    }
  } else if (
    (options as { modelSource?: unknown }).modelSource == null &&
    (options as { customConfig?: unknown }).customConfig == null
  ) {
    throw new Error(
      `${AudioTaggingErrorCode.INVALID_ARGUMENT}: modelSource or customConfig is required`
    );
  }

  const bridgeOptions = await buildAudioTaggingInitBridgeOptions(options);
  const instanceId = `audio_tagging_${++instanceCounter}_${Date.now()}`;

  const initResult = await SherpaOnnx.initializeAudioTagging(
    instanceId,
    bridgeOptions
  );
  if (!initResult.success) {
    throw new Error(
      `${AudioTaggingErrorCode.INIT_FAILED}: ${
        initResult.error ?? 'Failed to initialize audio tagging'
      }`
    );
  }

  let isDestroyed = false;

  return {
    get instanceId() {
      return instanceId;
    },

    async tag(
      offlineAudio: OfflineAudioBufferIdSource,
      tagOptions?: AudioTaggingTagOptions
    ): Promise<AudioTaggingResult | SegmentedAudioTaggingResult> {
      if (isDestroyed) {
        throw new Error(
          `${AudioTaggingErrorCode.DESTROYED}: Audio tagging engine instance ${instanceId} has been destroyed`
        );
      }
      if (offlineAudio == null) {
        throw new Error(
          `${AudioTaggingErrorCode.INVALID_ARGUMENT}: audio buffer is required`
        );
      }

      if (tagOptions?.segmentation?.mode === 'manual') {
        throw new Error(
          `${AudioTaggingErrorCode.INVALID_ARGUMENT}: audio tagging does not support segmentation.mode=manual`
        );
      }

      if (tagOptions?.segmentation?.mode === 'auto') {
        return runOfflineAudioTaggingSegmentation(
          instanceId,
          offlineAudio,
          tagOptions
        );
      }

      let audioBufferId: string;
      try {
        audioBufferId = resolvePipelineAudioBufferId(offlineAudio);
      } catch (e: any) {
        throw new Error(
          `${AudioTaggingErrorCode.INVALID_ARGUMENT}: ${
            e?.message ?? String(e)
          }`
        );
      }

      if (
        typeof audioBufferId !== 'string' ||
        !audioBufferId.startsWith('off_')
      ) {
        throw new Error(
          `${
            AudioTaggingErrorCode.INVALID_ARGUMENT
          }: expected an offline audio buffer (off_...), got ${String(
            audioBufferId
          )}`
        );
      }

      const topK =
        tagOptions?.topK !== undefined && Number.isFinite(tagOptions.topK)
          ? tagOptions.topK
          : null;

      const res = await SherpaOnnx.tagAudioOffline(
        instanceId,
        audioBufferId,
        topK,
        null,
        null
      );

      return normalizeAudioTaggingNativeResult(res, topK ?? 5);
    },

    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      await SherpaOnnx.unloadAudioTagging(instanceId);
    },
  };
}
