import type { FileSource } from '../fileio/types';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import type { OcrInitBridgeOptions } from '../NativeSherpaOnnx';
import { OcrErrorCode } from './types';
import type {
  OcrDocVlmOptions,
  OcrDoctrOptions,
  OcrInitializeOptions,
  OcrModelType,
  OcrPpocrOptions,
} from './types';

export type { OcrInitBridgeOptions };

type OcrInitShared = {
  modelSource: FileSource;
  provider?: string;
  numThreads?: number;
};

type OcrInitBags = OcrInitShared & {
  modelType?: OcrModelType | string;
  ppocr?: OcrPpocrOptions;
  doctr?: OcrDoctrOptions;
  docVlm?: OcrDocVlmOptions;
};

const OCR_MODEL_TYPE_ALIASES: Readonly<Record<string, OcrModelType>> = {
  'docvlm': 'doc_vlm',
  'doc-vlm': 'doc_vlm',
  'granite-docling': 'doc_vlm',
  'docling': 'doc_vlm',
};

function canonicalOcrModelType(raw: string): string {
  return OCR_MODEL_TYPE_ALIASES[raw] ?? raw;
}

export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  const bags = options as OcrInitBags;
  const modelDir = await resolveFileSourceForModelInit(bags.modelSource);
  const modelType = canonicalOcrModelType(bags.modelType ?? 'auto');
  const maxNewTokens = bags.docVlm?.maxNewTokens;
  if (maxNewTokens !== undefined) {
    if (!Number.isInteger(maxNewTokens) || maxNewTokens < 0) {
      throw Object.assign(
        new Error('docVlm.maxNewTokens must be an integer >= 0'),
        { code: OcrErrorCode.INVALID_ARGUMENT }
      );
    }
  }
  return {
    modelDir,
    modelType,
    ...(bags.numThreads !== undefined ? { numThreads: bags.numThreads } : {}),
    ...(bags.provider !== undefined ? { provider: bags.provider } : {}),
    ...(bags.ppocr?.maxSideLen !== undefined
      ? { maxSideLen: bags.ppocr.maxSideLen }
      : {}),
    ...(bags.ppocr?.useOrientationCls !== undefined
      ? { useOrientationCls: bags.ppocr.useOrientationCls }
      : {}),
    ...(bags.doctr?.detBoxThresh !== undefined
      ? { detBoxThresh: bags.doctr.detBoxThresh }
      : {}),
    ...(bags.doctr?.detBoxScoreThresh !== undefined
      ? { detBoxScoreThresh: bags.doctr.detBoxScoreThresh }
      : {}),
    ...(bags.doctr?.detUnclipRatio !== undefined
      ? { detUnclipRatio: bags.doctr.detUnclipRatio }
      : {}),
    ...(maxNewTokens !== undefined ? { maxNewTokens } : {}),
  };
}
