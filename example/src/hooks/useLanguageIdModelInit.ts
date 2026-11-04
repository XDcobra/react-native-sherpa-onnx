import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertLanguageIdCustomConfig,
  createLanguageIdentification,
  detectLanguageIdModel,
  type LanguageIdCustomConfig,
  type LanguageIdentificationEngine,
} from 'react-native-sherpa-onnx/language-identification';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearLanguageIdCache,
  getLanguageIdCache,
  setLanguageIdCache,
} from '../engineCache';
import type {
  LanguageIdentificationCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import { fillLanguageIdCustomConfigFromModelFolder } from '../utils/languageIdCustomInitFill';
import { useLanguageIdModelCatalog } from './useLanguageIdModelCatalog';

export const DEFAULT_LANGUAGE_ID_CUSTOM_INIT: LanguageIdentificationCustomInitFormState =
  {
    modelType: 'whisper',
    fileSources: {},
  };

const NUM_THREADS = 2;

export function formatLanguageIdInitError(err: unknown): string {
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

export type UseLanguageIdModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useLanguageIdModelInit(
  options: UseLanguageIdModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useLanguageIdModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<LanguageIdentificationCustomInitFormState>(
      DEFAULT_LANGUAGE_ID_CUSTOM_INIT
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<LanguageIdentificationEngine | null>(null);

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
    const cached = getLanguageIdCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? 'custom:whisper'
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
    clearLanguageIdCache();
  }, []);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert(
          'Select a model',
          'Pick a Whisper multilingual catalog folder first.'
        );
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
        const detectResult = await detectLanguageIdModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success) {
          const message =
            detectResult.error?.trim() ||
            'No multilingual Whisper Language ID model detected';
          setError(message);
          setInitResult('Initialization failed: detection unsuccessful');
          return;
        }
        const eng = await createLanguageIdentification({
          modelSource,
          numThreads: NUM_THREADS,
        });
        engineRef.current = eng;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message =
          `Initialized: ${summary}\n` +
          `Detected: whisper multilingual` +
          (detectResult.modelType ? ` (${detectResult.modelType})` : '');
        setInitializedSummary(summary);
        setInitResult(message);
        setLanguageIdCache(eng, modelFolder, message);
      } catch (err) {
        console.error('LanguageId Initialization error:', err);
        const errorMessage = formatLanguageIdInitError(err);
        setError(`Init failed: ${errorMessage}`);
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
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const encoder = customInitForm.fileSources.encoder;
      const decoder = customInitForm.fileSources.decoder;
      if (!encoder || !decoder) {
        throw new Error('Custom init requires both encoder and decoder paths.');
      }
      const customConfig = { encoder, decoder } as LanguageIdCustomConfig;
      assertLanguageIdCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );
      const eng = await createLanguageIdentification({
        customConfig,
        numThreads: NUM_THREADS,
      });
      engineRef.current = eng;
      setCurrentModelFolder(null);
      const summary = 'custom:whisper';
      const message = 'Initialized (custom): whisper encoder + decoder';
      setInitializedSummary(summary);
      setInitResult(message);
      setLanguageIdCache(eng, 'custom', message);
    } catch (err) {
      console.error('LanguageId custom initialization error:', err);
      const errorMessage = formatLanguageIdInitError(err);
      setError(`Init failed: ${errorMessage}`);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm.fileSources, releaseCurrentEngine]);

  const fillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a catalog Whisper folder first.');
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const fillResult = await fillLanguageIdCustomConfigFromModelFolder(
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
        `Filled from ${getModelDisplayName(modelFolder)} (${
          fillResult.modelDir
        }).${missing}`
      );
    } catch (err) {
      setCustomFillHint(null);
      setError(formatLanguageIdInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick encoder + decoder ONNX from any location, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch (err) {
        console.error('useLanguageIdModelInit: Failed to destroy:', err);
      }
      engineRef.current = null;
    }
    clearLanguageIdCache();
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
