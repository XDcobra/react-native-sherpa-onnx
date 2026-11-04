import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  createKwsModelPathContext,
  getKwsModelPathConfig,
  loadKwsModelCatalog,
  type KwsCatalogSnapshot,
  type KwsModelEntry,
} from '../utils/kwsModelCatalog';

export type UseKwsModelCatalogResult = {
  entries: KwsModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

export function useKwsModelCatalog(): UseKwsModelCatalogResult {
  const [snapshot, setSnapshot] = useState<KwsCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadKwsModelCatalog();
      setSnapshot(next);
      if (next.entries.length === 0) {
        setError(
          'No KWS packs on device. Download from Download Showcase (ModelCategory.Kws / kws-models).'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setError(
        err instanceof Error ? err.message : 'Failed to load KWS model catalog'
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
      if (category !== ModelCategory.Kws) return;
      reload().catch(() => {});
    });
    return unsubscribe;
  }, [reload]);

  const pathContext = useMemo(
    () => (snapshot ? createKwsModelPathContext(snapshot) : null),
    [snapshot]
  );

  const resolveModelPath = useCallback(
    (modelId: string): FileSource => {
      if (!pathContext) {
        throw new Error('KWS model catalog is not loaded yet');
      }
      return getKwsModelPathConfig(modelId, pathContext);
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
