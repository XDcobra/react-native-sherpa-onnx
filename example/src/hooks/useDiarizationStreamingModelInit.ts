import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  createStreamingDiarization,
  detectDiarizationModel,
  type StreamingDiarizationEngine,
} from 'react-native-sherpa-onnx/diarization';
import { getModelDisplayName } from '../modelConfig';
import {
  clearDiarizationStreamingCache,
  getDiarizationStreamingCache,
  setDiarizationStreamingCache,
  type DiarizationStreamingCachedEngineInfo,
} from '../engineCache';
import type {
  DiarizationStreamingCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import { fillDiarizationStreamingCustomConfigFromModelFolder } from '../utils/diarizationCustomInitFill';
import { formatDiarizationInitError } from './useDiarizationModelInit';
import { useDiarizationStreamingModelCatalog } from './useDiarizationStreamingModelCatalog';

export const DEFAULT_STREAMING_DIARIZATION_CUSTOM_INIT: DiarizationStreamingCustomInitFormState =
  {
    fileSources: {},
  };

export type DiarizationStreamingLatencyProfile =
  | 'low'
  | 'ultra_low'
  | 'default'
  | 'custom';

export type DiarizationStreamingEngineInfo =
  DiarizationStreamingCachedEngineInfo;

export type UseDiarizationStreamingModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void;
};

export const CHUNK_SIZE_OPTIONS = [1024, 2048, 4096, 8192] as const;

function buildLatencyConfig(
  latencyProfile: DiarizationStreamingLatencyProfile,
  custom: { chunkLen: number; rightContext: number; fifoLen: number }
): { chunkLen: number; rightContext: number; fifoLen: number } {
  if (latencyProfile === 'low') {
    return { chunkLen: 6, rightContext: 7, fifoLen: 188 };
  }
  if (latencyProfile === 'ultra_low') {
    return { chunkLen: 3, rightContext: 1, fifoLen: 188 };
  }
  if (latencyProfile === 'default') {
    return { chunkLen: 124, rightContext: 1, fifoLen: 124 };
  }
  return {
    chunkLen: custom.chunkLen,
    rightContext: custom.rightContext,
    fifoLen: custom.fifoLen,
  };
}

function engineInfoFromInstance(
  engine: StreamingDiarizationEngine
): DiarizationStreamingEngineInfo {
  return {
    instanceId: engine.instanceId,
    sampleRate: engine.sampleRate,
    maxSpeakers: engine.maxSpeakers,
    feedSamples: engine.feedSamples,
    strideSamples: engine.strideSamples,
    latencySeconds: engine.latencySeconds,
  };
}

