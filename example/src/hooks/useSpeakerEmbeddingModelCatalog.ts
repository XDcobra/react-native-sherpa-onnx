import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createSpeakerEmbeddingModelPathContext,
  getSpeakerEmbeddingModelPathConfig,
  loadSpeakerEmbeddingModelCatalog,
  type SpeakerEmbeddingCatalogSnapshot,
  type SpeakerEmbeddingModelEntry,
} from '../utils/speakerEmbeddingModelCatalog';

export type UseSpeakerEmbeddingModelCatalogResult = {
  entries: SpeakerEmbeddingModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useSpeakerEmbeddingModelCatalog(): UseSpeakerEmbeddingModelCatalogResult {
  const [snapshot, setSnapshot] =
    useState<SpeakerEmbeddingCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSpeakerEmbeddingModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No speaker-embedding models found. Add a WeSpeaker / 3D-Speaker / NeMo model as a bundled asset, download, or PAD model.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load available speaker-embedding models'
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
      if (category !== ModelCategory.SpeakerEmbedding) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createSpeakerEmbeddingModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('Speaker-embedding model catalog is not loaded yet');
      }
      return getSpeakerEmbeddingModelPathConfig(modelId, pathContext);
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
