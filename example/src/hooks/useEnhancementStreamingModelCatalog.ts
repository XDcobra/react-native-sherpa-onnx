import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createEnhancementModelPathContext,
  getEnhancementModelPathConfig,
  loadEnhancementStreamingModelCatalog,
  type EnhancementModelEntry,
  type EnhancementStreamingCatalogSnapshot,
} from '../utils/enhancementModelCatalog';

export type UseEnhancementStreamingModelCatalogResult = {
  entries: EnhancementModelEntry[];
  detectedModelIds: string[];
  streamingModelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useEnhancementStreamingModelCatalog(): UseEnhancementStreamingModelCatalogResult {
  const [snapshot, setSnapshot] =
    useState<EnhancementStreamingCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadEnhancementStreamingModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No enhancement models found. Add a model under assets, PAD, or downloads (category: enhancement).'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load streaming enhancement models'
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
      if (category !== ModelCategory.Enhancement) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createEnhancementModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error(
          'Enhancement streaming model catalog is not loaded yet'
        );
      }
      return getEnhancementModelPathConfig(modelId, pathContext);
    },
    [pathContext]
  );

  return {
    entries: snapshot?.entries ?? [],
    detectedModelIds: snapshot?.detectedModelIds ?? [],
    streamingModelIds: snapshot?.streamingModelIds ?? [],
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
