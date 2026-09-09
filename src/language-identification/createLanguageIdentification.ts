import SherpaOnnx, {
  type LanguageIdProcessNativeResult,
} from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import { buildLanguageIdInitBridgeOptions } from './languageIdNativeBridge';
import {
  identifyLiveOverload,
  isLiveAudioSource,
  isLiveTextSource,
} from './live';
import {
  runOfflineLanguageIdLabeling,
  runOfflineLanguageIdSegmentation,
} from './orchestrate';
import type { LanguageIdentificationPipelineHandle } from './streamingTypes';
import {
  LanguageIdErrorCode,
  type LanguageIdLabelOptions,
  type LanguageIdentificationEngine,
  type LanguageIdentificationInitializeOptions,
  type LanguageIdentificationLivePipelineOptions,
  type LanguageIdentificationOptions,
  type LanguageIdentificationResult,
  type LabelOfflineSegmentsResult,
  type SegmentedLanguageIdentificationResult,
} from './types';

let instanceCounter = 0;

export async function createLanguageIdentification(
  options: LanguageIdentificationInitializeOptions
): Promise<LanguageIdentificationEngine> {
  if (options == null || typeof options !== 'object') {
    throw new Error(
      `${LanguageIdErrorCode.INVALID_ARGUMENT}: options must be an object`
    );
  }

  const bridgeOptions = await buildLanguageIdInitBridgeOptions(options);
  const instanceId = `lang_id_${++instanceCounter}_${Date.now()}`;

  const initResult = await SherpaOnnx.initializeLanguageId(
    instanceId,
    bridgeOptions
  );
  if (!initResult.success) {
    throw new Error(
      `${LanguageIdErrorCode.INIT_FAILED}: ${
        initResult.error ?? 'Failed to initialize language identification'
      }`
    );
  }

  let isDestroyed = false;

  const identifyImpl = async (
    audioOrLive: OfflineAudioBufferIdSource | LiveAudioBufferIdSource,
    second?:
      | LanguageIdentificationOptions
      | LiveTextBufferIdSource
      | LanguageIdentificationLivePipelineOptions,
    third?: LanguageIdentificationLivePipelineOptions
  ): Promise<
    | LanguageIdentificationResult
    | SegmentedLanguageIdentificationResult
    | LanguageIdentificationPipelineHandle
  > => {
    if (isDestroyed) {
      throw new Error(
        `${LanguageIdErrorCode.DESTROYED}: Language identification engine instance ${instanceId} has been destroyed`
      );
    }
    if (audioOrLive == null) {
      throw new Error(
        `${LanguageIdErrorCode.INVALID_ARGUMENT}: audio buffer is required`
      );
    }

    // Mode 3: identify(liveAudio, liveText, options)
    if (isLiveAudioSource(audioOrLive) && isLiveTextSource(second)) {
      if (third == null || typeof third !== 'object') {
        throw new Error(
          `${LanguageIdErrorCode.INVALID_ARGUMENT}: live identify requires options with segmentation`
        );
      }
      return identifyLiveOverload(
        instanceId,
        audioOrLive,
        second,
        third as LanguageIdentificationLivePipelineOptions
      );
    }

    if (isLiveAudioSource(audioOrLive)) {
      throw new Error(
        `${LanguageIdErrorCode.INVALID_ARGUMENT}: identify(liveAudio, …) requires (liveAudio, liveText, options).`
      );
    }

    const identifyOptions =
      second != null && typeof second === 'object' && !isLiveTextSource(second)
        ? (second as LanguageIdentificationOptions)
        : undefined;

    if (identifyOptions?.segmentation?.mode === 'auto') {
      return runOfflineLanguageIdSegmentation(
        instanceId,
        audioOrLive,
        identifyOptions
      );
    }

    let audioBufferId: string;
    try {
      audioBufferId = resolvePipelineAudioBufferId(audioOrLive);
    } catch (e: any) {
      throw new Error(
        `${LanguageIdErrorCode.INVALID_ARGUMENT}: ${e?.message ?? String(e)}`
      );
    }

    if (
      typeof audioBufferId !== 'string' ||
      !audioBufferId.startsWith('off_')
    ) {
      throw new Error(
        `${
          LanguageIdErrorCode.INVALID_ARGUMENT
        }: expected an offline audio buffer (off_...), got ${String(
          audioBufferId
        )}`
      );
    }

    const res: LanguageIdProcessNativeResult =
      await SherpaOnnx.identifyLanguageOffline(
        instanceId,
        audioBufferId,
        null,
        null
      );

    return {
      lang: res.lang,
      audioDuration: res.audioDuration,
      elapsedMs: res.elapsedMs,
    };
  };

  return {
    get instanceId() {
      return instanceId;
    },

    identify: identifyImpl as LanguageIdentificationEngine['identify'],

    async labelOfflineSegments(
      audioIn: OfflineAudioBufferIdSource,
      segmentsIn: OfflineSegmentBufferIdSource,
      segmentsOut: OfflineSegmentBufferIdSource,
      labelOptions?: LanguageIdLabelOptions
    ): Promise<LabelOfflineSegmentsResult> {
      if (isDestroyed) {
        throw new Error(
          `${LanguageIdErrorCode.DESTROYED}: Language identification engine instance ${instanceId} has been destroyed`
        );
      }
      if (audioIn == null) {
        throw new Error(
          `${LanguageIdErrorCode.INVALID_ARGUMENT}: audioIn is required`
        );
      }
      if (segmentsIn == null) {
        throw new Error(
          `${LanguageIdErrorCode.INVALID_ARGUMENT}: segmentsIn is required`
        );
      }
      if (segmentsOut == null) {
        throw new Error(
          `${LanguageIdErrorCode.INVALID_ARGUMENT}: segmentsOut is required`
        );
      }

      return runOfflineLanguageIdLabeling(
        instanceId,
        audioIn,
        segmentsIn,
        segmentsOut,
        labelOptions
      );
    },

    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      await SherpaOnnx.unloadLanguageId(instanceId);
    },
  };
}
