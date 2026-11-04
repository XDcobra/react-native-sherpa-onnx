import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  createDiarization,
  type DiarizationEngine,
} from 'react-native-sherpa-onnx/diarization';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { getModelDisplayName } from '../modelConfig';
import {
  clearDiarizationCache,
  getDiarizationCache,
  setDiarizationCache,
  type DiarizationCachedEngineInfo,
} from '../engineCache';
import type {
  DiarizationOfflineCustomInitFormState,
  ModelInitMode,
} from '../components/modelInit';
import { useDiarizationSegmentationModelCatalog } from './useDiarizationSegmentationModelCatalog';
import { useSpeakerEmbeddingModelCatalog } from './useSpeakerEmbeddingModelCatalog';

export type DiarizationEngineInitParams = {
  clusteringThreshold: number;
  numClusters: number;
  computeConfidence: boolean;
  minDurationOn: number;
  minDurationOff: number;
  windowShiftRatio: number;
  numThreads: number;
};

export type DiarizationEngineInfo = DiarizationCachedEngineInfo;

export const DEFAULT_DIARIZATION_TUNING: DiarizationEngineInitParams = {
  clusteringThreshold: 0.5,
  numClusters: 4,
  computeConfidence: false,
  minDurationOn: 0.3,
  minDurationOff: 0.5,
  windowShiftRatio: 0.25,
  numThreads: 2,
};

export const DEFAULT_DIARIZATION_CUSTOM_INIT: DiarizationOfflineCustomInitFormState =
  {};

export function formatDiarizationInitError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return code ? `[${code}] ${err.message}` : err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

export function diarizationNeedsReinit(
  engineInfo: DiarizationEngineInfo | null,
  params: DiarizationEngineInitParams
): boolean {
  if (!engineInfo) return true;
  return (
    engineInfo.numClusters !== params.numClusters ||
    engineInfo.numThreads !== params.numThreads ||
    engineInfo.threshold !== params.clusteringThreshold ||
    engineInfo.computeConfidence !== params.computeConfidence ||
    engineInfo.windowShiftRatio !== params.windowShiftRatio ||
    engineInfo.minDurationOn !== params.minDurationOn ||
    engineInfo.minDurationOff !== params.minDurationOff
  );
}

export type UseDiarizationModelInitOptions = {
  onBeforeInit?: () => void | Promise<void>;
  onEngineReady?: () => void | Promise<void>;
  onAfterRelease?: () => void | Promise<void>;
};

