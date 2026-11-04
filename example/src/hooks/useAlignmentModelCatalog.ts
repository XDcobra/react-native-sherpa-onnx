import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createAlignmentModelPathContext,
  getAlignmentModelPathConfig,
  loadAlignmentModelCatalog,
  type AlignmentCatalogSnapshot,
  type AlignmentModelEntry,
} from '../utils/alignmentModelCatalog';

export type UseAlignmentModelCatalogResult = {
  entries: AlignmentModelEntry[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useAlignmentModelCatalog(): UseAlignmentModelCatalogResult {
  const [snapshot, setSnapshot] = useState<AlignmentCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadAlignmentModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No alignment models found. Add a wav2vec2 model under assets, PAD, or downloads (category: alignment).'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load alignment model catalog'
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
      if (category !== ModelCategory.Alignment) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createAlignmentModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('Alignment model catalog is not loaded yet');
      }
      return getAlignmentModelPathConfig(modelId, pathContext);
    },
    [pathContext]
  );

  return {
    entries: snapshot?.entries ?? [],
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
