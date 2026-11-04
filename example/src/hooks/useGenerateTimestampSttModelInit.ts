import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertSttCustomConfig,
  createSTT,
  detectSttModel,
  type SttCustomConfig,
  type SttEngine,
  type STTModelType,
} from 'react-native-sherpa-onnx/stt';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearGenerateTimestampSttCache,
  getGenerateTimestampSttCache,
  setGenerateTimestampSttCache,
} from '../engineCache';
import type {
  ModelInitMode,
  SttCustomInitFormState,
} from '../components/modelInit';
import { fillSttCustomConfigFromModelFolder } from '../utils/sttCustomInitFill';
import { useSttModelCatalog } from './useSttModelCatalog';

const STT_NUM_THREADS = 2;

const TIMESTAMP_STT_MODEL_OPTIONS = {
  whisper: { enableTokenTimestamps: true },
} as const;

export const DEFAULT_GENERATE_TIMESTAMP_STT_CUSTOM_INIT: SttCustomInitFormState =
  {
    modelType: 'transducer',
    fileSources: {},
  };

export type GenerateTimestampSttDetectedModel = {
  type: STTModelType;
  modelDir: string;
};

export function formatGenerateTimestampSttInitError(err: unknown): string {
  if (err instanceof Error) {
    let message = err.message;
    if ('code' in err && typeof (err as { code?: unknown }).code === 'string') {
      message = `[${(err as { code: string }).code}] ${message}`;
    }
    return message;
  }
  return String(err);
}

export type UseGenerateTimestampSttModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useGenerateTimestampSttModelInit(
  options: UseGenerateTimestampSttModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useSttModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<SttCustomInitFormState>(
    DEFAULT_GENERATE_TIMESTAMP_STT_CUSTOM_INIT
  );
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<
    GenerateTimestampSttDetectedModel[]
  >([]);
  const [selectedModelType, setSelectedModelType] =
    useState<STTModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<SttEngine | null>(null);

  const isPrepared = initializedSummary != null && engineRef.current != null;

  useEffect(() => {
    if (!catalogError) return;
    setError(catalogError);
  }, [catalogError]);

  useEffect(() => {
    const cached = getGenerateTimestampSttCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? `custom:${cached.selectedModelType ?? 'unknown'}`
          : `auto:${getModelDisplayName(cached.modelFolder)}`
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  useEffect(() => {
    if (
      selectedModelForInit &&
      catalogEntries.some((e) => e.id === selectedModelForInit)
    ) {
      return;
    }
    setSelectedModelForInit(catalogEntries[0]?.id ?? null);
  }, [catalogEntries, selectedModelForInit]);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy();
    engineRef.current = null;
    clearGenerateTimestampSttCache();
  }, []);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert('Select a model', 'Pick a catalog model folder first.');
        return;
      }
      setLoading(true);
      setError(null);
      setInitResult(null);
      setDetectedModels([]);
      setSelectedModelType(null);
      setInitializedSummary(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const engine = await createSTT({
          modelSource: modelPath,
          modelType: 'auto',
          numThreads: STT_NUM_THREADS,
          modelOptions: TIMESTAMP_STT_MODEL_OPTIONS,
        });

        const detectResult = await detectSttModel(
          await toDetectSource(modelPath)
        );
        if (!detectResult.success || !detectResult.detectedModels?.length) {
          await engine.destroy();
          setError('No models detected in the directory');
          setInitResult('Initialization failed: No compatible models found');
          return;
        }

        const normalizedDetected: GenerateTimestampSttDetectedModel[] =
          detectResult.detectedModels.map((model) => ({
            ...model,
            type: model.type as STTModelType,
          }));
        const loadedType =
          (detectResult.modelType as STTModelType) ??
          normalizedDetected[0]?.type ??
          null;

        engineRef.current = engine;
        setDetectedModels(normalizedDetected);
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        setSelectedModelType(
          loadedType ??
            (normalizedDetected.length === 1
              ? normalizedDetected[0]?.type ?? null
              : null)
        );
        const summary = `auto:${getModelDisplayName(modelFolder)}`;
        const message = `Initialized (auto): ${getModelDisplayName(
          modelFolder
        )}\nDetected: ${normalizedDetected.map((m) => m.type).join(', ')}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setGenerateTimestampSttCache(
          engine,
          modelFolder,
          normalizedDetected,
          loadedType ?? normalizedDetected[0]?.type ?? null,
          message
        );
      } catch (err) {
        const errorMessage = formatGenerateTimestampSttInitError(err);
        setError(errorMessage);
        setInitResult(`Initialization failed: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    },
    [releaseCurrentEngine, resolveModelPath]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const customConfig = {
        ...customInitForm.fileSources,
      } as SttCustomConfig;
      assertSttCustomConfig(customConfig as unknown as Record<string, unknown>);

      const engine = await createSTT({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig,
        numThreads: STT_NUM_THREADS,
        modelOptions: TIMESTAMP_STT_MODEL_OPTIONS,
      });

      engineRef.current = engine;
      setCurrentModelFolder(null);
      setSelectedModelType(customInitForm.modelType);
      const summary = `custom:${customInitForm.modelType}`;
      const message = `Initialized (custom): ${customInitForm.modelType}`;
      setInitializedSummary(summary);
      setInitResult(message);
      setGenerateTimestampSttCache(
        engine,
        'custom',
        [],
        customInitForm.modelType,
        message
      );
    } catch (err) {
      const errorMessage = formatGenerateTimestampSttInitError(err);
      setError(errorMessage);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm, releaseCurrentEngine]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a catalog model folder first.');
      return;
    }

    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const modelPath = resolveModelPath(modelFolder);
      const fillResult = await fillSttCustomConfigFromModelFolder(modelPath, {
        quantization: 'int8',
        modelTypeOverride: customInitForm.modelType,
      });
      setCustomInitForm({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
      });
      const missing =
        fillResult.missingKeys.length > 0
          ? ` Missing: ${fillResult.missingKeys.join(', ')}`
          : '';
      setCustomFillHint(
        `Filled from ${getModelDisplayName(modelFolder)} (${
          fillResult.modelDir
        }).${missing}`
      );
    } catch (err) {
      setCustomFillHint(null);
      setError(formatGenerateTimestampSttInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick each file from different locations, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch {
        // ignore
      }
      engineRef.current = null;
    }
    clearGenerateTimestampSttCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setInitResult(null);
    setInitializedSummary(null);
    setCustomFillHint(null);
    setError(null);
  }, []);

  const applySelectedModel = useCallback(() => {
    if (initMode === 'custom') {
      return initializeCustom();
    }
    return initializeAuto(selectedModelForInit ?? currentModelFolder ?? '');
  }, [
    currentModelFolder,
    initMode,
    initializeAuto,
    initializeCustom,
    selectedModelForInit,
  ]);

  return {
    engineRef,
    catalogEntries,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    customFillLoading,
    customFillHint,
    selectedModelForInit,
    setSelectedModelForInit,
    initializedSummary,
    loadingModels,
    initResult,
    currentModelFolder,
    detectedModels,
    selectedModelType,
    loading,
    error,
    setError,
    isPrepared,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
  };
}