export function useDiarizationModelInit(
  options: UseDiarizationModelInitOptions = {}
) {
  const onBeforeInitRef = useRef(options.onBeforeInit);
  onBeforeInitRef.current = options.onBeforeInit;
  const onEngineReadyRef = useRef(options.onEngineReady);
  onEngineReadyRef.current = options.onEngineReady;
  const onAfterReleaseRef = useRef(options.onAfterRelease);
  onAfterReleaseRef.current = options.onAfterRelease;

  const segCatalog = useDiarizationSegmentationModelCatalog();
  const embCatalog = useSpeakerEmbeddingModelCatalog();

  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<DiarizationOfflineCustomInitFormState>(
      DEFAULT_DIARIZATION_CUSTOM_INIT
    );
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedSegId, setSelectedSegId] = useState<string | null>(null);
  const [selectedEmbId, setSelectedEmbId] = useState<string | null>(null);
  const [currentSegModelId, setCurrentSegModelId] = useState<string | null>(
    null
  );
  const [currentEmbModelId, setCurrentEmbModelId] = useState<string | null>(
    null
  );
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [initResult, setInitResult] = useState<string | null>(null);
  const [engineInfo, setEngineInfo] = useState<DiarizationEngineInfo | null>(
    null
  );
  const [tuning, setTuning] = useState<DiarizationEngineInitParams>(
    DEFAULT_DIARIZATION_TUNING
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<DiarizationEngine | null>(null);
  const isEngineInitialized = engineInfo != null;

  const catalogError = segCatalog.error ?? embCatalog.error;

  useEffect(() => {
    if (!catalogError) return;
    setError(catalogError);
  }, [catalogError]);

  useEffect(() => {
    if (
      selectedSegId &&
      segCatalog.entries.some((e) => e.id === selectedSegId)
    ) {
      return;
    }
    setSelectedSegId(segCatalog.entries[0]?.id ?? null);
  }, [segCatalog.entries, selectedSegId]);

  useEffect(() => {
    if (
      selectedEmbId &&
      embCatalog.entries.some((e) => e.id === selectedEmbId)
    ) {
      return;
    }
    setSelectedEmbId(embCatalog.entries[0]?.id ?? null);
  }, [embCatalog.entries, selectedEmbId]);

  useEffect(() => {
    const cached = getDiarizationCache();
    if (cached.engine != null && cached.engineInfo != null) {
      engineRef.current = cached.engine;
      setEngineInfo(cached.engineInfo);
      setTuning({
        clusteringThreshold: cached.engineInfo.threshold,
        numClusters: cached.engineInfo.numClusters,
        computeConfidence: cached.engineInfo.computeConfidence,
        minDurationOn: cached.engineInfo.minDurationOn,
        minDurationOff: cached.engineInfo.minDurationOff,
        windowShiftRatio: cached.engineInfo.windowShiftRatio,
        numThreads: cached.engineInfo.numThreads,
      });
      setCurrentSegModelId(
        cached.segModelId === 'custom' ? null : cached.segModelId
      );
      setCurrentEmbModelId(
        cached.embModelId === 'custom' ? null : cached.embModelId
      );
      setSelectedSegId(null);
      setSelectedEmbId(null);
      const segLabel =
        cached.segModelId === 'custom'
          ? 'Custom Seg'
          : getModelDisplayName(cached.segModelId ?? '');
      const embLabel =
        cached.embModelId === 'custom'
          ? 'Custom Emb'
          : getModelDisplayName(cached.embModelId ?? '');
      setInitializedSummary(`${segLabel} + ${embLabel}`);
      setInitResult(cached.initMessage);
    }
  }, []);

  const releaseCurrentEngine = useCallback(async () => {
    const previous = engineRef.current;
    if (!previous) return;
    await previous.destroy().catch(() => {});
    engineRef.current = null;
    clearDiarizationCache();
  }, []);

  const buildEngine = useCallback(
    async (
      initParams: DiarizationEngineInitParams
    ): Promise<{
      engine: DiarizationEngine;
      info: DiarizationEngineInfo;
      segModelKey: string;
      embModelKey: string;
      segLabel: string;
      embLabel: string;
    }> => {
      let segSource: FileSource;
      let embSource: FileSource;
      let segModelKey: string;
      let embModelKey: string;
      let segLabel: string;
      let embLabel: string;

      if (initMode === 'auto') {
        const segId = selectedSegId ?? currentSegModelId;
        const embId = selectedEmbId ?? currentEmbModelId;
        if (!segId) {
          throw new Error(
            'No segmentation model selected. Please select or download a model.'
          );
        }
        if (!embId) {
          throw new Error(
            'No speaker embedding model selected. Please select or download a model.'
          );
        }
        segSource = segCatalog.resolveModelPath(segId);
        embSource = embCatalog.resolveModelPath(embId);
        segModelKey = segId;
        embModelKey = embId;
        segLabel = getModelDisplayName(segId);
        embLabel = getModelDisplayName(embId);
      } else {
        if (!customInitForm.segmentationSource) {
          throw new Error('Please select a custom segmentation model (.onnx).');
        }
        if (!customInitForm.embeddingSource) {
          throw new Error(
            'Please select a custom speaker embedding model (.onnx).'
          );
        }
        segSource = customInitForm.segmentationSource;
        embSource = customInitForm.embeddingSource;
        segModelKey = 'custom';
        embModelKey = 'custom';
        segLabel = 'Custom Seg';
        embLabel = 'Custom Emb';
      }

      const engine = await createDiarization({
        segmentation: {
          modelSource: segSource,
          windowShiftRatio: initParams.windowShiftRatio,
        },
        embedding: {
          modelSource: embSource,
        },
        clustering: {
          numClusters:
            initParams.numClusters > 0 ? initParams.numClusters : undefined,
          threshold: initParams.clusteringThreshold,
          computeConfidence: initParams.computeConfidence,
        },
        minDurationOn: initParams.minDurationOn,
        minDurationOff: initParams.minDurationOff,
        numThreads: initParams.numThreads,
      });

      const sampleRate =
        typeof engine.sampleRate === 'number' && engine.sampleRate > 0
          ? engine.sampleRate
          : 16000;

      const info: DiarizationEngineInfo = {
        sampleRate,
        segId: segLabel,
        embId: embLabel,
        numClusters: initParams.numClusters,
        threshold: initParams.clusteringThreshold,
        computeConfidence: initParams.computeConfidence,
        numThreads: initParams.numThreads,
        windowShiftRatio: initParams.windowShiftRatio,
        minDurationOn: initParams.minDurationOn,
        minDurationOff: initParams.minDurationOff,
      };

      return {
        engine,
        info,
        segModelKey,
        embModelKey,
        segLabel,
        embLabel,
      };
    },
    [
      currentEmbModelId,
      currentSegModelId,
      customInitForm.embeddingSource,
      customInitForm.segmentationSource,
      embCatalog,
      initMode,
      segCatalog,
      selectedEmbId,
      selectedSegId,
    ]
  );

  const initializeEngine = useCallback(
    async (initParams: DiarizationEngineInitParams) => {
      setLoading(true);
      setError(null);
      setInitResult(null);
      setInitializedSummary(null);
      setEngineInfo(null);
      await onBeforeInitRef.current?.();

      try {
        await releaseCurrentEngine();
        const built = await buildEngine(initParams);
        engineRef.current = built.engine;
        setEngineInfo(built.info);
        setTuning(initParams);
        if (initMode === 'auto') {
          setCurrentSegModelId(built.segModelKey);
          setCurrentEmbModelId(built.embModelKey);
          setSelectedSegId(built.segModelKey);
          setSelectedEmbId(built.embModelKey);
        } else {
          setCurrentSegModelId(null);
          setCurrentEmbModelId(null);
        }
        const summary = `${built.segLabel} + ${built.embLabel}`;
        const message = `Initialized: ${summary} (computeConfidence=${initParams.computeConfidence})`;
        setInitializedSummary(summary);
        setInitResult(message);
        setDiarizationCache(
          built.engine,
          built.segModelKey,
          built.embModelKey,
          message,
          built.info
        );
        await onEngineReadyRef.current?.();
        return built.engine;
      } catch (err) {
        const errorMessage = formatDiarizationInitError(err);
        setError(errorMessage);
        setInitResult(`Initialization failed: ${errorMessage}`);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [buildEngine, initMode, releaseCurrentEngine]
  );

  const ensureEngineReady = useCallback(
    async (initParams: DiarizationEngineInitParams) => {
      if (
        engineRef.current &&
        engineInfo &&
        !diarizationNeedsReinit(engineInfo, initParams)
      ) {
        return engineRef.current;
      }
      return initializeEngine(initParams);
    },
    [engineInfo, initializeEngine]
  );

  const fillSegmentationFromCatalog = useCallback(async () => {
    const modelId = selectedSegId;
    if (!modelId) {
      Alert.alert(
        'Select a model',
        'Pick a segmentation catalog folder first.'
      );
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const source = segCatalog.resolveModelPath(modelId);
      setCustomInitForm((prev) => ({
        ...prev,
        segmentationSource: source,
      }));
      setCustomFillHint(
        `Segmentation filled from ${getModelDisplayName(modelId)}.`
      );
    } catch (fillErr) {
      setCustomFillHint(null);
      setError(formatDiarizationInitError(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [segCatalog, selectedSegId]);

  const fillEmbeddingFromCatalog = useCallback(async () => {
    const modelId = selectedEmbId;
    if (!modelId) {
      Alert.alert(
        'Select a model',
        'Pick a speaker-embedding catalog folder first.'
      );
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    try {
      const source = embCatalog.resolveModelPath(modelId);
      setCustomInitForm((prev) => ({
        ...prev,
        embeddingSource: source,
      }));
      setCustomFillHint(
        `Embedding filled from ${getModelDisplayName(modelId)}.`
      );
    } catch (fillErr) {
      setCustomFillHint(null);
      setError(formatDiarizationInitError(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [embCatalog, selectedEmbId]);

  const prepareScatteredTest = useCallback(() => {
    setCustomInitForm({});
    setCustomFillHint(
      'Scattered test: pick segmentation and embedding ONNX files from any location, then Initialize.'
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
    clearDiarizationCache();
    setCurrentSegModelId(null);
    setCurrentEmbModelId(null);
    setSelectedSegId(null);
    setSelectedEmbId(null);
    setInitResult(null);
    setInitializedSummary(null);
    setEngineInfo(null);
    setCustomFillHint(null);
    setError(null);
    await onAfterReleaseRef.current?.();
  }, []);

  const applySelectedModel = useCallback(() => {
    return initializeEngine(tuning);
  }, [initializeEngine, tuning]);

  const patchTuning = useCallback(
    (patch: Partial<DiarizationEngineInitParams>) => {
      setTuning((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const updateEngineInfoAfterRecluster = useCallback(
    (patch: Partial<DiarizationEngineInitParams>) => {
      setEngineInfo((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          numClusters: patch.numClusters ?? prev.numClusters,
          threshold: patch.clusteringThreshold ?? prev.threshold,
          computeConfidence: patch.computeConfidence ?? prev.computeConfidence,
        };
        const cached = getDiarizationCache();
        if (cached.engine && cached.segModelId && cached.embModelId) {
          setDiarizationCache(
            cached.engine,
            cached.segModelId,
            cached.embModelId,
            cached.initMessage,
            next
          );
        }
        return next;
      });
      setTuning((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  return {
    engineRef,
    segCatalogEntries: segCatalog.entries,
    embCatalogEntries: embCatalog.entries,
    loadingSegCatalog: segCatalog.loading,
    loadingEmbCatalog: embCatalog.loading,
    initMode,
    setInitMode,
    customInitForm,
    setCustomInitForm,
    customFillLoading,
    customFillHint,
    selectedSegId,
    setSelectedSegId,
    selectedEmbId,
    setSelectedEmbId,
    currentSegModelId,
    currentEmbModelId,
    initializedSummary,
    initResult,
    engineInfo,
    tuning,
    patchTuning,
    loading,
    error,
    setError,
    isEngineInitialized,
    applySelectedModel,
    ensureEngineReady,
    fillSegmentationFromCatalog,
    fillEmbeddingFromCatalog,
    prepareScatteredTest,
    releaseEngine,
    updateEngineInfoAfterRecluster,
  };
}
