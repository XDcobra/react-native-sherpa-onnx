import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createSttModelPathContext,
  getSttModelPathConfig,
  loadSttStreamingModelCatalog,
  type SttModelEntry,
  type SttStreamingCatalogSnapshot,
} from '../utils/sttModelCatalog';

export type UseSttStreamingModelCatalogResult = {
  entries: SttModelEntry[];
  detectedModelIds: string[];
  streamingModelIds: string[];
  offlineModelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useSttStreamingModelCatalog(): UseSttStreamingModelCatalogResult {
  const [snapshot, setSnapshot] = useState<SttStreamingCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSttStreamingModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No STT models found. Install/download a model or add bundled/PAD assets.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load streaming STT model catalog'
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
      if (category !== ModelCategory.Stt) return;
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
        throw new Error('STT streaming model catalog is not loaded yet');
      }
      return getSttModelPathConfig(modelId, pathContext);
    },
    [pathContext]
  );

  return {
    entries: snapshot?.entries ?? [],
    detectedModelIds: snapshot?.detectedModelIds ?? [],
    streamingModelIds: snapshot?.streamingModelIds ?? [],
    offlineModelIds: snapshot?.offlineModelIds ?? [],
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
