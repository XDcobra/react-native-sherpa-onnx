import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createVadModelPathContext,
  getVadModelPathConfig,
  loadVadModelCatalog,
  type VadCatalogSnapshot,
  type VadModelEntry,
} from '../utils/vadModelCatalog';

export type UseOfflineVadModelCatalogResult = {
  entries: VadModelEntry[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

/** Full VAD catalog for offline segmentOfflineBuffer (not streaming-filtered). */
export function useOfflineVadModelCatalog(): UseOfflineVadModelCatalogResult {
  const [snapshot, setSnapshot] = useState<VadCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadVadModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No VAD models found. Add one under assets, PAD, or downloads (category: vad).'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load VAD model catalog'
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
      if (category !== ModelCategory.Vad) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createVadModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('VAD model catalog is not loaded yet');
      }
      return getVadModelPathConfig(modelId, pathContext);
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
