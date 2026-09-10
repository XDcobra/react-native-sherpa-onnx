import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import { buildAudioTaggingInitBridgeOptions } from './audioTaggingNativeBridge';
import { isLiveAudioSource, isLiveTextSource, tagLiveOverload } from './live';
import {
  normalizeAudioTaggingNativeResult,
  runOfflineAudioTaggingSegmentation,
} from './orchestrate';
import type { AudioTaggingPipelineHandle } from './streamingTypes';
import {
  AudioTaggingErrorCode,
  type AudioTaggingEngine,
  type AudioTaggingInitializeOptions,
  type AudioTaggingLivePipelineOptions,
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

  const tagImpl = async (
    audioOrLive: OfflineAudioBufferIdSource | LiveAudioBufferIdSource,
    second?:
      | AudioTaggingTagOptions
      | LiveTextBufferIdSource
      | AudioTaggingLivePipelineOptions,
    third?: AudioTaggingLivePipelineOptions
  ): Promise<
    | AudioTaggingResult
    | SegmentedAudioTaggingResult
    | AudioTaggingPipelineHandle
  > => {
    if (isDestroyed) {
      throw new Error(
        `${AudioTaggingErrorCode.DESTROYED}: Audio tagging engine instance ${instanceId} has been destroyed`
      );
    }
    if (audioOrLive == null) {
      throw new Error(
        `${AudioTaggingErrorCode.INVALID_ARGUMENT}: audio buffer is required`
      );
    }

    // Mode 3: tag(liveAudio, liveText, options)
    if (isLiveAudioSource(audioOrLive) && isLiveTextSource(second)) {
      if (third == null || typeof third !== 'object') {
        throw new Error(
          `${AudioTaggingErrorCode.INVALID_ARGUMENT}: live tag requires options with segmentation`
        );
      }
      return tagLiveOverload(
        instanceId,
        audioOrLive,
        second,
        third as AudioTaggingLivePipelineOptions
      );
    }

    if (isLiveAudioSource(audioOrLive)) {
      throw new Error(
        `${AudioTaggingErrorCode.INVALID_ARGUMENT}: tag(liveAudio, …) requires (liveAudio, liveText, options).`
      );
    }

    const tagOptions =
      second != null && typeof second === 'object' && !isLiveTextSource(second)
        ? (second as AudioTaggingTagOptions)
        : undefined;

    if (tagOptions?.segmentation?.mode === 'manual') {
      throw new Error(
        `${AudioTaggingErrorCode.INVALID_ARGUMENT}: audio tagging does not support segmentation.mode=manual`
      );
    }

    if (tagOptions?.segmentation?.mode === 'auto') {
      return runOfflineAudioTaggingSegmentation(
        instanceId,
        audioOrLive,
        tagOptions
      );
    }

    let audioBufferId: string;
    try {
      audioBufferId = resolvePipelineAudioBufferId(audioOrLive);
    } catch (e: any) {
      throw new Error(
        `${AudioTaggingErrorCode.INVALID_ARGUMENT}: ${e?.message ?? String(e)}`
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
  };

  return {
    get instanceId() {
      return instanceId;
    },

    tag: tagImpl as AudioTaggingEngine['tag'],

    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      await SherpaOnnx.unloadAudioTagging(instanceId);
    },
  };
}
