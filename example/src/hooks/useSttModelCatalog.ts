import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createSttModelPathContext,
  getSttModelPathConfig,
  loadSttModelCatalog,
  type SttCatalogSnapshot,
  type SttModelEntry,
} from '../utils/sttModelCatalog';

export type UseSttModelCatalogResult = {
  entries: SttModelEntry[];
  modelIds: string[];
  padModelIds: string[];
  padModelsPath: string | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useSttModelCatalog(): UseSttModelCatalogResult {
  const [snapshot, setSnapshot] = useState<SttCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSttModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No STT models found. Use bundled assets, downloaded models, or PAD models.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load STT model catalog'
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
      if (category !== ModelCategory.Stt) {
        return;
      }
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createSttModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('STT model catalog is not loaded yet');
      }
      return getSttModelPathConfig(modelId, pathContext);
    },
    [pathContext]
  );

  return {
    entries: snapshot?.entries ?? [],
    modelIds: snapshot?.entries.map((entry) => entry.id) ?? [],
    padModelIds: snapshot?.padModelIds ?? [],
    padModelsPath: snapshot?.padModelsPath ?? null,
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
