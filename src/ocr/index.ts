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
import { resolveOfflineImageBufferId } from '../imagebuffer';
import { resolveOfflineTextBufferId } from '../textbuffer';
import { buildOcrInitBridgeOptions } from './ocrNativeBridge';
import type {
  OcrDetectResult,
  OcrEngine,
  OcrInitializeOptions,
  OcrProgress,
  OcrRecognizeOptions,
} from './types';
import { OcrErrorCode } from './types';

type NativeSubscription = { remove: () => void };

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

let ocrInstanceCounter = 0;
let opIdCounter = 0;

function cancelledError(): Error {
  const err = new Error('OCR recognize cancelled') as Error & {
    code?: string;
  };
  err.code = OcrErrorCode.CANCELLED;
  return err;
}

function beginRecognizeProgressCancel(options?: OcrRecognizeOptions): {
  nativeOptions: {
    frames?: number[];
    granularity?: string;
    operationId: string;
  };
  cleanup: () => void;
} {
  const operationId = `ocr_rec_${Date.now()}_${++opIdCounter}`;
  const nativeOptions: {
    frames?: number[];
    granularity?: string;
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
    const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
    const onProgress = options.onProgress;
    progressSubscription = emitter.addListener(
      'SherpaOnnxOcrProgress',
      (event: any) => {
        if (event?.operationId === operationId) {
          const progress: OcrProgress = {
            done: event.done,
            total: event.total,
            phase: event.phase,
          };
          onProgress(progress);
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

/**
 * Lightweight OCR pack layout detect (ppocr files).
 * Does not download models — pass a resolved local model directory.
 */
export async function detectOcrModel(
  modelDir: string
): Promise<OcrDetectResult> {
  const raw = await getNative().detectOcrModel(modelDir);
  const filesRaw = (raw.files ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(raw.ok),
    modelType: raw.modelType || '',
    family: raw.family || '',
    files: {
      det: Boolean(filesRaw.det ?? raw.hasDet),
      rec: Boolean(filesRaw.rec ?? raw.hasRec),
      cls: Boolean(filesRaw.cls ?? raw.hasCls),
      recInferenceYml: Boolean(filesRaw.recInferenceYml ?? raw.hasRecYml),
    },
    ...(raw.errorCode ? { errorCode: raw.errorCode } : {}),
    ...(raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
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
      const imageId = resolveOfflineImageBufferId(imageBuffer as any);
      const textId = resolveOfflineTextBufferId(textOut as any);
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
  OcrGranularity,
  OcrProgress,
  OcrPpocrOptions,
  OcrInitializeOptions,
  OcrRecognizeOptions,
  OcrDetectResult,
  OcrEngine,
  OcrErrorCodeValue,
} from './types';

export { OcrErrorCode } from './types';
