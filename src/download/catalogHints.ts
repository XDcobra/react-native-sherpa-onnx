import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePublicLanguageHints } from '../model-languages';
import type { CatalogDetectCategory } from './catalogDetectCategories';
export {
  categoryUsesCatalogDetect,
  type CatalogDetectCategory,
} from './catalogDetectCategories';
import { ModelCategory, type Quantization, type SizeTier } from './types';

/** Name-only detect output merged into {@link ModelMeta} at registry refresh. */
export type CatalogDetectHint = {
  modelType: string;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  isStreaming: boolean;
  isHardwareSpecificUnsupported?: boolean;
};

function normalizeQuantization(raw: string | undefined): Quantization {
  if (raw === 'fp16' || raw === 'int8' || raw === 'int8-quantized') {
    return raw;
  }
  return 'unknown';
}

function normalizeSizeTier(raw: string | undefined): SizeTier {
  if (
    raw === 'tiny' ||
    raw === 'small' ||
    raw === 'medium' ||
    raw === 'large'
  ) {
    return raw;
  }
  return 'unknown';
}

function normalizeModelType(raw: string | undefined): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return 'unknown';
}

function languagesFromNative(
  domain: ModelCategory,
  modelType: string,
  rawLangs: string[]
): string[] {
  const rows = resolvePublicLanguageHints({
    domain,
    modelType: modelType !== 'unknown' ? modelType : undefined,
    rawFromNative: rawLangs,
  });
  return rows.map((r) => r.iso6391Hint);
}

function readRawLanguages(raw: { languages?: unknown }): string[] {
  if (!Array.isArray(raw.languages)) {
    return [];
  }
  return raw.languages.filter((x): x is string => typeof x === 'string');
}

function hintFromRaw(
  domain: ModelCategory,
  raw: {
    modelType?: string;
    languages?: unknown;
    quantization?: string;
    sizeTier?: string;
    isStreaming?: boolean;
    isHardwareSpecificUnsupported?: boolean;
  },
  options?: { defaultIsStreaming?: boolean }
): CatalogDetectHint {
  const modelType = normalizeModelType(raw.modelType);
  return {
    modelType,
    languages: languagesFromNative(domain, modelType, readRawLanguages(raw)),
    quantization: normalizeQuantization(raw.quantization),
    sizeTier: normalizeSizeTier(raw.sizeTier),
    isStreaming:
      raw.isStreaming === true || options?.defaultIsStreaming === true,
    ...(raw.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
  };
}

async function detectTtsCatalogHint(id: string): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectTtsModel('', id, 'auto');
  return hintFromRaw(ModelCategory.Tts, raw, { defaultIsStreaming: true });
}

async function detectSttCatalogHint(id: string): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectSttModel(
    '',
    id,
    'auto',
    undefined,
    undefined
  );
  return hintFromRaw(ModelCategory.Stt, raw);
}

async function detectVadCatalogHint(id: string): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectVadModel('', id, 'auto');
  return hintFromRaw(ModelCategory.Vad, raw);
}

async function detectPunctuationCatalogHint(
  id: string
): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectPunctuationModel('', id, 'auto');
  return hintFromRaw(ModelCategory.Punctuation, raw);
}

async function detectEnhancementCatalogHint(
  id: string
): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectEnhancementModel('', id, 'auto');
  return hintFromRaw(ModelCategory.Enhancement, raw);
}

async function detectAlignmentCatalogHint(
  id: string
): Promise<CatalogDetectHint> {
  const raw = await SherpaOnnx.detectAlignmentModel(id, 'auto');
  return hintFromRaw(ModelCategory.Alignment, raw);
}

async function detectCatalogHintForCategory(
  category: CatalogDetectCategory,
  id: string
): Promise<CatalogDetectHint> {
  switch (category) {
    case ModelCategory.Tts:
      return detectTtsCatalogHint(id);
    case ModelCategory.Stt:
    case ModelCategory.Qnn:
      return detectSttCatalogHint(id);
    case ModelCategory.Vad:
      return detectVadCatalogHint(id);
    case ModelCategory.Punctuation:
      return detectPunctuationCatalogHint(id);
    case ModelCategory.Enhancement:
      return detectEnhancementCatalogHint(id);
    case ModelCategory.Alignment:
      return detectAlignmentCatalogHint(id);
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

/**
 * Name-only native detect for every catalog id (no extracted file tree).
 * STT and QNN share {@link detectSttCatalogHint}; QNN entries set `supportsQnn` when building meta.
 */
export async function buildCatalogHintsMap(
  category: CatalogDetectCategory,
  ids: string[]
): Promise<Map<string, CatalogDetectHint>> {
  const map = new Map<string, CatalogDetectHint>();
  for (const id of ids) {
    map.set(id, await detectCatalogHintForCategory(category, id));
  }
  return map;
}
