/**
 * Speaker Diarization feature module
 *
 * Detect for segmentation packs (pyannote / reverb) is available.
 * Inference / createDiarization remains Phase 2 (placeholder stubs below).
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import { isDetectionSource } from './types';
import type {
  DetectedModelEntry,
  DetectionSource,
  DiarizationDetectResult,
  DiarizationModelKind,
} from './types';

export type {
  DetectedModelEntry,
  DetectionSource,
  DiarizationDetectResult,
  DiarizationModelKind,
} from './types';
export {
  DETECTION_SOURCES,
  DIARIZATION_MODEL_KINDS,
  isDetectionSource,
} from './types';

/**
 * Diarization initialization options (placeholder until inference ships).
 */
export interface DiarizationInitializeOptions {
  modelSource: FileSource;
}

/**
 * Speaker segment with speaker ID (placeholder until buffer-first API ships).
 */
export interface SpeakerSegment {
  speakerId: string;
  start: number;
  end: number;
}

export async function detectDiarizationModel(
  source: FileSource,
  options?: {
    modelType?: DiarizationModelKind | 'auto';
    assetName?: string;
  }
): Promise<DiarizationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectDiarizationModel(
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
    domain: ModelCategory.Diarization,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelFilePath =
    typeof raw.paths?.model === 'string' ? raw.paths.model.trim() : '';
  const isStreaming = raw.isStreaming === true;
  return {
    success: raw.success,
    isStreaming,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(modelFilePath.length > 0 ? { paths: { model: modelFilePath } } : {}),
  };
}

/**
 * Initialize Speaker Diarization with model directory.
 *
 * @throws {Error} Not yet implemented
 */
export async function initializeDiarization(
  _options: DiarizationInitializeOptions
): Promise<void> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Perform speaker diarization on an audio file.
 *
 * @throws {Error} Not yet implemented
 */
export function diarizeAudio(_filePath: string): Promise<SpeakerSegment[]> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}

/**
 * Release diarization resources.
 *
 * @throws {Error} Not yet implemented
 */
export function unloadDiarization(): Promise<void> {
  throw new Error(
    'Speaker Diarization feature is not yet implemented. This is a placeholder module.'
  );
}
