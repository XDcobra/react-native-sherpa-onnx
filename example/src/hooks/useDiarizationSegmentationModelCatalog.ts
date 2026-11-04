import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createDiarizationSegmentationModelPathContext,
  getDiarizationSegmentationModelPathConfig,
  loadDiarizationSegmentationModelCatalog,
  type DiarizationSegmentationCatalogSnapshot,
  type DiarizationSegmentationModelEntry,
} from '../utils/diarizationSegmentationModelCatalog';

export type UseDiarizationSegmentationModelCatalogResult = {
  entries: DiarizationSegmentationModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useDiarizationSegmentationModelCatalog(): UseDiarizationSegmentationModelCatalogResult {
  const [snapshot, setSnapshot] =
    useState<DiarizationSegmentationCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDiarizationSegmentationModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No diarization segmentation models found. Add a Pyannote / Reverb pack as a bundled asset, download, or PAD model.'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load available diarization segmentation models'
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
      snapshot ? createDiarizationSegmentationModelPathContext(snapshot) : null,
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error(
          'Diarization segmentation model catalog is not loaded yet'
        );
      }
      return getDiarizationSegmentationModelPathConfig(modelId, pathContext);
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
