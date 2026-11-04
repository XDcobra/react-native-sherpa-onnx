import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertStreamingSttCustomConfig,
  assertSttCustomConfig,
  createSTT,
  createStreamingSTT,
  detectSttModel,
  type LiveSttEngine,
  type OnlineSTTModelType,
  type StreamingSttCustomConfig,
  type SttCustomConfig,
  type SttEngine,
} from 'react-native-sherpa-onnx/stt';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearSttStreamingCache,
  getSttStreamingCache,
  setSttStreamingCache,
} from '../engineCache';
import type {
  ModelInitMode,
  StreamingSttCustomInitFormState,
  SttCustomInitFormState,
} from '../components/modelInit';
import type { EngineMode } from '../components/EngineModeModelSelector';
import { fillStreamingCustomConfigFromFolder } from '../utils/streamingCustomInitFill';
import { fillSttCustomConfigFromModelFolder } from '../utils/sttCustomInitFill';
import { useSttStreamingModelCatalog } from './useSttStreamingModelCatalog';
import { DEFAULT_STT_CUSTOM_INIT, formatSttInitError } from './useSttModelInit';

const STT_NUM_THREADS = 2;

export const DEFAULT_STREAMING_STT_CUSTOM_INIT: StreamingSttCustomInitFormState =
  {
    modelType: 'transducer',
    fileSources: {},
  };

export type SttStreamingActiveEngineKind = 'streaming' | 'offline-overload';

export type UseSttStreamingModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void;
};

