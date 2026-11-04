import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { detectVadModel } from 'react-native-sherpa-onnx/vad';
import { toDetectSource } from '../modelConfig';
import {
  createVadModelPathContext,
  getVadModelPathConfig,
  loadVadModelCatalog,
  type VadCatalogSnapshot,
  type VadModelEntry,
} from '../utils/vadModelCatalog';

export type UseVadModelCatalogResult = {
  entries: VadModelEntry[];
  modelIds: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  resolveModelPath: (modelId: string) => FileSource;
};

async function filterStreamingVadEntries(
  snapshot: VadCatalogSnapshot
): Promise<VadModelEntry[]> {
  const ctx = createVadModelPathContext(snapshot);
  const streaming: VadModelEntry[] = [];
  for (const entry of snapshot.entries) {
    try {
      const modelPath = getVadModelPathConfig(entry.id, ctx);
      const detection = await detectVadModel(await toDetectSource(modelPath), {
        modelType: 'auto',
      });
      if (detection.success && detection.isStreaming) {
        streaming.push(entry);
      }
    } catch {
      // Ignore candidates that fail detection; keep picker clean.
    }
  }
  return streaming;
}

export function useVadModelCatalog(): UseVadModelCatalogResult {
  const [entries, setEntries] = useState<VadModelEntry[]>([]);
  const [snapshot, setSnapshot] = useState<VadCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadVadModelCatalog();
      setSnapshot(next);
      const streamingEntries = await filterStreamingVadEntries(next);
      setEntries(streamingEntries);
      if (streamingEntries.length === 0) {
        setError(
          'No streaming VAD models on device. Download from Download Showcase (ModelCategory.Vad).'
        );
      }
    } catch (err) {
      setSnapshot(null);
      setEntries([]);
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
    entries,
    modelIds: entries.map((entry) => entry.id),
    loading,
    error,
    reload,
    resolveModelPath,
  };
}
