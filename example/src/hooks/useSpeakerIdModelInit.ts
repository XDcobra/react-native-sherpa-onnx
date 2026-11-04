import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertSpeakerEmbeddingCustomConfig,
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
  type SpeakerEmbeddingCustomConfig,
  type SpeakerEmbeddingModelType,
  type SpeakerIdentificationEngine,
} from 'react-native-sherpa-onnx/speaker-identification';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearSpeakerIdCache,
  getSpeakerIdCache,
  setSpeakerIdCache,
} from '../engineCache';
import type {
  ModelInitMode,
  SpeakerIdentificationCustomInitFormState,
} from '../components/modelInit';
import { fillSidCustomConfigFromModelFolder } from '../utils/sidCustomInitFill';
import { useSpeakerEmbeddingModelCatalog } from './useSpeakerEmbeddingModelCatalog';

const NUM_THREADS = 2;

export const DEFAULT_SPEAKER_ID_CUSTOM_INIT: SpeakerIdentificationCustomInitFormState =
  {
    modelType: 'wespeaker',
    fileSources: {},
  };

export function formatSpeakerIdInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

export type UseSpeakerIdModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void | Promise<void>;
  onAfterRelease?: () => void | Promise<void>;
};

export function useSpeakerIdModelInit(
  options: UseSpeakerIdModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onEngineReadyRef = useRef(options.onEngineReady);
  onEngineReadyRef.current = options.onEngineReady;
  const onAfterReleaseRef = useRef(options.onAfterRelease);
  onAfterReleaseRef.current = options.onAfterRelease;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useSpeakerEmbeddingModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<SpeakerIdentificationCustomInitFormState>(
      DEFAULT_SPEAKER_ID_CUSTOM_INIT
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
  const [selectedModelKind, setSelectedModelKind] =
    useState<SpeakerEmbeddingModelType | null>(null);
  const [modelDim, setModelDim] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<SpeakerIdentificationEngine | null>(null);
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
    const cached = getSpeakerIdCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setSelectedModelKind(cached.selectedModelKind);
      setModelDim(cached.modelDim);
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
    clearSpeakerIdCache();
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
      setSelectedModelKind(null);
      setInitializedSummary(null);
      setModelDim(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const modelSource = await toDetectSource(modelPath);

        const detectResult = await detectSpeakerEmbeddingModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success || !detectResult.detectedModels?.length) {
          setError('No speaker-embedding models detected in the directory');
          setInitResult('Initialization failed: No compatible models found');
          return;
        }

        const modelType =
          detectResult.modelType === 'wespeaker' ||
          detectResult.modelType === '3d-speaker' ||
          detectResult.modelType === 'nemo'
            ? detectResult.modelType
            : (detectResult.detectedModels[0]
                ?.type as SpeakerEmbeddingModelType);

        const engine = await createSpeakerIdentification({
          modelSource,
          modelType,
          numThreads: NUM_THREADS,
        });

        const dim = engine.dim;
        engineRef.current = engine;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        setSelectedModelKind(modelType);
        setModelDim(dim);
        const summary = getModelDisplayName(modelFolder);
        const message = `Initialized: ${summary} (${modelType})\nDim: ${dim}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setSpeakerIdCache(engine, modelFolder, message, modelType, dim);
        await onEngineReadyRef.current?.();
      } catch (err) {
        const errorMessage = formatSpeakerIdInitError(err);
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
    setSelectedModelKind(null);
    setInitializedSummary(null);
    setModelDim(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const customConfig = { ...customInitForm.fileSources };
      assertSpeakerEmbeddingCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );

      const kind = customInitForm.modelType;
      const engine = await createSpeakerIdentification({
        initMode: 'custom',
        modelType: kind,
        customConfig: customConfig as SpeakerEmbeddingCustomConfig,
        numThreads: NUM_THREADS,
      });

      const dim = engine.dim;
      engineRef.current = engine;
      setCurrentModelFolder(null);
      setSelectedModelKind(kind);
      setModelDim(dim);
      const summary = `custom:${kind}`;
      const message = `Initialized (custom): ${kind}\nDim: ${dim}`;
      setInitializedSummary(summary);
      setInitResult(message);
      setSpeakerIdCache(engine, 'custom', message, kind, dim);
      await onEngineReadyRef.current?.();
    } catch (err) {
      const errorMessage = formatSpeakerIdInitError(err);
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
      const fillResult = await fillSidCustomConfigFromModelFolder(
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
      setError(formatSpeakerIdInitError(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick the embedding ONNX from any location, then Initialize.'
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
    clearSpeakerIdCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setInitializedSummary(null);
    setSelectedModelKind(null);
    setModelDim(null);
    setCustomFillHint(null);
    setError(null);
    await onAfterReleaseRef.current?.();
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
    selectedModelKind,
    modelDim,
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
