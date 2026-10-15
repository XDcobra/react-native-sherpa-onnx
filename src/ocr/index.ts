/**
 * Offline OCR — public API for react-native-sherpa-onnx/ocr.
 *
 * ImageBuffer → TextBuffer (+ TextSpatialSpans). v1 backend: ppocr.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  readDetectedModels,
  readDetectionSources,
} from '../detect/detectModelOutput';
import type { FileSource } from '../fileio/types';
import { resolveOfflineImageBufferId } from '../imagebuffer';
import { resolveOfflineTextBufferId } from '../textbuffer';
import { ModelCategory, type SizeTier } from '../download/types';
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
  OcrEngine,
  OcrGranularity,
  OcrInitializeOptions,
  OcrModelType,
  OcrProgressNativeEvent,
  OcrRecognizeOptions,
} from './types';
import { OcrErrorCode } from './types';

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
  };
  cleanup: () => void;
} {
  const operationId = `ocr_rec_${Date.now()}_${++opIdCounter}`;
  const nativeOptions: {
    frames?: number[];
    granularity?: OcrGranularity;
    operationId: string;
  } = { operationId };

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

/**
 * Family-aware OCR pack detect (ppocr Det+Rec+dict co-occurrence).
 * Accepts a {@link FileSource} like alignment/punctuation detect.
 */
export async function detectOcrModel(
  source: FileSource,
  options?: { modelType?: OcrModelType }
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
    options?.modelType ?? null
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

  const paths =
    det || rec || cls || recDict || manifest
      ? {
          ...(det ? { det } : {}),
          ...(rec ? { rec } : {}),
          ...(cls ? { cls } : {}),
          ...(recDict ? { rec_dict: recDict } : {}),
          ...(manifest ? { manifest } : {}),
        }
      : undefined;

  // Family-aware completeness: ppocr needs det+rec+rec_dict; doctr needs det+rec+manifest.
  const family = typeof raw.modelType === 'string' ? raw.modelType : '';
  let pathsComplete: boolean;
  if (family === 'doctr') {
    pathsComplete = Boolean(det && rec && manifest);
  } else {
    // ppocr or unknown — original contract
    pathsComplete = Boolean(det && rec && recDict);
  }
  const success = successFlag && pathsComplete;

  return {
    success,
    isStreaming: false,
    detectedModels,
    ...(err.length > 0 || (successFlag && !pathsComplete)
      ? {
          error:
            err.length > 0
              ? err
              : family === 'doctr'
              ? 'OCR detect reported success but required paths (det/rec/manifest) were missing'
              : 'OCR detect reported success but required paths (det/rec/rec_dict) were missing',
        }
      : {}),
    ...(modelType != null ? { modelType } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(sizeTier != null ? { sizeTier } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(paths != null ? { paths } : {}),
  };
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
      `[SherpaOnnx:ocr] createOCR instance=${instanceId} type=${bridge.modelType} dir=${bridge.modelDir}`
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
        await getNative().ocrRecognize(
          instanceId,
          imageId,
          textId,
          nativeOptions
        );
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
  OcrPpocrOptions,
  OcrDoctrOptions,
  OcrInitializeOptions,
  OcrRecognizeOptions,
  OcrDetectResult,
  OcrEngine,
  OcrErrorCodeValue,
} from './types';

export type {
  OcrDetectModelResult,
  OcrPpocrSuccessPaths,
  OcrDoctrSuccessPaths,
} from '../types/modelDetect';

export {
  OcrErrorCode,
  isOcrPpocrDetectSuccess,
  isOcrDoctrDetectSuccess,
  OCR_MODEL_TYPES,
  isOcrModelType,
} from './types';
