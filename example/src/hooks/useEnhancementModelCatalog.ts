import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createEnhancementModelPathContext,
  getEnhancementModelPathConfig,
  loadEnhancementModelCatalog,
  type EnhancementCatalogSnapshot,
  type EnhancementModelEntry,
} from '../utils/enhancementModelCatalog';

export type UseEnhancementModelCatalogResult = {
  entries: EnhancementModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useEnhancementModelCatalog(): UseEnhancementModelCatalogResult {
  const [snapshot, setSnapshot] = useState<EnhancementCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadEnhancementModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No speech enhancement models found. Add a GTCRN or DPDFNet model as a bundled asset, downloaded model, or PAD model. See docs/speech-enhancement.md.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load available enhancement models'
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
        throw new Error('Enhancement model catalog is not loaded yet');
      }
      return getEnhancementModelPathConfig(modelId, pathContext);
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
