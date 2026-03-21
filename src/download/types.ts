import type { TTSModelType } from '../tts/types';

export enum ModelCategory {
  Tts = 'tts',
  Stt = 'stt',
  Vad = 'vad',
  Diarization = 'diarization',
  Enhancement = 'enhancement',
  Separation = 'separation',
  Qnn = 'qnn',
}

/** TTS model type for meta; 'unknown' when id could not be classified. */
export type TtsModelType = TTSModelType | 'unknown';

export type Quantization = 'fp16' | 'int8' | 'int8-quantized' | 'unknown';

export type SizeTier = 'tiny' | 'small' | 'medium' | 'large' | 'unknown';

export type ModelArchiveExt = 'tar.bz2' | 'onnx';

export type ModelMetaBase = {
  id: string;
  displayName: string;
  downloadUrl: string;
  archiveExt: ModelArchiveExt;
  bytes: number;
  sha256?: string;
  category: ModelCategory;
};

export type TtsModelMeta = ModelMetaBase & {
  type: TtsModelType;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  category: ModelCategory.Tts;
};

export type DownloadProgress = {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  phase?: 'downloading' | 'extracting';
  speed?: number;
  eta?: number;
};

export type DownloadResult = {
  modelId: string;
  localPath: string;
};

export type DownloadState = {
  modelId: string;
  category: ModelCategory;
  phase: 'downloading' | 'extracting';
  startedAt: string;
  archivePath: string;
  model: ModelMetaBase;
  bytesDownloaded?: number;
  totalBytes?: number;
};

/** State for an in-progress or interrupted model extraction (archive --> model dir). */
export type ExtractionState = {
  modelId: string;
  category: ModelCategory;
  phase: 'extracting';
  startedAt: string;
  archivePath: string;
  modelDir: string;
  model: ModelMetaBase;
};

export type DownloadProgressListener = (
  category: ModelCategory,
  modelId: string,
  progress: DownloadProgress
) => void;

export type ModelsListUpdatedListener = (
  category: ModelCategory,
  models: ModelMetaBase[]
) => void;

export type ModelManifest<T extends ModelMetaBase = ModelMetaBase> = {
  downloadedAt: string;
  lastUsed?: string;
  model: T;
  sizeOnDisk?: number;
};

export type ModelWithMetadata<T extends ModelMetaBase = ModelMetaBase> = {
  model: T;
  downloadedAt: string;
  lastUsed: string | null;
  sizeOnDisk?: number;
  status: 'ready' | 'downloading' | 'extracting' | 'failed';
  progress?: number;
};

export type ChecksumIssue = {
  category: ModelCategory;
  id: string;
  archivePath: string;
  expected?: string;
  message: string;
  reason: 'CHECKSUM_FAILED' | 'CHECKSUM_MISMATCH';
};

export type CachePayload<T extends ModelMetaBase> = {
  lastUpdated: string;
  models: T[];
};

export type CacheStatus = {
  lastUpdated: string | null;
  source: 'cache' | 'remote';
};
