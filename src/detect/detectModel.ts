import SherpaOnnx, {
  type UnifiedDetectNativeResult,
} from '../NativeSherpaOnnx';
import {
  resolveFileSourceForDetect,
  type ResolvedDetectInput,
} from './resolveModelInput';
import type { FileSource } from '../fileio/types';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import {
  ModelCategory,
  type Quantization,
  type SizeTier,
} from '../download/types';
import type { DetectedModelEntry, DetectionSource } from '../types/modelDetect';
import {
  readDetectedModels,
  readDetectionSources,
  readNonEmptyDetectPathsMap,
  type DetectModelPathsMap,
} from './detectModelOutput';

/** Name-only or directory-backed detect input without a full {@link FileSource}. */
export type DetectModelNameInput = {
  assetName: string;
  modelDir?: string;
};

export type DetectModelInput = FileSource | DetectModelNameInput;

export type DetectModelMatchedResult = {
  matched: true;
  category: ModelCategory;
  modelType: string;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  isStreaming: boolean;
  isHardwareSpecificUnsupported?: boolean;
  /** Set when an STT hit also matches the QNN release naming convention. */
  supportsQnn?: boolean;
  /** Non-empty resolved path keys from native detection (folder scans). */
  paths?: DetectModelPathsMap;
  detectionSources?: readonly DetectionSource[];
  detectedModels?: readonly DetectedModelEntry[];
};

export type DetectModelResult = { matched: false } | DetectModelMatchedResult;

export type DetectModelsBatchOptions = {
  /** Parallel batch jobs (default 8). Splits inputs into chunks when less than input count. */
  concurrency?: number;
  /** Include `paths` in each matched result (default false). Single `detectModel` always includes paths when present. */
  includePaths?: boolean;
};

type ResolvedDetectModelInput = ResolvedDetectInput & {
  modelKey: string;
};

const DEFAULT_BATCH_CONCURRENCY = 8;

const CATEGORY_BY_NATIVE: Record<string, ModelCategory> = {
  tts: ModelCategory.Tts,
  stt: ModelCategory.Stt,
  vad: ModelCategory.Vad,
  punctuation: ModelCategory.Punctuation,
  enhancement: ModelCategory.Enhancement,
  separation: ModelCategory.Separation,
  speakerEmbedding: ModelCategory.SpeakerEmbedding,
  diarization: ModelCategory.Diarization,
  alignment: ModelCategory.Alignment,
};

function isDetectModelNameInput(
  input: DetectModelInput
): input is DetectModelNameInput {
  return 'assetName' in input && !('kind' in input);
}

function modelKeyFromResolved(resolved: ResolvedDetectInput): string {
  const fromAsset = resolved.assetName?.trim();
  if (fromAsset) {
    return fromAsset;
  }
  return (
    resolved.modelDir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop()
      ?.trim() ?? ''
  );
}

async function resolveDetectModelInput(
  input: DetectModelInput
): Promise<ResolvedDetectModelInput> {
  if (isDetectModelNameInput(input)) {
    const assetName = input.assetName.trim();
    const modelDir = input.modelDir?.trim() ?? '';
    return {
      modelDir,
      assetName: assetName.length > 0 ? assetName : null,
      modelKey: assetName,
    };
  }

  const resolved = await resolveFileSourceForDetect(input);
  return {
    ...resolved,
    modelKey: modelKeyFromResolved(resolved),
  };
}

/** QNN binary pack naming convention (same tokens as GitHub asset rules). */
export function isQnnModelName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('sherpa-onnx-qnn') &&
    lower.includes('binary') &&
    lower.includes('seconds')
  );
}

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

function languagesFromNative(
  domain: ModelCategory,
  modelType: string,
  modelKey: string,
  rawLanguages: unknown
): string[] {
  const rows = publicLanguageHintsFromNative({
    domain,
    modelType: modelType !== 'unknown' ? modelType : undefined,
    modelKey,
    rawRows: readPublicLanguageRows(rawLanguages),
  });
  return rows.map((r) => r.iso6391Hint);
}

