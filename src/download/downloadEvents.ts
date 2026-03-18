import type {
  ModelCategory,
  ModelMetaBase,
  DownloadProgress,
  DownloadProgressListener,
  ModelsListUpdatedListener,
} from './types';

const downloadProgressListeners = new Set<DownloadProgressListener>();
const modelsListUpdatedListeners = new Set<ModelsListUpdatedListener>();

export const subscribeDownloadProgress = (
  listener: DownloadProgressListener
): (() => void) => {
  downloadProgressListeners.add(listener);
  return () => {
    downloadProgressListeners.delete(listener);
  };
};

export const subscribeModelsListUpdated = (
  listener: ModelsListUpdatedListener
): (() => void) => {
  modelsListUpdatedListeners.add(listener);
  return () => {
    modelsListUpdatedListeners.delete(listener);
  };
};

export function emitDownloadProgress(
  category: ModelCategory,
  modelId: string,
  progress: DownloadProgress
): void {
  for (const listener of downloadProgressListeners) {
    try {
      listener(category, modelId, progress);
    } catch (error) {
      console.warn('Download progress listener error:', error);
    }
  }
}

export function emitModelsListUpdated(
  category: ModelCategory,
  models: ModelMetaBase[]
): void {
  for (const listener of modelsListUpdatedListeners) {
    try {
      listener(category, models);
    } catch (error) {
      console.warn('Models list listener error:', error);
    }
  }
}