export function useDiarizationStreamingModelInit(
  options: UseDiarizationStreamingModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onEngineReadyRef = useRef(options.onEngineReady);
  onEngineReadyRef.current = options.onEngineReady;

  const {
    entries: catalogEntries,
    loading: loadingModels,
    error: catalogError,
    resolveModelPath,
  } = useDiarizationStreamingModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<DiarizationStreamingCustomInitFormState>(
      DEFAULT_STREAMING_DIARIZATION_CUSTOM_INIT
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
  const [engineInfo, setEngineInfo] =
    useState<DiarizationStreamingEngineInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latencyProfile, setLatencyProfile] =
    useState<DiarizationStreamingLatencyProfile>('low');
  const [customChunkLen, setCustomChunkLen] = useState(6);
  const [customRightContext, setCustomRightContext] = useState(7);
  const [customFifoLen, setCustomFifoLen] = useState(188);
  const [onset, setOnset] = useState(0.5);
  const [offset, setOffset] = useState(0.5);
  const [minDurationOff, setMinDurationOff] = useState(0.5);
  const [minDurationOn, setMinDurationOn] = useState(0.0);
  const [chunkSize, setChunkSize] = useState<number>(4096);

  const engineRef = useRef<StreamingDiarizationEngine | null>(null);
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
    const cached = getDiarizationStreamingCache();
    if (cached.engine != null && cached.engineInfo != null) {
      engineRef.current = cached.engine;
      setEngineInfo(cached.engineInfo);
      setSelectedModelForInit(null);
      setCurrentModelFolder(
        cached.modelFolder === 'custom' ? null : cached.modelFolder
      );
      setInitializedSummary(
        cached.modelFolder === 'custom'
          ? 'custom:sortformer'
          : getModelDisplayName(cached.modelFolder ?? '')
      );
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.release().catch(() => {});
    engineRef.current = null;
    clearDiarizationStreamingCache();
  }, []);

  const buildCreateOptions = useCallback(() => {
    const latencyConfig = buildLatencyConfig(latencyProfile, {
      chunkLen: customChunkLen,
      rightContext: customRightContext,
      fifoLen: customFifoLen,
    });
    return {
      modelType: 'sortformer' as const,
      onset,
      offset,
      minDurationOff,
      minDurationOn,
      ...latencyConfig,
    };
  }, [
    customChunkLen,
    customFifoLen,
    customRightContext,
    latencyProfile,
    minDurationOff,
    minDurationOn,
    offset,
    onset,
  ]);

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
      setEngineInfo(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const modelPath = resolveModelPath(modelFolder);
        const det = await detectDiarizationModel(modelPath);
        if (!det.success || !det.isStreaming) {
          throw new Error(
            `Model ${modelFolder} is not a valid streaming diarization model: ${
              det.error ?? 'Unknown'
            }`
          );
        }

        const engine = await createStreamingDiarization({
          modelSource: modelPath,
          ...buildCreateOptions(),
        });
        engineRef.current = engine;
        const info = engineInfoFromInstance(engine);
        setEngineInfo(info);
        setCurrentModelFolder(modelFolder);
        setSelectedModelForInit(modelFolder);
        const summary = getModelDisplayName(modelFolder);
        const message = `Ready: ${summary} (instance ${engine.instanceId})`;
        setInitializedSummary(summary);
        setInitResult(message);
        setDiarizationStreamingCache(engine, modelFolder, message, info);
        onEngineReadyRef.current?.();
      } catch (err) {
        console.error('Streaming diarization initialization error:', err);
        const errorMessage = formatDiarizationInitError(err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    },
    [buildCreateOptions, releaseCurrentEngine, resolveModelPath]
  );

  const initializeCustom = useCallback(async () => {
    if (!customInitForm.fileSources.model) {
      Alert.alert('Custom config', 'Pick a Sortformer ONNX model file first.');
      return;
    }
    setLoading(true);
    setError(null);
    setInitResult(null);
    setInitializedSummary(null);
    setEngineInfo(null);
    await onBeforeInitRef.current?.();

    try {
      await releaseCurrentEngine();
      const engine = await createStreamingDiarization({
        initMode: 'custom',
        customConfig: {
          model: customInitForm.fileSources.model,
          metadata: customInitForm.fileSources.metadata,
        },
        ...buildCreateOptions(),
      });
      engineRef.current = engine;
      const info = engineInfoFromInstance(engine);
      setEngineInfo(info);
      setCurrentModelFolder(null);
      const summary = 'custom:sortformer';
      const message = `Ready: custom sortformer (instance ${engine.instanceId})`;
      setInitializedSummary(summary);
      setInitResult(message);
      setDiarizationStreamingCache(engine, 'custom', message, info);
      onEngineReadyRef.current?.();
    } catch (err) {
      console.error('Streaming diarization custom initialization error:', err);
      const errorMessage = formatDiarizationInitError(err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [buildCreateOptions, customInitForm, releaseCurrentEngine]);

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
        await fillDiarizationStreamingCustomConfigFromModelFolder(modelPath);
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
      setError(formatDiarizationInitError(err));
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm({ fileSources: {} });
    setCustomFillHint(
      'Scattered test: pick Sortformer ONNX and metadata separately, then Initialize.'
    );
  }, []);

  const releaseEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) {
      try {
        await engine.release();
      } catch (err) {
        console.error(
          'useDiarizationStreamingModelInit: Failed to release:',
          err
        );
      }
      engineRef.current = null;
    }
    clearDiarizationStreamingCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setInitResult(null);
    setInitializedSummary(null);
    setEngineInfo(null);
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
    engineInfo,
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
    latencyProfile,
    setLatencyProfile,
    customChunkLen,
    setCustomChunkLen,
    customRightContext,
    setCustomRightContext,
    customFifoLen,
    setCustomFifoLen,
    onset,
    setOnset,
    offset,
    setOffset,
    minDurationOff,
    setMinDurationOff,
    minDurationOn,
    setMinDurationOn,
    chunkSize,
    setChunkSize,
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
