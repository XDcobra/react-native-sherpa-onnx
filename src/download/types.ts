import type { TTSModelType } from '../tts/types';

export enum ModelCategory {
  Tts = 'tts',
  Stt = 'stt',
  Vad = 'vad',
  Punctuation = 'punctuation',
  Diarization = 'diarization',
  Enhancement = 'enhancement',
  Separation = 'separation',
  Qnn = 'qnn',
  Alignment = 'alignment',
}

export type TtsModelType = TTSModelType | 'unknown';
export type Quantization = 'fp16' | 'int8' | 'int8-quantized' | 'unknown';
export type SizeTier = 'tiny' | 'small' | 'medium' | 'large' | 'unknown';
export type ModelArchiveExt = 'tar.bz2' | 'onnx';

export type ModelMeta = {
  id: string;
  displayName: string;
  downloadUrl: string;
  archiveExt: ModelArchiveExt;
  bytes: number;
  sha256?: string;
  category: ModelCategory;
  type?: TtsModelType;
  /** Normalized primary language hints (mostly ISO 639-1), not raw release-id tokens. */
  languages?: string[];
  quantization?: Quantization;
  sizeTier?: SizeTier;
};

export type ProgressPhase =
  | 'downloading'
  | 'extracting'
  /** Archive entries are being skipped to reach the resume point (same byte/percent semantics as extracting). */
  | 'extracting_resume_skipping';

export type Progress = {
  bytesProcessed: number;
  totalBytes: number;
  percent: number;
  phase: ProgressPhase;
  /** When native reports it: 0-based archive entry ordinal for this extract pass. */
  archiveEntryIndex?: number;
  speed?: number;
  eta?: number;
};

/** True for any in-progress extraction phase (unpacking or resume skip scan). */
export function isActiveExtractionPhase(
  phase: ProgressPhase
): phase is 'extracting' | 'extracting_resume_skipping' {
  return phase === 'extracting' || phase === 'extracting_resume_skipping';
}

export type EnsureModelResult = {
  modelId: string;
  localPath: string;
};

export type DownloadResult = EnsureModelResult;

export type DownloadState = {
  modelId: string;
  category: ModelCategory;
  phase: ProgressPhase;
  startedAt: string;
  archivePath: string;
  model: ModelMeta;
  bytesDownloaded?: number;
  totalBytes?: number;
};

export type ExtractionState = {
  modelId: string;
  category: ModelCategory;
  phase: 'extracting';
  startedAt: string;
  archivePath: string;
  modelDir: string;
  model: ModelMeta;
  lastEntryIndex?: number;
  lastEntryPath?: string;
};

export type DownloadProgressListener = (
  category: ModelCategory,
  modelId: string,
  progress: Progress
) => void;

export type ModelsListUpdatedListener = (
  category: ModelCategory,
  models: ModelMeta[]
) => void;

export type ModelManifest = {
  downloadedAt: string;
  lastUsed?: string;
  model: ModelMeta;
  sizeOnDisk?: number;
};

export type ModelWithMetadata = {
  model: ModelMeta;
  downloadedAt: string;
  lastUsed: string | null;
  sizeOnDisk?: number;
  status:
    | 'ready'
    | 'downloading'
    | 'extracting'
    | 'extracting_resume_skipping'
    | 'failed';
  progress?: number;
};

export type ChecksumMismatchReason = 'CHECKSUM_MISMATCH' | 'CHECKSUM_FAILED';

export type ChecksumMismatchInfo = {
  category: ModelCategory;
  modelId: string;
  filePath: string;
  expected?: string;
  actual?: string;
  reason: ChecksumMismatchReason;
};

export type CachePayload<T extends ModelMeta = ModelMeta> = {
  lastUpdated: string;
  models: T[];
};

export type CacheStatus = {
  lastUpdated: string | null;
  source: 'cache' | 'remote';
};

export type EnsureModelOptions = {
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  overwrite?: boolean;
  verifyChecksum?: boolean;
  onChecksumMismatch?: (info: ChecksumMismatchInfo) => Promise<boolean>;
  deleteArchiveAfterExtract?: boolean;
};

export type DownloadOptions = EnsureModelOptions & {
  maxRetries?: number;
};

export type ExtractOptions = Omit<EnsureModelOptions, 'overwrite'>;

export class PauseError extends Error {
  public readonly category: ModelCategory;
  public readonly modelId: string;

  constructor(
    category: ModelCategory,
    modelId: string,
    message = 'Operation paused'
  ) {
    super(message);
    this.name = 'PauseError';
    this.category = category;
    this.modelId = modelId;
  }
}

export function isPauseError(error: unknown): error is PauseError {
  return error instanceof Error && error.name === 'PauseError';
}
