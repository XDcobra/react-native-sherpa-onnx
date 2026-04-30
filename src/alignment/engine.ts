import type { ModelPathConfig } from '../types';
import { runAlignTextToAudio } from './alignTextToAudio';
import { runLinker } from './linker/linker';
import type {
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignTextToAudioWriteResult,
  AlignmentErrorCode,
} from './types';

type AlignmentEngineError = Error & { code: AlignmentErrorCode };

const MODES = new Set(['proportional', 'estimated', 'accurate', 'vad']);
const GRANULARITIES = new Set(['sentence', 'word', 'character']);

function createAlignmentError(
  code: AlignmentErrorCode,
  message: string
): AlignmentEngineError {
  const error = new Error(`${code}: ${message}`) as AlignmentEngineError;
  error.code = code;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}

function isModelPathConfig(value: unknown): value is ModelPathConfig {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  const path = value.path;
  if (type !== 'asset' && type !== 'file' && type !== 'auto') {
    return false;
  }
  return typeof path === 'string' && path.trim().length > 0;
}

function validateGranularity(
  mode: string,
  granularity: unknown
): asserts granularity is AlignTextToAudioOptions['granularity'] {
  if (granularity == null) {
    return;
  }
  if (typeof granularity !== 'string' || !GRANULARITIES.has(granularity)) {
    throw createAlignmentError(
      'ALIGNMENT_GRANULARITY_INVALID',
      `Unsupported granularity: ${String(granularity)}`
    );
  }
  if (granularity === 'character' && mode !== 'accurate') {
    throw createAlignmentError(
      'ALIGNMENT_GRANULARITY_INVALID',
      "Character granularity is only supported for mode='accurate'."
    );
  }
}

function validateAccurateOptions(options: Record<string, unknown>): void {
  if (!isModelPathConfig(options.modelPath)) {
    throw createAlignmentError(
      'ALIGNMENT_MODEL_PATH_INVALID',
      'Accurate mode requires modelPath: ModelPathConfig (asset|file|auto).'
    );
  }

  const segmentation = options.segmentation;
  if (segmentation == null) {
    return;
  }
  if (!isRecord(segmentation)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'options.segmentation must be an object when provided.'
    );
  }

  if (segmentation.mode === 'off') {
    return;
  }
  if (segmentation.mode !== 'auto') {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'accurate segmentation mode must be either off or auto.'
    );
  }

  const granularity = options.granularity;
  if (granularity === 'character') {
    throw createAlignmentError(
      'ALIGNMENT_GRANULARITY_INVALID',
      'Character granularity is not supported when accurate segmentation mode is auto.'
    );
  }

  if (segmentation.anchorSegmentBuffer == null) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'accurate segmentation mode=auto requires segmentation.anchorSegmentBuffer.'
    );
  }

  if (segmentation.mappingStrategy === 'asr_mediated') {
    const asr = segmentation.asr;
    if (!isRecord(asr) || asr.hypothesisTextBuffer == null) {
      throw createAlignmentError(
        'ALIGNMENT_ASR_HYPOTHESIS_MISSING',
        'mappingStrategy=asr_mediated requires segmentation.asr.hypothesisTextBuffer.'
      );
    }
    return;
  }

  if (segmentation.mappingStrategy === 'chunked_forced_ctc') {
    if (segmentation.asr != null) {
      throw createAlignmentError(
        'ALIGNMENT_OPTIONS_INVALID',
        'mappingStrategy=chunked_forced_ctc does not accept segmentation.asr.'
      );
    }
    return;
  }

  throw createAlignmentError(
    'ALIGNMENT_OPTIONS_INVALID',
    'segmentation.mappingStrategy must be asr_mediated or chunked_forced_ctc.'
  );
}

function validateEstimatedOptions(options: Record<string, unknown>): void {
  if (!isRecord(options.chunks)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'mode=estimated requires options.chunks.'
    );
  }
  if (!Array.isArray(options.chunks.segmentSampleCounts)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'mode=estimated requires chunks.segmentSampleCounts[].'
    );
  }
}

function validateVadOptions(options: Record<string, unknown>): void {
  const segmentation = options.segmentation;
  if (!isRecord(segmentation)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'mode=vad requires options.segmentation.'
    );
  }
  if (segmentation.source !== 'vad' || segmentation.segmentBuffer == null) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'mode=vad requires segmentation.source="vad" and segmentation.segmentBuffer.'
    );
  }
}

function validateAlignTextToAudioOptions(
  options: unknown
): asserts options is AlignTextToAudioOptions {
  if (!isRecord(options)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      'options must be an object.'
    );
  }

  const mode = options.mode;
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw createAlignmentError(
      'ALIGNMENT_OPTIONS_INVALID',
      `Unsupported alignment mode: ${String(mode)}`
    );
  }

  validateGranularity(mode, options.granularity);

  if (mode === 'proportional') {
    if (options.segmentation != null) {
      throw createAlignmentError(
        'ALIGNMENT_OPTIONS_INVALID',
        'mode=proportional does not accept segmentation.'
      );
    }
    return;
  }

  if (mode === 'estimated') {
    if (options.segmentation != null) {
      throw createAlignmentError(
        'ALIGNMENT_OPTIONS_INVALID',
        'mode=estimated does not accept segmentation.'
      );
    }
    validateEstimatedOptions(options);
    return;
  }

  if (mode === 'accurate') {
    validateAccurateOptions(options);
    return;
  }

  if (mode === 'vad') {
    if (options.granularity === 'character') {
      throw createAlignmentError(
        'ALIGNMENT_GRANULARITY_INVALID',
        'mode=vad supports sentence or word granularity only.'
      );
    }
    validateVadOptions(options);
  }
}

export interface AlignmentEngineOptions {
  // Reserved for future engine-level defaults and hooks.
}

export interface AlignmentEngine {
  alignTextToAudio: AlignTextToAudioFn;
  destroy(): Promise<void>;
}

export function createAlignment(
  _options?: AlignmentEngineOptions
): AlignmentEngine {
  let destroyed = false;

  const guardNotDestroyed = () => {
    if (destroyed) {
      throw createAlignmentError(
        'ALIGNMENT_ENGINE_DESTROYED',
        'AlignmentEngine has been destroyed and cannot be reused.'
      );
    }
  };

  return {
    async alignTextToAudio(
      textIn,
      audioIn,
      segmentOut,
      options
    ): Promise<AlignTextToAudioWriteResult> {
      guardNotDestroyed();
      validateAlignTextToAudioOptions(options);

      if (
        options.mode === 'accurate' &&
        options.segmentation?.mode === 'auto'
      ) {
        if (options.segmentation.mappingStrategy === 'asr_mediated') {
          await runLinker({
            audioIn,
            anchors: options.segmentation.anchorSegmentBuffer,
            referenceText: textIn,
            hypothesisTextBuffer: options.segmentation.asr.hypothesisTextBuffer,
            granularity: options.granularity === 'word' ? 'word' : 'token',
            ...(typeof options.language === 'string'
              ? { language: options.language }
              : {}),
          });
        }

        throw createAlignmentError(
          'ALIGNMENT_NOT_IMPLEMENTED',
          'accurate segmentation strategies are reserved for sub-03/sub-04.'
        );
      }

      return runAlignTextToAudio(textIn, audioIn, segmentOut, options);
    },
    async destroy(): Promise<void> {
      destroyed = true;
    },
  };
}
