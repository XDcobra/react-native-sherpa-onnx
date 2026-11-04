import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  detectVadModel,
  type VADModelType,
} from 'react-native-sherpa-onnx/vad';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearGenerateTimestampVadPrepCache,
  getGenerateTimestampVadPrepCache,
  setGenerateTimestampVadPrepCache,
} from '../engineCache';
import { useOfflineVadModelCatalog } from './useOfflineVadModelCatalog';

export function formatGenerateTimestampVadPrepError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  return typeof err === 'string' ? err : String(err);
}

export function useGenerateTimestampVadPrep() {
  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useOfflineVadModelCatalog();

  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [preparedModelPath, setPreparedModelPath] = useState<string | null>(
    null
  );
  const [preparedModelType, setPreparedModelType] =
    useState<VADModelType | null>(null);
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [initResult, setInitResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPrepared =
    currentModelFolder != null &&
    selectedModelForInit === currentModelFolder &&
    preparedModelPath != null;

  useEffect(() => {
    if (!catalogError) return;
    setError(catalogError);
  }, [catalogError]);

  useEffect(() => {
    if (
      selectedModelForInit &&
      catalogEntries.some((e) => e.id === selectedModelForInit)
    ) {
      return;
    }
    setSelectedModelForInit(catalogEntries[0]?.id ?? null);
  }, [catalogEntries, selectedModelForInit]);

  useEffect(() => {
    const cached = getGenerateTimestampVadPrepCache();
    if (!cached.modelFolder) {
      return;
    }
    setCurrentModelFolder(cached.modelFolder);
    setSelectedModelForInit(null);
    setPreparedModelPath(cached.modelPath);
    setPreparedModelType(cached.modelType);
    setInitializedSummary(getModelDisplayName(cached.modelFolder));
    setInitResult(cached.initMessage);
  }, []);

  const applySelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a VAD catalog folder first.');
      return;
    }

    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);

    try {
      const detection = await detectVadModel(
        await toDetectSource(resolveModelPath(modelFolder)),
        { modelType: 'auto' }
      );
      const modelPath = detection.paths?.model?.trim();
      const modelType = detection.modelType;
      if (!detection.success || !modelPath || !modelType) {
        throw new Error(
          detection.error || 'VAD model detection failed: no model path/type.'
        );
      }
      if (modelType !== 'silero_vad' && modelType !== 'ten_vad') {
        throw new Error(`Unsupported detected VAD model type: ${modelType}`);
      }

      const message = `${getModelDisplayName(
        modelFolder
      )}\nmodel: ${modelPath}\ntype: ${modelType}`;
      setCurrentModelFolder(modelFolder);
      setSelectedModelForInit(modelFolder);
      setPreparedModelPath(modelPath);
      setPreparedModelType(modelType);
      setInitializedSummary(getModelDisplayName(modelFolder));
      setInitResult(message);
      setGenerateTimestampVadPrepCache(
        modelFolder,
        modelPath,
        modelType,
        message
      );
    } catch (err) {
      const errorMessage = formatGenerateTimestampVadPrepError(err);
      setError(errorMessage);
      setInitResult(`Prepare failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const releasePrep = useCallback(() => {
    clearGenerateTimestampVadPrepCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setPreparedModelPath(null);
    setPreparedModelType(null);
    setInitializedSummary(null);
    setInitResult(null);
    setError(null);
  }, []);

  const resolvePreparedModelPath = useCallback(async () => {
    const folder = currentModelFolder;
    if (!folder) {
      throw new Error('VAD model is not prepared.');
    }
    return toDetectSource(resolveModelPath(folder));
  }, [currentModelFolder, resolveModelPath]);

  return {
    catalogEntries,
    loadingModels,
    selectedModelForInit,
    setSelectedModelForInit,
    currentModelFolder,
    preparedModelPath,
    preparedModelType,
    initializedSummary,
    initResult,
    loading,
    error,
    setError,
    isPrepared,
    applySelectedModel,
    releasePrep,
    resolvePreparedModelPath,
    resolveModelPath,
  };
}
