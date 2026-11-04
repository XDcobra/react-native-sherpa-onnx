import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  assertVadCustomConfig,
  createStreamingVAD,
  detectVadModel,
  type VADEngine,
  type VADModelType,
  type VADRuntimeOptions,
} from 'react-native-sherpa-onnx/vad';
import { getModelDisplayName, toDetectSource } from '../modelConfig';
import { clearVadCache, getVadCache, setVadCache } from '../engineCache';
import type {
  ModelInitMode,
  VadCustomInitFormState,
} from '../components/modelInit';
import { fillVadCustomConfigFromModelFolder } from '../utils/vadCustomInitFill';
import { useVadModelCatalog } from './useVadModelCatalog';

export const DEFAULT_VAD_CUSTOM_INIT: VadCustomInitFormState = {
  modelType: 'silero_vad',
  fileSources: {},
};

export function formatVadInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  if (typeof err === 'object' && err !== null) {
    const maybe = err as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return typeof err === 'string' ? err : String(err);
}

function buildVadRuntimeOptions(
  modelType: VADModelType,
  threshold: number
): VADRuntimeOptions {
  return modelType === 'ten_vad'
    ? {
        tenVad: {
          scoreThreshold: Number.isFinite(threshold) ? threshold : undefined,
        },
      }
    : {
        sileroVad: {
          scoreThreshold: Number.isFinite(threshold) ? threshold : undefined,
        },
      };
}

function parseSampleRate(input: string): number {
  return Math.max(8000, Number.parseInt(input, 10) || 16000);
}

function parseThreshold(input: string): number {
  const value = Number.parseFloat(input);
  return Number.isFinite(value) ? value : 0.5;
}

async function detectResolvedModelType(
  modelPath: Awaited<ReturnType<typeof toDetectSource>>
): Promise<VADModelType> {
  const detection = await detectVadModel(modelPath, {
    modelType: 'auto',
  });
  if (!detection.success || !detection.modelType) {
    throw new Error(
      detection.error ||
        'Unable to detect VAD model type for selected model folder.'
    );
  }
  if (
    detection.modelType !== 'silero_vad' &&
    detection.modelType !== 'ten_vad'
  ) {
    throw new Error(
      `Unsupported detected VAD model type: ${detection.modelType}`
    );
  }
  return detection.modelType;
}

export type UseVadModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
};

export function useVadModelInit(options: UseVadModelInitOptions = {}) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
    reload: reloadCatalog,
  } = useVadModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<VadCustomInitFormState>(
    DEFAULT_VAD_CUSTOM_INIT
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
  const [sampleRateInput, setSampleRateInput] = useState('16000');
  const [thresholdInput, setThresholdInput] = useState('0.5');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<VADEngine | null>(null);
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
    const cached = getVadCache();
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
    await previous.destroy().catch(() => {});
    engineRef.current = null;
    clearVadCache();
  }, []);

  const initializeAuto = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        Alert.alert('Select a model', 'Pick a VAD model folder first.');
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
        const resolvedModelType = await detectResolvedModelType(detectSource);
        const sampleRate = parseSampleRate(sampleRateInput);
        const threshold = parseThreshold(thresholdInput);
        const eng = await createStreamingVAD({
          modelSource: modelPath,
          modelType: resolvedModelType,
          sampleRate,
          runtimeOptions: buildVadRuntimeOptions(resolvedModelType, threshold),
        });
        engineRef.current = eng;
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message =
          `Initialized (auto): ${summary}\n` +
          `Detected: ${resolvedModelType} · streaming=true\n` +
          `sampleRate=${sampleRate} · threshold=${threshold}\n` +
          `instance: ${eng.instanceId}`;
        setInitializedSummary(summary);
        setInitResult(message);
        setVadCache(eng, modelFolder, message);
      } catch (err) {
        const errorMessage = formatVadInitError(err);
        setError(errorMessage);
        setInitResult(null);
      } finally {
        setLoading(false);
      }
    },
    [releaseCurrentEngine, resolveModelPath, sampleRateInput, thresholdInput]
  );

  const initializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const modelSource = customInitForm.fileSources.model;
      if (!modelSource) {
        throw new Error('Pick a VAD model file for custom init.');
      }
      const customConfig = { model: modelSource };
      assertVadCustomConfig(customConfig as unknown as Record<string, unknown>);
      const sampleRate = parseSampleRate(sampleRateInput);
      const threshold = parseThreshold(thresholdInput);
      const modelType = customInitForm.modelType;
      const eng = await createStreamingVAD({
        initMode: 'custom',
        modelType,
        customConfig,
        sampleRate,
        runtimeOptions: buildVadRuntimeOptions(modelType, threshold),
      });
      engineRef.current = eng;
      setCurrentModelFolder(null);
      const summary = selectedModelForInit
        ? getModelDisplayName(selectedModelForInit)
        : 'custom paths';
      const message =
        `Initialized (custom): ${summary}\n` +
        `Detected: ${modelType} · streaming=true\n` +
        `sampleRate=${sampleRate} · threshold=${threshold}\n` +
        `instance: ${eng.instanceId}`;
      setInitializedSummary(summary);
      setInitResult(message);
      setVadCache(eng, 'custom', message);
    } catch (err) {
      const errorMessage = formatVadInitError(err);
      setError(errorMessage);
      setInitResult(null);
    } finally {
      setLoading(false);
    }
  }, [
    customInitForm.fileSources.model,
    customInitForm.modelType,
    releaseCurrentEngine,
    sampleRateInput,
    selectedModelForInit,
    thresholdInput,
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
      const fillResult = await fillVadCustomConfigFromModelFolder(modelPath, {
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
      setError(formatVadInitError(err));
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
    clearVadCache();
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
    sampleRateInput,
    setSampleRateInput,
    thresholdInput,
    setThresholdInput,
    loading,
    error,
    setError,
    isEngineInitialized,
    applySelectedModel,
    fillFromSelectedModel,
    prepareScatteredTest,
    releaseEngine,
    reloadCatalog,
    parseSampleRate,
    parseThreshold,
  };
}
