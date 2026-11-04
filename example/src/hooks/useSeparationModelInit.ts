import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertSeparationCustomConfig,
  createSeparation,
  detectSeparationModel,
  type SeparationEngine,
  type SeparationModelType,
  type SpleeterCustomConfig,
  type UvrCustomConfig,
} from 'react-native-sherpa-onnx/separation';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import {
  clearSeparationCache,
  getSeparationCache,
  setSeparationCache,
} from '../engineCache';
import type {
  ModelInitMode,
  SeparationCustomInitFormState,
} from '../components/modelInit';
import { fillSeparationCustomConfigFromModelFolder } from '../utils/separationCustomInitFill';
import { useSeparationModelCatalog } from './useSeparationModelCatalog';

const NUM_THREADS = 2;

export const DEFAULT_SEPARATION_CUSTOM_INIT: SeparationCustomInitFormState = {
  modelType: 'spleeter',
  fileSources: {},
};

export function formatSeparationInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

export type UseSeparationModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void;
  onAfterRelease?: () => void | Promise<void>;
};

async function readEngineMetadata(engine: SeparationEngine): Promise<{
  stems: number;
  sr: number;
}> {
  const stems = await engine.getNumStems();
  const sr = await engine.getSampleRate();
  return { stems, sr };
}

export function useSeparationModelInit(
  options: UseSeparationModelInitOptions = {}
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
  } = useSeparationModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<SeparationCustomInitFormState>(DEFAULT_SEPARATION_CUSTOM_INIT);
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
    useState<SeparationModelType | null>(null);
  const [numStems, setNumStems] = useState(2);
  const [modelSampleRate, setModelSampleRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<SeparationEngine | null>(null);
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
    const cached = getSeparationCache();
    if (cached.engine != null && cached.modelFolder != null) {
      engineRef.current = cached.engine;
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setSelectedModelKind(cached.selectedModelKind);
      setNumStems(cached.numStems ?? 2);
      setModelSampleRate(cached.modelSampleRate);
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
    clearSeparationCache();
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
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const modelSource = await toDetectSource(modelPath);

        const detectResult = await detectSeparationModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success || !detectResult.detectedModels?.length) {
          setError('No separation models detected in the directory');
          setInitResult('Initialization failed: No compatible models found');
          return;
        }

        const modelType =
          detectResult.modelType === 'spleeter' ||
          detectResult.modelType === 'uvr'
            ? detectResult.modelType
            : (detectResult.detectedModels[0]?.type as SeparationModelType);

        const engine = await createSeparation({
          modelSource,
          modelType,
          numThreads: NUM_THREADS,
        });

        const { stems, sr } = await readEngineMetadata(engine);
        engineRef.current = engine;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        setSelectedModelKind(modelType);
        setNumStems(stems);
        setModelSampleRate(sr);
        const summary = getModelDisplayName(modelFolder);
        const message = `Initialized: ${summary} (${modelType})\nStems: ${stems}\nSample rate: ${sr} Hz`;
        setInitializedSummary(summary);
        setInitResult(message);
        setSeparationCache(engine, modelFolder, message, modelType, stems, sr);
        onEngineReadyRef.current?.();
      } catch (err) {
        const errorMessage = formatSeparationInitError(err);
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
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const customConfig = { ...customInitForm.fileSources };
      assertSeparationCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );

      const engine =
        customInitForm.modelType === 'spleeter'
          ? await createSeparation({
              initMode: 'custom',
              modelType: 'spleeter',
              customConfig: customConfig as SpleeterCustomConfig,
              numThreads: NUM_THREADS,
            })
          : await createSeparation({
              initMode: 'custom',
              modelType: 'uvr',
              customConfig: customConfig as UvrCustomConfig,
              numThreads: NUM_THREADS,
            });

      const kind = customInitForm.modelType;
      const { stems, sr } = await readEngineMetadata(engine);
      engineRef.current = engine;
      setCurrentModelFolder(null);
      setSelectedModelKind(kind);
      setNumStems(stems);
      setModelSampleRate(sr);
      const summary = `custom:${kind}`;
      const message = `Initialized (custom): ${kind}\nStems: ${stems}\nSample rate: ${sr} Hz`;
      setInitializedSummary(summary);
      setInitResult(message);
      setSeparationCache(engine, 'custom', message, kind, stems, sr);
      onEngineReadyRef.current?.();
    } catch (err) {
      const errorMessage = formatSeparationInitError(err);
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
      const fillResult = await fillSeparationCustomConfigFromModelFolder(
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
      setError(formatSeparationInitError(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick stem files from different locations, then Initialize.'
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
    clearSeparationCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setInitializedSummary(null);
    setSelectedModelKind(null);
    setModelSampleRate(null);
    setNumStems(2);
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
    numStems,
    modelSampleRate,
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
