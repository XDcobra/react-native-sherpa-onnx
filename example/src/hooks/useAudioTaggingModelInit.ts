import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertAudioTaggingCustomConfig,
  createAudioTagging,
  detectAudioTaggingModel,
  type AudioTaggingCustomConfig,
  type AudioTaggingEngine,
  type AudioTaggingModelType,
} from 'react-native-sherpa-onnx/audio-tagging';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearAudioTaggingCache,
  getAudioTaggingCache,
  setAudioTaggingCache,
} from '../engineCache';
import type {
  AudioTaggingCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import { fillAudioTaggingCustomConfigFromModelFolder } from '../utils/audioTaggingCustomInitFill';
import { useAudioTaggingModelCatalog } from './useAudioTaggingModelCatalog';

export const DEFAULT_AUDIO_TAGGING_CUSTOM_INIT: AudioTaggingCustomInitFormState =
  {
    modelType: 'ced',
    fileSources: {},
  };

export const AUDIO_TAGGING_TOP_K_OPTIONS = [3, 5, 10] as const;
export type AudioTaggingTopK = (typeof AUDIO_TAGGING_TOP_K_OPTIONS)[number];

const NUM_THREADS = 2;

export function formatAudioTaggingInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const errorObj = err as {
      message?: string;
      code?: string;
      userInfo?: { NSLocalizedDescription?: string };
    };
    const message =
      errorObj.message ??
      errorObj.userInfo?.NSLocalizedDescription ??
      JSON.stringify(err);
    return errorObj.code ? `[${errorObj.code}] ${message}` : message;
  }
  return String(err);
}

export type UseAudioTaggingModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useAudioTaggingModelInit(
  options: UseAudioTaggingModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useAudioTaggingModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<AudioTaggingCustomInitFormState>(
      DEFAULT_AUDIO_TAGGING_CUSTOM_INIT
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
  const [topK, setTopK] = useState<AudioTaggingTopK>(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<AudioTaggingEngine | null>(null);

  const isEngineInitialized = initializedSummary != null;

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
    const cached = getAudioTaggingCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? 'custom'
          : getModelDisplayName(cached.modelFolder)
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy();
    engineRef.current = null;
    clearAudioTaggingCache();
  }, []);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert('Select a model', 'Pick an audio tagging pack first.');
        return;
      }
      setLoading(true);
      setError(null);
      setInitResult(null);
      setInitializedSummary(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelSource = await toDetectSource(resolveModelPath(modelFolder));
        const detectResult = await detectAudioTaggingModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success) {
          const message =
            detectResult.error?.trim() ||
            'No audio tagging model detected (need ONNX + labels CSV)';
          setError(message);
          setInitResult('Initialization failed: detection unsuccessful');
          return;
        }
        const detectedType: AudioTaggingModelType =
          detectResult.modelType === 'zipformer' ? 'zipformer' : 'ced';
        const eng = await createAudioTagging({
          modelSource,
          numThreads: NUM_THREADS,
          topK,
        });
        engineRef.current = eng;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message = `Initialized: ${summary}\nDetected: ${detectedType}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setAudioTaggingCache(eng, modelFolder, message);
      } catch (err) {
        console.error('AudioTagging Initialization error:', err);
        const errorMessage = formatAudioTaggingInitError(err);
        setError(`Init failed: ${errorMessage}`);
        setInitResult(`Initialization failed: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    },
    [releaseCurrentEngine, resolveModelPath, topK]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const model = customInitForm.fileSources.model;
      const labels = customInitForm.fileSources.labels;
      if (!model || !labels) {
        throw new Error('Custom init requires model ONNX and labels CSV.');
      }
      const customConfig = { model, labels } as AudioTaggingCustomConfig;
      assertAudioTaggingCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );
      const eng = await createAudioTagging({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig,
        numThreads: NUM_THREADS,
        topK,
      });
      engineRef.current = eng;
      setCurrentModelFolder(null);
      const summary = `custom:${customInitForm.modelType}`;
      const message = `Initialized (custom): ${customInitForm.modelType} model + labels`;
      setInitializedSummary(summary);
      setInitResult(message);
      setAudioTaggingCache(eng, 'custom', message);
    } catch (err) {
      console.error('AudioTagging custom initialization error:', err);
      const errorMessage = formatAudioTaggingInitError(err);
      setError(`Init failed: ${errorMessage}`);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm, releaseCurrentEngine, topK]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick an audio tagging pack first.');
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const fillResult = await fillAudioTaggingCustomConfigFromModelFolder(
        await toDetectSource(resolveModelPath(modelFolder))
      );
      setCustomInitForm({
        modelType: fillResult.modelType,
        fileSources: fillResult.customConfig,
      });
      const missing =
        fillResult.missingKeys.length > 0
          ? ` Missing: ${fillResult.missingKeys.join(', ')}`
          : '';
      setCustomFillHint(
        `Filled from ${getModelDisplayName(modelFolder)}.${missing}`
      );
    } catch (err) {
      setCustomFillHint(null);
      setError(formatAudioTaggingInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick model ONNX + labels CSV, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch (err) {
        console.error('useAudioTaggingModelInit: Failed to destroy:', err);
      }
      engineRef.current = null;
    }
    clearAudioTaggingCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
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
    topK,
    setTopK,
    loading,
    error,
    setError,
    isEngineInitialized,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
  };
}
