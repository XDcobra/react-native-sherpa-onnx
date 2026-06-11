/**
 * Source Separation feature module.
 *
 * Offline batch separation via `createSeparation` + `engine.separate(audioIn, audioOuts)`.
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectedModelEntry,
  type DetectionSource,
} from '../types/modelDetect';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type {
  SeparationDetectResult,
  SeparationEngine,
  SeparationInitializeOptions,
  SeparationModelType,
  SeparateOptions,
  SeparationResult,
} from './types';
import { SeparationErrorCode } from './customConfig';
import { buildSeparationInitBridgeOptions } from './separationNativeBridge';
import { runOfflineSeparationDirect } from './orchestrate';

let separationInstanceCounter = 0;

function readNonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Detect source separation model layout (Spleeter vs UVR) without running inference.
 * Offline only — `isStreaming` is always `false`.
 */
export async function detectSeparationModel(
  source: FileSource,
  options?: {
    modelType?: SeparationModelType | 'auto';
    assetName?: string;
  }
): Promise<SeparationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectSeparationModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const detectionSources: DetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const resolvedLanguages = publicLanguageHintsFromNative({
    domain: ModelCategory.Separation,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const vocals = readNonEmptyPath(raw.paths?.vocals);
  const accompaniment = readNonEmptyPath(raw.paths?.accompaniment);
  const model = readNonEmptyPath(raw.paths?.model);
  const paths =
    vocals != null || accompaniment != null || model != null
      ? {
          ...(vocals != null ? { vocals } : {}),
          ...(accompaniment != null ? { accompaniment } : {}),
          ...(model != null ? { model } : {}),
        }
      : undefined;
  return {
    success: raw.success,
    isStreaming: false,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(paths != null ? { paths } : {}),
  };
}

/**
 * Create an offline source-separation engine.
 *
 * @throws Error if native init fails (`Separation initialization failed: …`)
 */
export async function createSeparation(
  options: SeparationInitializeOptions
): Promise<SeparationEngine> {
  const instanceId = `separation_${++separationInstanceCounter}`;
  const bridgeOptions = await buildSeparationInitBridgeOptions(options);
  const init = await SherpaOnnx.initializeSeparation(instanceId, bridgeOptions);

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Separation initialization failed: ${nativeError}`
        : `Separation initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Separation instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    async separate(
      audioIn: OfflineAudioBufferIdSource,
      audioOuts: readonly OfflineAudioBufferIdSource[],
      separateOptions?: SeparateOptions
    ): Promise<SeparationResult> {
      guard();

      const mode = separateOptions?.segmentation?.mode ?? 'off';
      if (mode !== 'off') {
        throw new Error(
          `${SeparationErrorCode.INVALID_ARGUMENT}: segmentation mode '${mode}' is not supported yet; use mode 'off' or omit options`
        );
      }

      const startedAtMs = Date.now();
      const numStems = await SherpaOnnx.getSeparationNumStems(instanceId);
      if (audioOuts.length !== numStems) {
        throw new Error(
          `${SeparationErrorCode.INVALID_ARGUMENT}: separate() expects ${numStems} output buffers, got ${audioOuts.length}`
        );
      }

      // Resolve ids early so invalid buffer refs fail before native call.
      resolvePipelineAudioBufferId(audioIn);
      for (const out of audioOuts) {
        resolvePipelineAudioBufferId(out);
      }

      await runOfflineSeparationDirect(instanceId, audioIn, audioOuts);

      return {
        status: 'complete',
        totalSegments: 1,
        completedSegments: 1,
        skippedSegments: [],
        processingTimeMs: Date.now() - startedAtMs,
      };
    },
    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getSeparationSampleRate(instanceId);
    },
    async getNumStems(): Promise<number> {
      guard();
      return SherpaOnnx.getSeparationNumStems(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadSeparation(instanceId);
    },
  };
}

export type {
  SeparationModelType,
  SeparationConcreteModelType,
  SeparationInitOptionsShared,
  SeparationAutoInitializeOptions,
  SeparationCustomInitializeOptions,
  SeparationInitializeOptions,
  SeparateSegmentationConfig,
  SeparateOptions,
  SeparationResult,
  SeparationStemIndex,
  SeparationEngineInfo,
  SeparationEngine,
  SeparationDetectResult,
  SeparationDetectModelResult,
} from './types';
export { SEPARATION_MODEL_TYPES, SEPARATION_STEM_LABELS } from './types';

export {
  assertSeparationCustomConfig,
  resolveSeparationCustomConfigPaths,
  resolveSpleeterCustomConfigPaths,
  resolveUvrCustomConfigPaths,
  SeparationErrorCode,
  type SpleeterCustomConfig,
  type UvrCustomConfig,
  type SpleeterCustomPathKey,
  type UvrCustomPathKey,
} from './customConfig';
