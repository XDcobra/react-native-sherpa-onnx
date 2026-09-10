import SherpaOnnx, {
  type AudioTaggingProcessNativeResult,
} from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { buildAudioTaggingInitBridgeOptions } from './audioTaggingNativeBridge';
import {
  AudioTaggingErrorCode,
  type AudioTaggingEngine,
  type AudioTaggingEvent,
  type AudioTaggingInitializeOptions,
  type AudioTaggingResult,
  type AudioTaggingTagOptions,
} from './types';

let instanceCounter = 0;

function normalizeEvents(
  raw: AudioTaggingProcessNativeResult['events'] | undefined
): AudioTaggingEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: AudioTaggingEvent[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name : '';
    const index =
      typeof item.index === 'number' && Number.isFinite(item.index)
        ? item.index
        : 0;
    const prob =
      typeof item.prob === 'number' && Number.isFinite(item.prob)
        ? item.prob
        : 0;
    events.push({ name, index, prob });
  }
  return events;
}

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
    ): Promise<AudioTaggingResult> {
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

      if (tagOptions?.segmentation?.mode === 'auto') {
        throw new Error(
          `${AudioTaggingErrorCode.NOT_IMPLEMENTED}: segmentation.mode 'auto' is Phase 3 — not available in Phase 2 oneshot`
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

      const res: AudioTaggingProcessNativeResult =
        await SherpaOnnx.tagAudioOffline(instanceId, audioBufferId, topK);

      const events = normalizeEvents(res?.events);
      const primary = events.length > 0 ? events[0] : undefined;

      return {
        events,
        ...(primary !== undefined ? { primary } : {}),
        audioDuration:
          typeof res?.audioDuration === 'number' ? res.audioDuration : 0,
        elapsedMs: typeof res?.elapsedMs === 'number' ? res.elapsedMs : 0,
        topK: typeof res?.topK === 'number' ? res.topK : topK ?? 5,
      };
    },

    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      await SherpaOnnx.unloadAudioTagging(instanceId);
    },
  };
}
