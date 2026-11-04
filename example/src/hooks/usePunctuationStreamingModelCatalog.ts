import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createPunctuationModelPathContext,
  getPunctuationModelPathConfig,
  loadStreamingPunctuationModelCatalog,
  type PunctuationCatalogSnapshot,
  type PunctuationModelEntry,
} from '../utils/punctuationModelCatalog';

export type UsePunctuationStreamingModelCatalogResult = {
  entries: PunctuationModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function usePunctuationStreamingModelCatalog(): UsePunctuationStreamingModelCatalogResult {
  const [snapshot, setSnapshot] = useState<PunctuationCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadStreamingPunctuationModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No streaming CNN-BiLSTM punctuation models found. Install under punctuation (Download manager) or add a matching asset / PAD path.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load streaming punctuation model catalog'
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
      if (category !== ModelCategory.Punctuation) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createPunctuationModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error(
          'Streaming punctuation model catalog is not loaded yet'
        );
      }
      return getPunctuationModelPathConfig(modelId, pathContext);
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
