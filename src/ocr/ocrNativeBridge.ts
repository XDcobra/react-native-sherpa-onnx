import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import type { OcrInitBridgeOptions } from '../NativeSherpaOnnx';
import { resolveOcrCustomConfigPaths } from './customConfig';
import { OcrErrorCode } from './types';
import type {
  OcrCustomInitializeOptions,
  OcrDocVlmOptions,
  OcrDoctrOptions,
  OcrInitializeOptions,
  OcrModelType,
  OcrPpocrOptions,
} from './types';

export type { OcrInitBridgeOptions };

const OCR_MODEL_TYPE_ALIASES: Readonly<Record<string, OcrModelType>> = {
  'docvlm': 'doc_vlm',
  'doc-vlm': 'doc_vlm',
  'granite-docling': 'doc_vlm',
  'docling': 'doc_vlm',
  'nemotron-parse': 'nemotron_parse',
};

function canonicalOcrModelType(raw: string): string {
  return OCR_MODEL_TYPE_ALIASES[raw] ?? raw;
}

function appendOcrScalarBridgeFields(options: {
  provider?: string;
  numThreads?: number;
  maxNewTokens?: number;
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  docVlm?: OcrDocVlmOptions;
}): Omit<
  OcrInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  const maxNewTokens = options.maxNewTokens ?? options.docVlm?.maxNewTokens;
  if (maxNewTokens !== undefined) {
    if (!Number.isInteger(maxNewTokens) || maxNewTokens < 0) {
      throw Object.assign(new Error('maxNewTokens must be an integer >= 0'), {
        code: OcrErrorCode.INVALID_ARGUMENT,
      });
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
  };
}

export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  const scalarFields = appendOcrScalarBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as OcrCustomInitializeOptions;
    const modelType = canonicalOcrModelType(
      customOptions.modelType
    ) as OcrCustomInitializeOptions['modelType'];
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

  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: canonicalOcrModelType(options.modelType ?? 'auto'),
    ...scalarFields,
    ...(options.quantization !== undefined
      ? { quantization: options.quantization }
      : {}),
  };
}