export function useSttStreamingModelInit(
  options: UseSttStreamingModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onEngineReadyRef = useRef(options.onEngineReady);
  onEngineReadyRef.current = options.onEngineReady;

  const {
    entries: catalogEntries,
    detectedModelIds,
    streamingModelIds,
    offlineModelIds,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useSttStreamingModelCatalog();

  const streamingModelIdSet = useMemo(
    () => new Set(streamingModelIds),
    [streamingModelIds]
  );
  const offlineCapableModelIdSet = useMemo(
    () => new Set(offlineModelIds),
    [offlineModelIds]
  );

  const [engineMode, setEngineMode] = useState<EngineMode>('streaming');
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<StreamingSttCustomInitFormState>(
      DEFAULT_STREAMING_STT_CUSTOM_INIT
    );
  const [offlineCustomInitForm, setOfflineCustomInitForm] =
    useState<SttCustomInitFormState>(DEFAULT_STT_CUSTOM_INIT);
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);

  const catalogEntriesForMode = useMemo(
    () =>
      catalogEntries.filter((entry) =>
        engineMode === 'streaming'
          ? streamingModelIdSet.has(entry.id)
          : offlineCapableModelIdSet.has(entry.id)
      ),
    [catalogEntries, engineMode, offlineCapableModelIdSet, streamingModelIdSet]
  );
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
  const [activeEngineKind, setActiveEngineKind] =
    useState<SttStreamingActiveEngineKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamingEngineRef = useRef<LiveSttEngine | null>(null);
  const offlineOverloadEngineRef = useRef<SttEngine | null>(null);

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
    const initial =
      engineMode === 'streaming'
        ? catalogEntries.find((e) => streamingModelIdSet.has(e.id))?.id
        : catalogEntries.find((e) => offlineCapableModelIdSet.has(e.id))?.id;
    setSelectedModelForInit(initial ?? catalogEntries[0]?.id ?? null);
  }, [
    catalogEntries,
    engineMode,
    offlineCapableModelIdSet,
    selectedModelForInit,
    streamingModelIdSet,
  ]);

  useEffect(() => {
    setSelectedModelForInit((prev) => {
      if (!prev) return prev;
      if (engineMode === 'streaming' && !streamingModelIdSet.has(prev)) {
        return null;
      }
      if (engineMode === 'offline' && !offlineCapableModelIdSet.has(prev)) {
        return null;
      }
      return prev;
    });
  }, [engineMode, offlineCapableModelIdSet, streamingModelIdSet]);

  useEffect(() => {
    const cached = getSttStreamingCache();
    if (cached.engine != null && cached.modelFolder != null) {
      streamingEngineRef.current = cached.engine;
      setActiveEngineKind('streaming');
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? `custom:${cached.selectedModelType ?? 'unknown'}`
          : getModelDisplayName(cached.modelFolder)
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseStreamingEngine = useCallback(async () => {
    const previous = streamingEngineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    streamingEngineRef.current = null;
    clearSttStreamingCache();
  }, []);

  const releaseOfflineOverloadEngine = useCallback(async () => {
    const previous = offlineOverloadEngineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    offlineOverloadEngineRef.current = null;
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    await releaseStreamingEngine();
    await releaseOfflineOverloadEngine();
    setActiveEngineKind(null);
  }, [releaseOfflineOverloadEngine, releaseStreamingEngine]);

  const initializeStreamingAuto = useCallback(
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
        const detectSource = await toDetectSource(modelPath);
        const detection = await detectSttModel(detectSource, {
          modelType: 'auto',
        });
        if (!detection.success) {
          setError(detection.error ?? 'STT model detection failed');
          setInitResult('Initialization failed: model detection failed');
          return;
        }
        if (!detection.isStreaming) {
          setError(
            'Selected model is offline-only. Switch to Live Overload or pick a streaming-capable folder.'
          );
          setInitResult(
            'Initialization failed: model is not streaming-capable'
          );
          return;
        }

        const engine = await createStreamingSTT({
          modelSource: modelPath,
          modelType: 'auto',
          numThreads: STT_NUM_THREADS,
        });

        streamingEngineRef.current = engine;
        setActiveEngineKind('streaming');
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message = `Initialized streaming STT: ${summary}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setSttStreamingCache(
          engine,
          modelFolder,
          message,
          (detection.modelType as OnlineSTTModelType | undefined) ?? null
        );
        onEngineReadyRef.current?.();
      } catch (err) {
        const errorMessage = formatSttInitError(err);
        setError(errorMessage);
        setInitResult(`Initialization failed: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    },
    [releaseCurrentEngine, resolveModelPath]
  );

  const initializeStreamingCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();

      const customConfig = {
        ...customInitForm.fileSources,
      } as StreamingSttCustomConfig;
      assertStreamingSttCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );

      const engine = await createStreamingSTT({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig,
        numThreads: STT_NUM_THREADS,
      });

      streamingEngineRef.current = engine;
      setActiveEngineKind('streaming');
      setCurrentModelFolder(null);
      const summary = `custom:${customInitForm.modelType}`;
      const message = `Initialized streaming STT (custom): ${customInitForm.modelType}`;
      setInitializedSummary(summary);
      setInitResult(message);
      setSttStreamingCache(engine, 'custom', message, customInitForm.modelType);
      onEngineReadyRef.current?.();
    } catch (err) {
      const errorMessage = formatSttInitError(err);
      setError(errorMessage);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [customInitForm, releaseCurrentEngine]);

  const initializeOfflineOverloadAuto = useCallback(
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
        const detectSource = await toDetectSource(modelPath);
        const detection = await detectSttModel(detectSource, {
          modelType: 'auto',
        });
        if (!detection.success) {
          setError(detection.error ?? 'STT model detection failed');
          setInitResult('Initialization failed: model detection failed');
          return;
        }
        if (detection.isStreaming) {
          setError(
            'Selected model is streaming-only. Use Streaming mode or pick offline weights for Live Overload.'
          );
          setInitResult(
            'Initialization failed: model is not offline-capable for Live Overload'
          );
          return;
        }

        const engine = await createSTT({
          modelSource: modelPath,
          modelType: 'auto',
          numThreads: STT_NUM_THREADS,
        });

        offlineOverloadEngineRef.current = engine;
        setActiveEngineKind('offline-overload');
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = `overload:${getModelDisplayName(modelFolder)}`;
        const message = `Initialized Live Overload STT: ${getModelDisplayName(
          modelFolder
        )}`;
        setInitializedSummary(summary);
        setInitResult(message);
        onEngineReadyRef.current?.();
      } catch (err) {
        const errorMessage = formatSttInitError(err);
        setError(errorMessage);
        setInitResult(`Initialization failed: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    },
    [releaseCurrentEngine, resolveModelPath]
  );

  const initializeOfflineOverloadCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();

      const customConfig = {
        ...offlineCustomInitForm.fileSources,
      } as SttCustomConfig;
      assertSttCustomConfig(customConfig as unknown as Record<string, unknown>);

      const engine = await createSTT({
        initMode: 'custom',
        modelType: offlineCustomInitForm.modelType,
        customConfig,
        numThreads: STT_NUM_THREADS,
      });

      offlineOverloadEngineRef.current = engine;
      setActiveEngineKind('offline-overload');
      setCurrentModelFolder(null);
      const summary = `overload:custom:${offlineCustomInitForm.modelType}`;
      const message = `Initialized Live Overload STT (custom): ${offlineCustomInitForm.modelType}`;
      setInitializedSummary(summary);
      setInitResult(message);
      onEngineReadyRef.current?.();
    } catch (err) {
      const errorMessage = formatSttInitError(err);
      setError(errorMessage);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [offlineCustomInitForm, releaseCurrentEngine]);

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
      if (engineMode === 'offline') {
        const fillResult = await fillSttCustomConfigFromModelFolder(modelPath, {
          quantization: 'int8',
          modelTypeOverride: offlineCustomInitForm.modelType,
        });
        setOfflineCustomInitForm({
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
      } else {
        const fillResult = await fillStreamingCustomConfigFromFolder({
          modelSource: modelPath,
          modelType: customInitForm.modelType,
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
      }
    } catch (err) {
      setCustomFillHint(null);
      setError(formatSttInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [
    customInitForm.modelType,
    engineMode,
    offlineCustomInitForm.modelType,
    resolveModelPath,
    selectedModelForInit,
  ]);

  const prepareScatteredTest = useCallback(() => {
    setOfflineCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick each file from different locations, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    await releaseCurrentEngine();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setInitializedSummary(null);
    setCustomFillHint(null);
    setError(null);
  }, [releaseCurrentEngine]);

  const applySelectedModel = useCallback(() => {
    if (engineMode === 'streaming') {
      if (initMode === 'custom') {
        return initializeStreamingCustom();
      }
      return initializeStreamingAuto(
        selectedModelForInit ?? currentModelFolder ?? ''
      );
    }
    if (initMode === 'custom') {
      return initializeOfflineOverloadCustom();
    }
    return initializeOfflineOverloadAuto(
      selectedModelForInit ?? currentModelFolder ?? ''
    );
  }, [
    currentModelFolder,
    engineMode,
    initMode,
    initializeOfflineOverloadAuto,
    initializeOfflineOverloadCustom,
    initializeStreamingAuto,
    initializeStreamingCustom,
    selectedModelForInit,
  ]);

  const getTranscribeEngine = useCallback(():
    | LiveSttEngine
    | SttEngine
    | null => {
    if (activeEngineKind === 'offline-overload') {
      return offlineOverloadEngineRef.current;
    }
    if (activeEngineKind === 'streaming') {
      return streamingEngineRef.current;
    }
    return null;
  }, [activeEngineKind]);

  return {
    streamingEngineRef,
    offlineOverloadEngineRef,
    getTranscribeEngine,
    activeEngineKind,
    catalogEntries,
    catalogEntriesForMode,
    detectedModelIds,
    engineMode,
    setEngineMode,
    streamingModelIdSet,
    offlineCapableModelIdSet,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    offlineCustomInitForm,
    setOfflineCustomInitForm,
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
