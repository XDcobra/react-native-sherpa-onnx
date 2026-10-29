import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import type { OcrInitBridgeOptions } from '../NativeSherpaOnnx';
import { resolveOcrCustomConfigPaths } from './customConfig';
import { OcrErrorCode } from './types';
import type {
  OcrCustomInitializeOptions,
  OcrDoctrOptions,
  OcrInitializeOptions,
  OcrModelType,
  OcrPaddleocrVlOptions,
  OcrPaddleocrVlTask,
  OcrPpocrOptions,
} from './types';

export type { OcrInitBridgeOptions };

const OCR_MODEL_TYPE_ALIASES: Readonly<Record<string, OcrModelType>> = {
  'docvlm': 'doc_vlm',
  'doc-vlm': 'doc_vlm',
  'granite-docling': 'doc_vlm',
  'docling': 'doc_vlm',
  'nemotron-parse': 'nemotron_parse',
  'paddleocr-vl': 'paddleocr_vl',
};

function canonicalOcrModelType(raw: string): string {
  return OCR_MODEL_TYPE_ALIASES[raw] ?? raw;
}

function invalidOcrArg(message: string): never {
  throw Object.assign(new Error(message), {
    code: OcrErrorCode.INVALID_ARGUMENT,
  });
}

function appendOcrScalarBridgeFields(
  modelType: string,
  options: {
    provider?: string;
    numThreads?: number;
    maxNewTokens?: number;
    ppocr?: OcrPpocrOptions;
    doctr?: OcrDoctrOptions;
    paddleocrVl?: OcrPaddleocrVlOptions;
  }
): Omit<
  OcrInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  const maxNewTokens = options.maxNewTokens;
  if (maxNewTokens !== undefined) {
    if (!Number.isInteger(maxNewTokens) || maxNewTokens < 0) {
      invalidOcrArg('maxNewTokens must be an integer >= 0');
    }
    if (modelType === 'ppocr' || modelType === 'doctr') {
      invalidOcrArg('maxNewTokens is only valid for VLM OCR families');
    }
  }
  const maxPixels = options.paddleocrVl?.maxPixels;
  if (maxPixels !== undefined) {
    if (!Number.isInteger(maxPixels) || maxPixels < 0) {
      invalidOcrArg('paddleocrVl.maxPixels must be an integer >= 0');
    }
    if (modelType !== 'paddleocr_vl' && modelType !== 'auto') {
      invalidOcrArg('paddleocrVl.maxPixels is only valid for paddleocr_vl');
    }
  }
  const task = options.paddleocrVl?.task;
  if (task !== undefined) {
    assertOcrPaddleocrVlTask(task);
    if (modelType !== 'paddleocr_vl' && modelType !== 'auto') {
      invalidOcrArg('paddleocrVl.task is only valid for paddleocr_vl');
    }
  }
  const detUnclipRatio =
    options.ppocr?.detUnclipRatio ?? options.doctr?.detUnclipRatio;

  return {
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.ppocr?.maxSideLen !== undefined
      ? { maxSideLen: options.ppocr.maxSideLen }
      : {}),
    ...(options.ppocr?.useOrientationCls !== undefined
      ? { useOrientationCls: options.ppocr.useOrientationCls }
      : {}),
    ...(options.doctr?.detBoxThresh !== undefined
      ? { detBoxThresh: options.doctr.detBoxThresh }
      : {}),
    ...(options.doctr?.detBoxScoreThresh !== undefined
      ? { detBoxScoreThresh: options.doctr.detBoxScoreThresh }
      : {}),
    ...(detUnclipRatio !== undefined ? { detUnclipRatio } : {}),
    ...(maxNewTokens !== undefined ? { maxNewTokens } : {}),
    ...(maxPixels !== undefined ? { maxPixels } : {}),
    ...(task !== undefined ? { paddleocrVlTask: task } : {}),
  };
}

export function assertOcrPaddleocrVlTask(
  task: string
): asserts task is OcrPaddleocrVlTask {
  if (task !== 'ocr' && task !== 'spotting') {
    invalidOcrArg("paddleocrVl.task must be 'ocr' or 'spotting'");
  }
}

export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  if (options.initMode === 'custom') {
    const customOptions = options as OcrCustomInitializeOptions;
    const modelType = canonicalOcrModelType(
      customOptions.modelType
    ) as OcrCustomInitializeOptions['modelType'];
    const scalarFields = appendOcrScalarBridgeFields(modelType, customOptions);
    const modelPaths = await resolveOcrCustomConfigPaths(
      modelType,
      customOptions.customConfig
    );
    return {
      initMode: 'custom',
      modelType,
      modelPaths,
      ...scalarFields,
    };
  }

  const modelType = canonicalOcrModelType(options.modelType ?? 'auto');
  const scalarFields = appendOcrScalarBridgeFields(modelType, options);
  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType,
    ...scalarFields,
    ...(options.quantization !== undefined
      ? { quantization: options.quantization }
      : {}),
  };
}
