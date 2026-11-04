import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertEnhancementCustomConfig,
  createStreamingEnhancement,
  detectEnhancementModel,
  type EnhancementConcreteModelType,
  type StreamingEnhancementEngine,
} from 'react-native-sherpa-onnx/enhancement';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearEnhancementStreamingCache,
  getEnhancementStreamingCache,
  setEnhancementStreamingCache,
} from '../engineCache';
import type {
  EnhancementCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import type { EngineMode } from '../components/EngineModeModelSelector';
import {
  buildEnhancementAutoInitializeOptions,
  buildEnhancementCustomInitializeOptions,
  enhancementLoadedKindFromDetect,
  fillEnhancementCustomConfigFromModelFolder,
} from '../utils/enhancementCustomInitFill';
import { useEnhancementStreamingModelCatalog } from './useEnhancementStreamingModelCatalog';
import {
  DEFAULT_ENHANCEMENT_CUSTOM_INIT,
  formatEnhancementInitError,
} from './useEnhancementModelInit';

const NUM_THREADS = 2;

export type UseEnhancementStreamingModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void;
};

export function useEnhancementStreamingModelInit(
  options: UseEnhancementStreamingModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onEngineReadyRef = useRef(options.onEngineReady);
  onEngineReadyRef.current = options.onEngineReady;

  const {
    entries: catalogEntries,
    detectedModelIds,
    streamingModelIds,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useEnhancementStreamingModelCatalog();

  const streamingModelIdSet = useMemo(
    () => new Set(streamingModelIds),
    [streamingModelIds]
  );
  const offlineCapableModelIdSet = useMemo(
    () => new Set(detectedModelIds),
    [detectedModelIds]
  );

  const [engineMode, setEngineMode] = useState<EngineMode>('streaming');
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<EnhancementCustomInitFormState>(DEFAULT_ENHANCEMENT_CUSTOM_INIT);
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
    Array<{ type: string; modelDir: string }>
  >([]);
  const [selectedModelKind, setSelectedModelKind] =
    useState<EnhancementConcreteModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<StreamingEnhancementEngine | null>(null);
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
    const cached = getEnhancementStreamingCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setDetectedModels(cached.detectedModels);
      setSelectedModelKind(cached.selectedModelKind);
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? `custom:${cached.selectedModelKind ?? 'unknown'}`
          : getModelDisplayName(cached.modelFolder)
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    engineRef.current = null;
    clearEnhancementStreamingCache();
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
      setSelectedModelKind(null);
      setInitializedSummary(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const modelSource = await toDetectSource(modelPath);

        const detectResult = await detectEnhancementModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success || !detectResult.detectedModels?.length) {
          setError('No enhancement models detected in the directory');
          setInitResult('Initialization failed: No compatible models found');
          return;
        }
        if (!detectResult.isStreaming) {
          setError(
            'Selected model is offline-only. Choose a model that supports streaming enhancement.'
          );
          setInitResult(
            'Initialization failed: model is not streaming-capable'
          );
          return;
        }

        const engine = await createStreamingEnhancement({
          modelSource,
          numThreads: NUM_THREADS,
          modelType: 'auto',
        });

        const normalized = detectResult.detectedModels.map((m) => ({
          type: m.type,
          modelDir: m.modelDir,
        }));
        const loadedKind = enhancementLoadedKindFromDetect(
          detectResult.modelType,
          normalized
        );

        engineRef.current = engine;
        setDetectedModels(normalized);
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        if (loadedKind) {
          setSelectedModelKind(loadedKind);
        }
        const summary = getModelDisplayName(modelFolder);
        const types = normalized.map((m) => m.type).join(', ');
        const message = `Initialized streaming: ${summary}\nDetected: ${types}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setEnhancementStreamingCache(
          engine,
          modelFolder,
          message,
          normalized,
          loadedKind
        );
        onEngineReadyRef.current?.();
      } catch (err) {
        const errorMessage = formatEnhancementInitError(err);
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
    setSelectedModelKind(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const customConfig = {
        ...customInitForm.fileSources,
      };
      assertEnhancementCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );

      const engine = await createStreamingEnhancement(
        buildEnhancementCustomInitializeOptions(
          customInitForm.modelType,
          customConfig as Record<string, unknown>,
          { numThreads: NUM_THREADS }
        )
      );

      const kind = customInitForm.modelType;
      const normalized = [{ type: kind, modelDir: 'custom' }];
      engineRef.current = engine;
      setCurrentModelFolder(null);
      setSelectedModelKind(kind);
      setDetectedModels(normalized);
      const summary = `custom:${kind}`;
      const message = `Initialized streaming (custom): ${kind}\nFile: model`;
      setInitializedSummary(summary);
      setInitResult(message);
      setEnhancementStreamingCache(engine, 'custom', message, normalized, kind);
      onEngineReadyRef.current?.();
    } catch (err) {
      const errorMessage = formatEnhancementInitError(err);
      setError(errorMessage);
      setInitResult(`Custom initialization failed: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [
    customInitForm.fileSources,
    customInitForm.modelType,
    releaseCurrentEngine,
  ]);

  const reinitWithKind = useCallback(
    async (kind: EnhancementConcreteModelType) => {
      if (!currentModelFolder) return;
      setSelectedModelKind(kind);
      const folder = currentModelFolder;
      setLoading(true);
      setError(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(folder);
        const modelSource = await toDetectSource(modelPath);
        const detectResult = await detectEnhancementModel(modelSource, {
          modelType: kind,
        });
        if (!detectResult.success || !detectResult.detectedModels?.length) {
          setError('No enhancement models detected for the selected type');
          return;
        }
        if (!detectResult.isStreaming) {
          setError(
            'Selected architecture is not streaming-capable in this model directory.'
          );
          return;
        }

        const engine = await createStreamingEnhancement(
          buildEnhancementAutoInitializeOptions(modelSource, kind, {
            numThreads: NUM_THREADS,
          })
        );
        const normalized = detectResult.detectedModels.map((m) => ({
          type: m.type,
          modelDir: m.modelDir,
        }));
        engineRef.current = engine;
        setDetectedModels(normalized);
        const message = `Initialized streaming: ${getModelDisplayName(
          folder
        )} (${kind.toUpperCase()})`;
        setInitResult(message);
        setEnhancementStreamingCache(engine, folder, message, normalized, kind);
        onEngineReadyRef.current?.();
      } catch (e) {
        setError(formatEnhancementInitError(e));
      } finally {
        setLoading(false);
      }
    },
    [currentModelFolder, releaseCurrentEngine, resolveModelPath]
  );

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
      const fillResult = await fillEnhancementCustomConfigFromModelFolder(
        await toDetectSource(modelPath),
        { modelTypeOverride: customInitForm.modelType }
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
    } catch (fillErr) {
      setCustomFillHint(null);
      setError(formatEnhancementInitError(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick the model file from a different location, then Initialize.'
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
    clearEnhancementStreamingCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setInitializedSummary(null);
    setDetectedModels([]);
    setSelectedModelKind(null);
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
    engineMode,
    setEngineMode,
    streamingModelIdSet,
    offlineCapableModelIdSet,
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
    selectedModelKind,
    loading,
    error,
    setError,
    isEngineInitialized,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
    reinitWithKind,
  };
}
