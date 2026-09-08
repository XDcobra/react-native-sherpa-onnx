import SherpaOnnx, {
  type LanguageIdProcessNativeResult,
} from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { buildLanguageIdInitBridgeOptions } from './languageIdNativeBridge';
import {
  LanguageIdErrorCode,
  type LanguageIdentificationEngine,
  type LanguageIdentificationInitializeOptions,
  type LanguageIdentificationResult,
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

  return {
    get instanceId() {
      return instanceId;
    },

    async identify(
      audio: OfflineAudioBufferIdSource
    ): Promise<LanguageIdentificationResult> {
      if (isDestroyed) {
        throw new Error(
          `${LanguageIdErrorCode.DESTROYED}: Language identification engine instance ${instanceId} has been destroyed`
        );
      }
      if (audio == null) {
        throw new Error(
          `${LanguageIdErrorCode.INVALID_ARGUMENT}: audio buffer is required`
        );
      }

      let audioBufferId: string;
      try {
        audioBufferId = resolvePipelineAudioBufferId(audio);
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
        await SherpaOnnx.identifyLanguageOffline(instanceId, audioBufferId);

      return {
        lang: res.lang,
        audioDuration: res.audioDuration,
        elapsedMs: res.elapsedMs,
      };
    },

    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      await SherpaOnnx.unloadLanguageId(instanceId);
    },
  };
}