function buildMatchedResult(
  category: ModelCategory,
  modelKey: string,
  raw: UnifiedDetectNativeResult,
  includePaths: boolean
): DetectModelMatchedResult {
  const modelType = (raw.modelType ?? 'unknown').trim();
  const result: DetectModelMatchedResult = {
    matched: true,
    category,
    modelType,
    languages: languagesFromNative(
      category,
      modelType,
      modelKey,
      raw.languages
    ),
    quantization: normalizeQuantization(raw.quantization),
    sizeTier: normalizeSizeTier(raw.sizeTier),
    isStreaming: raw.isStreaming === true,
  };

  if (raw.isHardwareSpecificUnsupported === true) {
    result.isHardwareSpecificUnsupported = true;
  }

  if (
    category === ModelCategory.Stt &&
    modelKey.length > 0 &&
    isQnnModelName(modelKey)
  ) {
    result.supportsQnn = true;
  }

  const detectionSources = readDetectionSources(raw.detectionSources);
  if (detectionSources.length > 0) {
    result.detectionSources = detectionSources;
  }

  const detectedModels = readDetectedModels(raw.detectedModels);
  if (detectedModels.length > 0) {
    result.detectedModels = detectedModels;
  }

  if (includePaths) {
    const paths = readNonEmptyDetectPathsMap(raw.paths);
    if (paths != null) {
      result.paths = paths;
    }
  }

  return result;
}

function omitPathsFromMatched(
  result: DetectModelMatchedResult
): DetectModelMatchedResult {
  if (result.paths == null) {
    return result;
  }
  const rest = { ...result };
  delete rest.paths;
  return rest;
}

function finalizeDetectResult(
  result: DetectModelResult,
  includePaths: boolean
): DetectModelResult {
  if (!result.matched || includePaths) {
    return result;
  }
  return omitPathsFromMatched(result);
}

function mapNativeDetectResult(
  resolved: ResolvedDetectModelInput,
  raw: UnifiedDetectNativeResult,
  includePaths: boolean
): DetectModelResult {
  if (raw.matched !== true) {
    return { matched: false };
  }

  const category = raw.category ? CATEGORY_BY_NATIVE[raw.category] : undefined;
  if (!category) {
    return { matched: false };
  }

  return buildMatchedResult(category, resolved.modelKey, raw, includePaths);
}

function toNativeDetectInput(resolved: ResolvedDetectModelInput): {
  modelDir: string;
  assetName: string | null;
} {
  return {
    modelDir: resolved.modelDir,
    assetName: resolved.assetName,
  };
}

/**
 * Detect model category and type via native unified detection (single bridge call).
 */
export async function detectModel(
  input: DetectModelInput
): Promise<DetectModelResult> {
  const resolved = await resolveDetectModelInput(input);
  if (!resolved.assetName && resolved.modelDir.trim().length === 0) {
    return { matched: false };
  }

  const raw = await SherpaOnnx.detectModel(
    resolved.modelDir,
    resolved.assetName
  );
  return mapNativeDetectResult(resolved, raw, true);
}

/** Batch wrapper around unified native detection with optional chunked parallelism. */
export async function detectModelsBatch(
  inputs: readonly DetectModelInput[],
  options?: DetectModelsBatchOptions
): Promise<DetectModelResult[]> {
  if (inputs.length === 0) {
    return [];
  }

  const concurrency = options?.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
  const includePaths = options?.includePaths === true;
  const resolvedList = await Promise.all(
    inputs.map((input) => resolveDetectModelInput(input))
  );

  const runChunk = async (
    chunk: readonly ResolvedDetectModelInput[]
  ): Promise<DetectModelResult[]> => {
    const nativeInputs = chunk.map((r) => toNativeDetectInput(r));
    const rawResults = await SherpaOnnx.detectModelsBatch(nativeInputs);
    return rawResults.map((raw, index) =>
      finalizeDetectResult(
        mapNativeDetectResult(chunk[index]!, raw, includePaths),
        includePaths
      )
    );
  };

  if (concurrency >= resolvedList.length) {
    return runChunk(resolvedList);
  }

  const chunkSize = Math.ceil(resolvedList.length / concurrency);
  const chunks: ResolvedDetectModelInput[][] = [];
  for (let i = 0; i < resolvedList.length; i += chunkSize) {
    chunks.push(resolvedList.slice(i, i + chunkSize));
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk) => runChunk(chunk))
  );
  return chunkResults.flat();
}

/** Whether a unified detect result belongs in the requested catalog category slice. */
export function detectModelResultMatchesCategory(
  category: ModelCategory,
  result: DetectModelMatchedResult
): boolean {
  if (category === ModelCategory.Qnn) {
    return result.category === ModelCategory.Stt && result.supportsQnn === true;
  }

  if (category === ModelCategory.Stt) {
    return result.category === ModelCategory.Stt && result.supportsQnn !== true;
  }

  return result.category === category;
}
