import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createLanguageIdModelPathContext,
  getLanguageIdModelPathConfig,
  loadLanguageIdModelCatalog,
  type LanguageIdCatalogSnapshot,
  type LanguageIdModelEntry,
} from '../utils/languageIdModelCatalog';

export type UseLanguageIdModelCatalogResult = {
  entries: LanguageIdModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useLanguageIdModelCatalog(): UseLanguageIdModelCatalogResult {
  const [snapshot, setSnapshot] = useState<LanguageIdCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadLanguageIdModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No Whisper multilingual models found. Download an STT Whisper pack (or Language ID category) from Download Showcase.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load language ID model catalog'
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
      if (
        category !== ModelCategory.LanguageId &&
        category !== ModelCategory.Stt
      ) {
        return;
      }
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createLanguageIdModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('Language ID model catalog is not loaded yet');
      }
      return getLanguageIdModelPathConfig(modelId, pathContext);
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
