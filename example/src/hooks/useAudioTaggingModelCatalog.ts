import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createAudioTaggingModelPathContext,
  getAudioTaggingModelPathConfig,
  loadAudioTaggingModelCatalog,
  type AudioTaggingCatalogSnapshot,
  type AudioTaggingModelEntry,
} from '../utils/audioTaggingModelCatalog';

export type UseAudioTaggingModelCatalogResult = {
  entries: AudioTaggingModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useAudioTaggingModelCatalog(): UseAudioTaggingModelCatalogResult {
  const [snapshot, setSnapshot] = useState<AudioTaggingCatalogSnapshot | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadAudioTaggingModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No audio tagging models found. Download from Download Showcase.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load audio tagging model catalog'
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
      if (category !== ModelCategory.AudioTagging) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createAudioTaggingModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('Audio tagging model catalog is not loaded yet');
      }
      return getAudioTaggingModelPathConfig(modelId, pathContext);
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
