/**
 * Offline OCR — public API for react-native-sherpa-onnx/ocr.
 *
 * ImageBuffer → TextBuffer (+ TextSpatialSpans). Backends: ppocr, doctr,
 * doc_vlm, nemotron_parse.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { OcrRecognizeNativeResult, Spec } from '../NativeSherpaOnnx';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  readDetectedModels,
  readDetectionSources,
} from '../detect/detectModelOutput';
import type { FileSource } from '../fileio/types';
import { resolveOfflineImageBufferId } from '../imagebuffer';
import { resolveOfflineTextBufferId } from '../textbuffer';
import {
  ModelCategory,
  type QuantizationPreference,
  type SizeTier,
} from '../download/types';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import {
  normalizeQuantization,
  type DetectedModelEntry,
  type OcrDetectModelResult,
} from '../types/modelDetect';
import { buildOcrInitBridgeOptions } from './ocrNativeBridge';
import type {
  OcrDocVlmStopReason,
  OcrEngine,
  OcrGranularity,
  OcrInitializeOptions,
  OcrModelType,
  OcrProgressNativeEvent,
  OcrRecognizeOptions,
  OcrRecognizeResult,
} from './types';
import { OCR_PROGRESS_MIN_INTERVAL_MS, OcrErrorCode } from './types';

type NativeSubscription = { remove: () => void };

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

let ocrInstanceCounter = 0;
let opIdCounter = 0;

function cancelledError(): Error & { code: typeof OcrErrorCode.CANCELLED } {
  const err = new Error('OCR recognize cancelled') as Error & {
    code: typeof OcrErrorCode.CANCELLED;
  };
  err.code = OcrErrorCode.CANCELLED;
  return err;
}

function normalizeSizeTier(raw: string | undefined): SizeTier | undefined {
  if (
    raw === 'tiny' ||
    raw === 'small' ||
    raw === 'medium' ||
    raw === 'large' ||
    raw === 'unknown'
  ) {
    return raw;
  }
  return undefined;
}

function beginRecognizeProgressCancel(options?: OcrRecognizeOptions): {
  nativeOptions: {
    frames?: number[];
    granularity?: OcrGranularity;
    operationId: string;
    progressMinIntervalMs: number;
  };
  cleanup: () => void;
} {
  const operationId = `ocr_rec_${Date.now()}_${++opIdCounter}`;
  const rawInterval = options?.progressMinIntervalMs;
  const progressMinIntervalMs =
    typeof rawInterval === 'number' && Number.isFinite(rawInterval)
      ? Math.max(0, Math.trunc(rawInterval))
      : OCR_PROGRESS_MIN_INTERVAL_MS;
  const nativeOptions: {
    frames?: number[];
    granularity?: OcrGranularity;
    operationId: string;
    progressMinIntervalMs: number;
  } = { operationId, progressMinIntervalMs };

  if (options?.frames !== undefined) {
    nativeOptions.frames = options.frames;
  }
  if (options?.granularity !== undefined) {
    nativeOptions.granularity = options.granularity;
  }

  let progressSubscription: NativeSubscription | null = null;
  let abortHandler: (() => void) | null = null;

  if (options?.onProgress) {
    const emitter = new NativeEventEmitter(
      NativeModules.SherpaOnnx as {
        addListener: (eventType: string) => void;
        removeListeners: (count: number) => void;
      }
    );
    const onProgress = options.onProgress;
    progressSubscription = emitter.addListener(
      'SherpaOnnxOcrProgress',
      (...args: readonly Object[]) => {
        const event = args[0] as OcrProgressNativeEvent;
        if (event?.operationId === operationId) {
          onProgress({
            done: event.done,
            total: event.total,
            phase: event.phase,
            frameIndex: event.frameIndex ?? 0,
            frameCount: event.frameCount ?? 1,
          });
        }
      }
    );
  }

  if (options?.signal) {
    if (options.signal.aborted) {
      progressSubscription?.remove();
      throw cancelledError();
    }
    abortHandler = () => {
      getNative()
        .cancelOcrRecognize(operationId)
        .catch(() => {});
    };
    options.signal.addEventListener('abort', abortHandler);
  }

  return {
    nativeOptions,
    cleanup: () => {
      progressSubscription?.remove();
      if (abortHandler && options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    },
  };
}

function pathFromRaw(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/** Detect OCR pack layout without loading the engine. */
export async function detectOcrModel(
  source: FileSource,
  options?: { modelType?: OcrModelType; quantization?: QuantizationPreference }
): Promise<OcrDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const modelDir = resolved.modelDir;
  if (!modelDir) {
    return {
      success: false,
      isStreaming: false,
      detectedModels: [],
      error: 'OCR: model directory could not be resolved from FileSource',
    };
  }

  const raw = await getNative().detectOcrModel(
    modelDir,
    options?.modelType ?? null,
    options?.quantization ?? null
  );

  const successFlag = Boolean(raw.success ?? raw.ok);
  const err =
    typeof raw.error === 'string' && raw.error.trim().length > 0
      ? raw.error.trim()
      : typeof raw.errorMessage === 'string' &&
        raw.errorMessage.trim().length > 0
      ? raw.errorMessage.trim()
      : '';

  let detectedModels: DetectedModelEntry[] = readDetectedModels(
    raw.detectedModels
  );
  const modelType =
    typeof raw.modelType === 'string' && raw.modelType.length > 0
      ? raw.modelType
      : undefined;
  if (detectedModels.length === 0 && modelType) {
    detectedModels = [{ type: modelType, modelDir }];
  }

  const detectionSources = readDetectionSources(raw.detectionSources);
  const quantization = normalizeQuantization(raw.quantization);
  const sizeTier = normalizeSizeTier(
    typeof raw.sizeTier === 'string' ? raw.sizeTier : undefined
  );
  const resolvedLanguages = publicLanguageHintsFromNative({
    domain: ModelCategory.Ocr,
    modelType,
    modelKey: modelDir,
    rawRows: readPublicLanguageRows(raw.languages),
  });

  const pathsRaw = raw.paths ?? {};
  const filesRaw = (raw.files ?? {}) as Record<string, unknown>;
  const det =
    pathFromRaw(pathsRaw.det) ??
    pathFromRaw(filesRaw.det) ??
    pathFromRaw(raw.detPath);
  const rec =
    pathFromRaw(pathsRaw.rec) ??
    pathFromRaw(filesRaw.rec) ??
    pathFromRaw(raw.recPath);
  const cls =
    pathFromRaw(pathsRaw.cls) ??
    pathFromRaw(filesRaw.cls) ??
    pathFromRaw(raw.clsPath);
  const recDict =
    pathFromRaw(pathsRaw.rec_dict) ??
    pathFromRaw(filesRaw.recInferenceYml) ??
    pathFromRaw(filesRaw.rec_dict) ??
    pathFromRaw(raw.recDictPath);
  const manifest =
    pathFromRaw(pathsRaw.manifest) ??
    pathFromRaw(filesRaw.manifest) ??
    pathFromRaw(raw.manifestPath);
  const visionEncoder =
    pathFromRaw(pathsRaw.vision_encoder) ??
    pathFromRaw(filesRaw.vision_encoder);
  const visionEncoderData =
    pathFromRaw(pathsRaw.vision_encoder_data) ??
    pathFromRaw(filesRaw.vision_encoder_data);
  const embedTokens =
    pathFromRaw(pathsRaw.embed_tokens) ?? pathFromRaw(filesRaw.embed_tokens);
  const embedTokensData =
    pathFromRaw(pathsRaw.embed_tokens_data) ??
    pathFromRaw(filesRaw.embed_tokens_data);
  const decoder =
    pathFromRaw(pathsRaw.decoder) ?? pathFromRaw(filesRaw.decoder);
  const decoderData =
    pathFromRaw(pathsRaw.decoder_data) ?? pathFromRaw(filesRaw.decoder_data);
  const tokenizer =
    pathFromRaw(pathsRaw.tokenizer) ?? pathFromRaw(filesRaw.tokenizer);
  const patchEmbed =
    pathFromRaw(pathsRaw.patch_embed) ?? pathFromRaw(filesRaw.patch_embed);
  const patchEmbedData =
    pathFromRaw(pathsRaw.patch_embed_data) ??
    pathFromRaw(filesRaw.patch_embed_data);
  const posEmbed =
    pathFromRaw(pathsRaw.pos_embed) ?? pathFromRaw(filesRaw.pos_embed);

  const paths =
    det ||
    rec ||
    cls ||
    recDict ||
    manifest ||
    visionEncoder ||
    visionEncoderData ||
    embedTokens ||
    embedTokensData ||
    decoder ||
    decoderData ||
    tokenizer ||
    patchEmbed ||
    patchEmbedData ||
    posEmbed
      ? {
          ...(det ? { det } : {}),
          ...(rec ? { rec } : {}),
          ...(cls ? { cls } : {}),
          ...(recDict ? { rec_dict: recDict } : {}),
          ...(manifest ? { manifest } : {}),
          ...(visionEncoder ? { vision_encoder: visionEncoder } : {}),
          ...(visionEncoderData
            ? { vision_encoder_data: visionEncoderData }
            : {}),
          ...(embedTokens ? { embed_tokens: embedTokens } : {}),
          ...(embedTokensData ? { embed_tokens_data: embedTokensData } : {}),
          ...(decoder ? { decoder } : {}),
          ...(decoderData ? { decoder_data: decoderData } : {}),
          ...(tokenizer ? { tokenizer } : {}),
          ...(patchEmbed ? { patch_embed: patchEmbed } : {}),
          ...(patchEmbedData ? { patch_embed_data: patchEmbedData } : {}),
          ...(posEmbed ? { pos_embed: posEmbed } : {}),
        }
      : undefined;

  return {
    success: successFlag,
    isStreaming: false,
    detectedModels,
    ...(err.length > 0 ? { error: err } : {}),
    ...(modelType != null ? { modelType } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(sizeTier != null ? { sizeTier } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(paths != null ? { paths } : {}),
  };
}

function readRecognizeResult(
  raw: OcrRecognizeNativeResult
): OcrRecognizeResult {
  const family = raw?.family;
  if (
    family !== 'ppocr' &&
    family !== 'doctr' &&
    family !== 'doc_vlm' &&
    family !== 'nemotron_parse'
  ) {
    throw Object.assign(new Error('OCR recognize result missing family'), {
      code: OcrErrorCode.INTERNAL_ERROR,
    });
  }
  if (typeof raw.spanCount !== 'number' || !Number.isFinite(raw.spanCount)) {
    throw Object.assign(new Error('OCR recognize result missing spanCount'), {
      code: OcrErrorCode.INTERNAL_ERROR,
    });
  }
  if (family === 'doc_vlm' || family === 'nemotron_parse') {
    const markup = typeof raw.raw === 'string' ? raw.raw : undefined;
    if (family === 'nemotron_parse' && markup === undefined) {
      throw Object.assign(new Error('OCR recognize result missing extras'), {
        code: OcrErrorCode.INTERNAL_ERROR,
      });
    }
    const rawText =
      markup ?? (typeof raw.doctags === 'string' ? raw.doctags : undefined);
    if (typeof rawText !== 'string' || typeof raw.markdown !== 'string') {
      throw Object.assign(new Error('OCR recognize result missing extras'), {
        code: OcrErrorCode.INTERNAL_ERROR,
      });
    }
    const stopReason = raw.stopReason;
    const graniteStops =
      stopReason === 'doctag_end' ||
      stopReason === 'eos' ||
      stopReason === 'max_new_tokens' ||
      stopReason === 'invalid_sequence';
    const nemotronStops =
      stopReason === 'eos' || stopReason === 'max_new_tokens';
    if (family === 'doc_vlm' ? !graniteStops : !nemotronStops) {
      throw Object.assign(new Error('OCR recognize result missing extras'), {
        code: OcrErrorCode.INTERNAL_ERROR,
      });
    }
    if (typeof raw.complete !== 'boolean') {
      throw Object.assign(new Error('OCR recognize result missing extras'), {
        code: OcrErrorCode.INTERNAL_ERROR,
      });
    }
    if (family === 'nemotron_parse') {
      return {
        family,
        spanCount: raw.spanCount,
        raw: rawText,
        markdown: raw.markdown,
        complete: raw.complete,
        stopReason: stopReason as 'eos' | 'max_new_tokens',
      };
    }
    const doctags = typeof raw.doctags === 'string' ? raw.doctags : rawText;
    return {
      family,
      spanCount: raw.spanCount,
      raw: rawText,
      doctags,
      markdown: raw.markdown,
      complete: raw.complete,
      stopReason: stopReason as OcrDocVlmStopReason,
    };
  }
  return { family, spanCount: raw.spanCount };
}

/**
 * Create an offline OCR engine. Call `destroy()` when finished.
 */
export async function createOCR(
  options: OcrInitializeOptions
): Promise<OcrEngine> {
  const instanceId = `ocr_${++ocrInstanceCounter}`;
  const bridge = await buildOcrInitBridgeOptions(options);
  if (__DEV__) {
    console.log(
      `[SherpaOnnx:ocr] createOCR instance=${instanceId} mode=${
        bridge.initMode ?? 'auto'
      } type=${bridge.modelType} dir=${bridge.modelDir ?? '(custom paths)'}`
    );
  }
  await getNative().initializeOcr(instanceId, bridge);

  let destroyed = false;

  const engine: OcrEngine = {
    instanceId,
    async recognize(imageBuffer, textOut, recognizeOptions) {
      if (destroyed) {
        throw Object.assign(new Error('OCR engine destroyed'), {
          code: OcrErrorCode.INSTANCE_NOT_FOUND,
        });
      }
      const imageId = resolveOfflineImageBufferId(imageBuffer);
      const textId = resolveOfflineTextBufferId(textOut);
      const { nativeOptions, cleanup } =
        beginRecognizeProgressCancel(recognizeOptions);
      try {
        if (__DEV__) {
          console.log(
            `[SherpaOnnx:ocr] recognize instance=${instanceId} image=${imageId} textOut=${textId}`
          );
        }
        const raw = await getNative().ocrRecognize(
          instanceId,
          imageId,
          textId,
          nativeOptions
        );
        return readRecognizeResult(raw);
      } finally {
        cleanup();
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await getNative().unloadOcr(instanceId);
      if (__DEV__) {
        console.log(`[SherpaOnnx:ocr] destroy instance=${instanceId}`);
      }
    },
  };

  return engine;
}

export type {
  OcrModelType,
  OcrConcreteModelType,
  OcrFamily,
  OcrGranularity,
  OcrProgress,
  OcrProgressNativeEvent,
  OcrProgressPhase,
  OcrPpocrOptions,
  OcrDoctrOptions,
  OcrDocVlmOptions,
  OcrDocVlmStopReason,
  OcrInitializeOptions,
  OcrInitializeOptionsAuto,
  OcrInitializeOptionsPpocr,
  OcrInitializeOptionsDoctr,
  OcrInitializeOptionsDocVlm,
  OcrCustomInitializeOptions,
  OcrRecognizeOptions,
  OcrRecognizeResult,
  OcrDetectResult,
  OcrEngine,
  OcrErrorCodeValue,
} from './types';

export type {
  OcrCustomPathKey,
  OcrCustomConfig,
  OcrPpocrCustomConfig,
  OcrDoctrCustomConfig,
  OcrDocVlmCustomConfig,
  OcrCustomConfigByModelType,
} from './customConfig';

export {
  assertOcrCustomConfig,
  resolveOcrCustomConfigPaths,
} from './customConfig';

export type { OcrDetectModelResult } from '../types/modelDetect';

export {
  OcrErrorCode,
  OCR_MODEL_TYPES,
  OCR_PROGRESS_MIN_INTERVAL_MS,
  OCR_PROGRESS_PHASES,
  isOcrModelType,
} from './types';
