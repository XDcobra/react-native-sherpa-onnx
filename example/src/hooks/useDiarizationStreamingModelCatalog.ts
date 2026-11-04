import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createDiarizationStreamingModelPathContext,
  getDiarizationStreamingModelPathConfig,
  loadDiarizationStreamingModelCatalog,
  type DiarizationStreamingCatalogSnapshot,
  type DiarizationStreamingModelEntry,
} from '../utils/diarizationStreamingModelCatalog';

export type UseDiarizationStreamingModelCatalogResult = {
  entries: DiarizationStreamingModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useDiarizationStreamingModelCatalog(): UseDiarizationStreamingModelCatalogResult {
  const [snapshot, setSnapshot] =
    useState<DiarizationStreamingCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDiarizationStreamingModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No streaming Sortformer diarization models found. Download from Download Showcase or configure custom paths.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load streaming diarization model catalog'
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
      if (category !== ModelCategory.Diarization) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () =>
      snapshot ? createDiarizationStreamingModelPathContext(snapshot) : null,
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error(
          'Streaming diarization model catalog is not loaded yet'
        );
      }
      return getDiarizationStreamingModelPathConfig(modelId, pathContext);
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
