import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  assertStreamingPunctuationCustomConfig,
  createStreamingPunctuation,
  type StreamingPunctuationEngine,
} from 'react-native-sherpa-onnx/punctuation';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearPunctuationStreamingCache,
  getPunctuationStreamingCache,
  setPunctuationStreamingCache,
} from '../engineCache';
import type {
  ModelInitMode,
  PunctuationStreamingCustomInitFormState,
} from '../components/modelInit';
import { fillStreamingPunctuationCustomConfigFromModelFolder } from '../utils/punctuationCustomInitFill';
import {
  formatPunctuationInitError,
  type UsePunctuationModelInitOptions,
} from './usePunctuationModelInit';
import { usePunctuationStreamingModelCatalog } from './usePunctuationStreamingModelCatalog';

export const DEFAULT_STREAMING_PUNCTUATION_CUSTOM_INIT: PunctuationStreamingCustomInitFormState =
  {
    fileSources: {},
  };

export type PunctuationStreamingModelTypeInit = 'auto' | 'cnn_bilstm';

export function usePunctuationStreamingModelInit(
  options: UsePunctuationModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = usePunctuationStreamingModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<PunctuationStreamingCustomInitFormState>(
      DEFAULT_STREAMING_PUNCTUATION_CUSTOM_INIT
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
  const [modelTypeInit, setModelTypeInit] =
    useState<PunctuationStreamingModelTypeInit>('auto');
  const [numThreads, setNumThreads] = useState('2');
  const [provider, setProvider] = useState('cpu');
  const [debugPunct, setDebugPunct] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<StreamingPunctuationEngine | null>(null);

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
    const cached = getPunctuationStreamingCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? 'custom:cnn_bilstm'
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
    clearPunctuationStreamingCache();
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
      setInitializedSummary(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const nt = Math.max(1, parseInt(numThreads, 10) || 1);
        const eng = await createStreamingPunctuation({
          modelSource: modelPath,
          modelType: modelTypeInit,
          numThreads: nt,
          provider: provider.trim() || 'cpu',
          debug: debugPunct,
        });
        engineRef.current = eng;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message = `Ready: ${summary} (instance ${eng.instanceId})`;
        setInitializedSummary(summary);
        setInitResult(message);
        setPunctuationStreamingCache(eng, modelFolder, message);
      } catch (err) {
        console.error('Streaming punctuation initialization error:', err);
        const errorMessage = formatPunctuationInitError(err);
        setError(`Init failed: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    },
    [
      debugPunct,
      modelTypeInit,
      numThreads,
      provider,
      releaseCurrentEngine,
      resolveModelPath,
    ]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const customConfig = { ...customInitForm.fileSources };
      assertStreamingPunctuationCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );
      const nt = Math.max(1, parseInt(numThreads, 10) || 1);
      const eng = await createStreamingPunctuation({
        initMode: 'custom',
        modelType: 'cnn_bilstm',
        customConfig: customConfig as {
          cnn_bilstm: FileSource;
          bpe_vocab: FileSource;
        },
        numThreads: nt,
        provider: provider.trim() || 'cpu',
        debug: debugPunct,
      });
      engineRef.current = eng;
      setCurrentModelFolder(null);
      const summary = 'custom:cnn_bilstm';
      const message = `Ready: custom cnn_bilstm (instance ${eng.instanceId})`;
      setInitializedSummary(summary);
      setInitResult(message);
      setPunctuationStreamingCache(eng, 'custom', message);
    } catch (err) {
      console.error('Streaming punctuation custom initialization error:', err);
      const errorMessage = formatPunctuationInitError(err);
      setError(`Init failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm, debugPunct, numThreads, provider, releaseCurrentEngine]);

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
      const fillResult =
        await fillStreamingPunctuationCustomConfigFromModelFolder(
          await toDetectSource(modelPath)
        );
      setCustomInitForm({ fileSources: fillResult.customConfig });
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
      setError(formatPunctuationInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm({ fileSources: {} });
    setCustomFillHint(
      'Scattered test: pick CNN-BiLSTM ONNX and BPE vocab separately, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.destroy();
      } catch (err) {
        console.error(
          'usePunctuationStreamingModelInit: Failed to destroy:',
          err
        );
      }
      engineRef.current = null;
    }
    clearPunctuationStreamingCache();
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
    modelTypeInit,
    setModelTypeInit,
    numThreads,
    setNumThreads,
    provider,
    setProvider,
    debugPunct,
    setDebugPunct,
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
