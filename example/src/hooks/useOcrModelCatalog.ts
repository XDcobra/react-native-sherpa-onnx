import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  loadOcrModelCatalog,
  resolveOcrModelSource,
  type OcrCatalogSnapshot,
  type OcrModelEntry,
} from '../utils/ocrModelCatalog';

export type UseOcrModelCatalogResult = {
  entries: OcrModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useOcrModelCatalog(): UseOcrModelCatalogResult {
  const [snapshot, setSnapshot] = useState<OcrCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadOcrModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No OCR models found. Use bundled assets, downloaded models, or PAD models.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load OCR model catalog'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Ocr) {
        return;
      }
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () =>
      snapshot
        ? {
            padModelIds: snapshot.padModelIds,
            padModelsPath: snapshot.padModelsPath,
            bundledFolders: snapshot.bundledFolders,
            downloadedIds: snapshot.downloadedIds,
          }
        : null,
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('OCR model catalog is not loaded yet');
      }
      return resolveOcrModelSource(modelId, pathContext);
    },
    [pathContext]
  );

  return {
    entries: snapshot?.entries ?? [],
    modelIds: snapshot?.entries.map((entry) => entry.id) ?? [],
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
