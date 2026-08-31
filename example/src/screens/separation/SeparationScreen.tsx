import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createSeparation,
  detectSeparationModel,
  assertSeparationCustomConfig,
  SEPARATION_STEM_LABELS,
  type SeparationEngine,
  type SeparationModelType,
  type SeparationPipelineHandle,
  type SpleeterCustomConfig,
  type UvrCustomConfig,
} from 'react-native-sherpa-onnx/separation';
import {
  createEmptyOfflineAudioBuffer,
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromLive,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  subscribeLiveAudioBufferEvents,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import type { SpeechSegment } from 'react-native-sherpa-onnx/segment';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { styles as baseStyles } from '../stt/STTScreen.styles';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { PipelineOfflineAudioResultCard } from '../../components/PipelineOfflineAudioResultCard';
import {
  InitModeSelector,
  ModelFolderGrid,
  SeparationCustomInitForm,
  type ModelInitMode,
  type SeparationCustomInitFormState,
} from '../../components/modelInit';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES } from '../../audioConfig';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import { fillSeparationCustomConfigFromModelFolder } from '../../utils/separationCustomInitFill';

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;
const PIPELINE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

type ProcessingMode = 'batch' | 'liveOverload';
type LiveSourceMode = 'file' | 'mic';
type LiveFileSourceType = 'example' | 'own';

type StemResult = {
  bufferId: string;
  label: string;
  sampleRate: number;
  numSamples: number;
};

const DEFAULT_SEPARATION_CUSTOM_INIT: SeparationCustomInitFormState = {
  modelType: 'spleeter',
  fileSources: {},
};

const LIVE_SEG_DEFAULT: SegmentationControlConfig = {
  mode: 'auto',
  policy: { evaluator: 'continuous_frames', checkpointIntervalMs: 500 },
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `[${code}] ${error.message}` : error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

function isSeparationHint(folder: string, hint: string): boolean {
  if (hint === 'separation') return true;
  const n = folder.toLowerCase();
  return n.includes('spleeter') || n.includes('uvr') || n.includes('mdx');
}

function stemLabel(index: number, numStems: number): string {
  if (numStems <= 2 && index < SEPARATION_STEM_LABELS.length) {
    return SEPARATION_STEM_LABELS[index]!;
  }
  return `Stem ${index}`;
}

export default function SeparationScreen() {
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('batch');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<SeparationCustomInitFormState>(DEFAULT_SEPARATION_CUSTOM_INIT);
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [initializedSummary, setInitializedSummary] = useState<string | null>(
    null
  );
  const [selectedModelKind, setSelectedModelKind] =
    useState<SeparationModelType | null>(null);
  const [numStems, setNumStems] = useState(2);
  const [modelSampleRate, setModelSampleRate] = useState<number | null>(null);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<
    'init' | 'separate' | 'live' | null
  >(null);

  const [segBatchConfig, setSegBatchConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [segLiveConfig, setSegLiveConfig] =
    useState<SegmentationControlConfig>(LIVE_SEG_DEFAULT);

  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [separating, setSeparating] = useState(false);
  const [separateResult, setSeparateResult] = useState<string | null>(null);
  const [stemResults, setStemResults] = useState<StemResult[]>([]);

  const [liveSourceMode, setLiveSourceMode] = useState<LiveSourceMode>('file');
  const [liveFileSourceType, setLiveFileSourceType] =
    useState<LiveFileSourceType>('example');
  const [selectedExampleAudioId, setSelectedExampleAudioId] = useState(
    AUDIO_FILES[0]?.id ?? ''
  );
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<number | null>(null);
  const [liveSeparationProgress, setLiveSeparationProgress] = useState<
    number | null
  >(null);
  const [liveSeparationSamplesWritten, setLiveSeparationSamplesWritten] =
    useState(0);
  const [liveTotalInputFrames, setLiveTotalInputFrames] = useState(0);
  const [liveSegmentsProcessed, setLiveSegmentsProcessed] = useState(0);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveRunState, setLiveRunState] = useState<
    'idle' | 'running' | 'stopping'
  >('idle');
  const [liveSegmentLog, setLiveSegmentLog] = useState<string[]>([]);

  const engineRef = useRef<SeparationEngine | null>(null);
  const pipelineRef = useRef<SeparationPipelineHandle | null>(null);
  const liveInRef = useRef<LiveAudioBufferRef | null>(null);
  const liveOutRefs = useRef<LiveAudioBufferRef[]>([]);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const liveUsingMicRef = useRef(false);
  const cleanupLockRef = useRef(false);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const stemResultsRef = useRef<StemResult[]>([]);
  const totalInputFramesRef = useRef(0);
  const liveSeparationSamplesWrittenRef = useRef(0);
  const liveOutputEventsUnsubRef = useRef<(() => void) | null>(null);

  const stopLiveOutputEvents = useCallback(() => {
    liveOutputEventsUnsubRef.current?.();
    liveOutputEventsUnsubRef.current = null;
  }, []);

  const handleSeparationOutputFrames = useCallback(
    (totalSamplesWritten: number) => {
      liveSeparationSamplesWrittenRef.current = totalSamplesWritten;
      setLiveSeparationSamplesWritten(totalSamplesWritten);
      const total = totalInputFramesRef.current;
      if (total > 0) {
        setLiveSeparationProgress(
          Math.min(100, (totalSamplesWritten / total) * 100)
        );
      }
    },
    []
  );

  useEffect(() => {
    stemResultsRef.current = stemResults;
  }, [stemResults]);

  const clearStemResults = useCallback(async () => {
    const current = stemResultsRef.current;
    stemResultsRef.current = [];
    setStemResults([]);
    for (const stem of current) {
      await releasePipelineAudioBuffer(stem.bufferId).catch(() => {});
    }
  }, []);

  const releaseLiveBuffers = useCallback(async () => {
    const liveOuts = liveOutRefs.current;
    liveOutRefs.current = [];
    for (const out of liveOuts) {
      await releasePipelineAudioBuffer(out.bufferId).catch(() => {});
    }
    const liveIn = liveInRef.current;
    liveInRef.current = null;
    if (liveIn) {
      await releasePipelineAudioBuffer(liveIn.bufferId).catch(() => {});
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    setErrorSource(null);
    try {
      const assetModels = await listAssetModels();
      const separationFolders = assetModels
        .filter((m) => isSeparationHint(m.folder, m.hint))
        .map((m) => m.folder);
      const downloadedModels = await listDownloadedModels(
        ModelCategory.Separation
      );
      const downloadedFolders = downloadedModels.map((model) => model.id);

      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => isSeparationHint(m.folder, m.hint))
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch (loadPadErr) {
        console.warn(
          'SeparationScreen: PAD/listModelsAtPath failed',
          loadPadErr
        );
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);

      const combined = [
        ...padFolders,
        ...separationFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !separationFolders.includes(f)
        ),
      ];
      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      setAvailableModels(combined);

      if (combined.length === 0) {
        setErrorSource('init');
        setError(
          'No separation models found. Add a Spleeter or UVR model as a bundled asset, downloaded model, or PAD model.'
        );
      }
    } catch (loadErr) {
      console.error('SeparationScreen: Failed to load models:', loadErr);
      setErrorSource('init');
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadAvailableModels().catch(() => {});
    const unsubscribe = onModelsListUpdated((category) => {
      if (category === ModelCategory.Separation) {
        loadAvailableModels().catch(() => {});
      }
    });
    return unsubscribe;
  }, [loadAvailableModels]);

  const resolveSeparationModelPath = useCallback(
    (modelFolder: string) => {
      if (padModelIds.includes(modelFolder)) {
        return padModelsPath
          ? getFileModelPath(
              modelFolder,
              ModelCategory.Separation,
              padModelsPath
            )
          : getFileModelPath(modelFolder, ModelCategory.Separation);
      }
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Separation);
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds, padModelIds, padModelsPath]
  );

  const catalogEntries = useMemo(
    () =>
      availableModels.map((id) => ({
        id,
        label: getModelDisplayName(id),
      })),
    [availableModels]
  );

  const cleanupLiveRuntime = useCallback(async () => {
    if (cleanupLockRef.current) {
      return;
    }
    cleanupLockRef.current = true;
    try {
      stopLiveOutputEvents();
      totalInputFramesRef.current = 0;
      setLiveTotalInputFrames(0);
      try {
        ingestHandleRef.current?.cancel();
      } catch {
        // ignore teardown races
      }
      ingestHandleRef.current = null;

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore teardown races
      }
      liveUsingMicRef.current = false;

      try {
        await pipelineRef.current?.stop();
      } catch {
        // ignore teardown races
      }
      pipelineRef.current = null;

      const liveOuts = liveOutRefs.current;
      liveOutRefs.current = [];
      for (const out of liveOuts) {
        await releasePipelineAudioBuffer(out.bufferId).catch(() => {});
      }

      const liveIn = liveInRef.current;
      liveInRef.current = null;
      if (liveIn) {
        await releasePipelineAudioBuffer(liveIn.bufferId).catch(() => {});
      }
    } finally {
      cleanupLockRef.current = false;
    }
  }, [stopLiveOutputEvents]);

  useEffect(() => {
    return () => {
      cleanupLiveRuntime().catch(() => {});
      const stems = stemResultsRef.current;
      stemResultsRef.current = [];
      for (const stem of stems) {
        releasePipelineAudioBuffer(stem.bufferId).catch(() => {});
      }
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) {
        engine.destroy().catch(() => {});
      }
    };
  }, [cleanupLiveRuntime]);

  const handleFillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelForInit;
    if (!modelFolder) {
      Alert.alert('Select a model', 'Pick a catalog model folder first.');
      return;
    }

    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    setErrorSource(null);
    try {
      const modelPath = resolveSeparationModelPath(modelFolder);
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
      setErrorSource('init');
      setError(normalizeErrorMessage(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [
    customInitForm.modelType,
    resolveSeparationModelPath,
    selectedModelForInit,
  ]);

  const handlePrepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick stem files from different locations, then Initialize.'
    );
  }, []);

  const applyEngineMetadata = useCallback(async (engine: SeparationEngine) => {
    const stems = await engine.getNumStems();
    const sr = await engine.getSampleRate();
    setNumStems(stems);
    setModelSampleRate(sr);
    return { stems, sr };
  }, []);

  const handleInitializeCustom = async () => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setInitializedSummary(null);
    setSelectedModelKind(null);

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }
      await clearStemResults();

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

      engineRef.current = engine;
      const { stems, sr } = await applyEngineMetadata(engine);
      setCurrentModelFolder(null);
      setSelectedModelKind(customInitForm.modelType);
      setInitializedSummary(`custom:${customInitForm.modelType}`);
      setInitResult(
        `Initialized (custom): ${customInitForm.modelType}\nStems: ${stems}\nSample rate: ${sr} Hz`
      );
      setSeparateResult(null);
    } catch (initErr) {
      setErrorSource('init');
      setError(normalizeErrorMessage(initErr));
      setInitResult(
        `Custom initialization failed: ${normalizeErrorMessage(initErr)}`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setInitializedSummary(null);
    setSelectedModelKind(null);

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }
      await clearStemResults();

      const modelPath = resolveSeparationModelPath(modelFolder);
      const modelSource = await toDetectSource(modelPath);

      const detectResult = await detectSeparationModel(modelSource, {
        modelType: 'auto',
      });
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        setErrorSource('init');
        setError('No separation models detected in the directory');
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

      engineRef.current = engine;
      const { stems, sr } = await applyEngineMetadata(engine);
      setCurrentModelFolder(modelFolder);
      setSelectedModelKind(modelType);
      setInitializedSummary(modelFolder);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )} (${modelType})\nStems: ${stems}\nSample rate: ${sr} Hz`
      );
      setSeparateResult(null);
    } catch (initErr) {
      setErrorSource('init');
      setError(normalizeErrorMessage(initErr));
      setInitResult(`Initialization failed: ${normalizeErrorMessage(initErr)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFree = async () => {
    await cleanupLiveRuntime();
    await clearStemResults();
    const engine = engineRef.current;
    if (engine) {
      await engine.destroy().catch(() => {});
    }
    engineRef.current = null;
    setCurrentModelFolder(null);
    setInitializedSummary(null);
    setSelectedModelForInit(null);
    setSelectedModelKind(null);
    setInitResult(null);
    setModelSampleRate(null);
    setNumStems(2);
    setSeparateResult(null);
    setLiveStatus(null);
    setLiveProgress(null);
    setLiveSegmentLog([]);
    setLiveRunState('idle');
    setError(null);
    setErrorSource(null);
    await offlineWidgetRef.current?.clear();
    setPreparedInputBuffer(null);
  };

  const handleSeparateBatch = async () => {
    if (!engineRef.current) {
      setErrorSource('separate');
      setError('Initialize a separation model first.');
      return;
    }
    const prepared = preparedInputBuffer;
    if (!prepared) {
      setErrorSource('separate');
      setError('Select audio and wait until OfflineAudioBuffer is ready.');
      return;
    }

    setSeparating(true);
    setError(null);
    setErrorSource(null);
    setSeparateResult(null);
    await clearStemResults();

    try {
      const engine = engineRef.current;
      const stems = await engine.getNumStems();
      const sr = await engine.getSampleRate();
      const outs = await Promise.all(
        Array.from({ length: stems }, () => createEmptyOfflineAudioBuffer(sr))
      );

      const segOption = buildSegmentationOption(segBatchConfig);
      const result = await engine.separate(
        prepared.bufferId,
        outs.map((out) => out.bufferId),
        {
          segmentation: segOption,
          ...(segBatchConfig.mode !== 'off'
            ? {
                errorRecovery: 'partial_result' as const,
                overlapSamples: Math.round(sr * 0.02),
              }
            : {}),
        }
      );

      const nextStems: StemResult[] = [];
      for (let i = 0; i < stems; i++) {
        const out = outs[i]!;
        const info = await getPipelineAudioBufferInfo(out.bufferId);
        const n = info.numSamples ?? 0;
        const outSr = info.sampleRate ?? sr;
        nextStems.push({
          bufferId: out.bufferId,
          label: stemLabel(i, stems),
          sampleRate: outSr,
          numSamples: n,
        });
      }
      setStemResults(nextStems);

      const inInfo = await getPipelineAudioBufferInfo(prepared.bufferId);
      const inSamples = inInfo.numSamples ?? 0;
      const durationSec =
        sr > 0 && inSamples > 0 ? (inSamples / sr).toFixed(2) : '?';
      setSeparateResult(
        `Mode: offline batch\nSegmentation: ${segBatchConfig.mode}\nStatus: ${result.status}\nSegments: ${result.completedSegments}/${result.totalSegments}\nSkipped: ${result.skippedSegments.length}\nInput duration: ~${durationSec} s\nProcessing: ${result.processingTimeMs} ms`
      );
    } catch (batchErr) {
      setErrorSource('separate');
      setError(normalizeErrorMessage(batchErr));
    } finally {
      setSeparating(false);
    }
  };

  const finalizeLiveStemResults = useCallback(
    async (sr: number, stems: number) => {
      const liveOuts = liveOutRefs.current;
      const nextStems: StemResult[] = [];
      for (let i = 0; i < stems; i++) {
        const liveOut = liveOuts[i];
        if (!liveOut) continue;
        await finalizeLiveAudioBuffer(liveOut.bufferId).catch(() => {});
        const offline = await createOfflineAudioBufferFromLive(
          liveOut.bufferId,
          'fullIfSpooled'
        );
        const info = await getPipelineAudioBufferInfo(offline.bufferId);
        const n = info.kind === 'offlinePcmBuffer' ? info.numSamples : 0;
        const outSr = info.sampleRate ?? sr;
        nextStems.push({
          bufferId: offline.bufferId,
          label: stemLabel(i, stems),
          sampleRate: outSr,
          numSamples: n,
        });
      }
      setStemResults(nextStems);
      return nextStems;
    },
    []
  );

  const waitForPipelineCompletion = useCallback(
    async (pipeline: SeparationPipelineHandle) => {
      return new Promise<Awaited<typeof pipeline.completed>>(
        (resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Separation pipeline timeout after ${PIPELINE_WAIT_TIMEOUT_MS}ms`
              )
            );
          }, PIPELINE_WAIT_TIMEOUT_MS);

          pipeline.completed.then(
            (result) => {
              clearTimeout(timeoutId);
              resolve(result);
            },
            (pipelineError) => {
              clearTimeout(timeoutId);
              reject(pipelineError);
            }
          );
        }
      );
    },
    []
  );

  const resolveLiveFileSource = useCallback((): FileSource => {
    if (liveFileSourceType === 'own') {
      if (!selectedFileUri) {
        throw new Error('Pick an audio file first.');
      }
      return toFileSource(selectedFileUri, selectedFileName ?? undefined);
    }
    const example = AUDIO_FILES.find((f) => f.id === selectedExampleAudioId);
    if (!example) {
      throw new Error('Select example audio first.');
    }
    return fileSourceFromBundledPath(example.id);
  }, [
    liveFileSourceType,
    selectedExampleAudioId,
    selectedFileName,
    selectedFileUri,
  ]);

  const handleSeparateLive = async () => {
    if (!engineRef.current) {
      setErrorSource('live');
      setError('Initialize a separation model first.');
      return;
    }
    if (liveSourceMode === 'file') {
      if (liveFileSourceType === 'own' && !selectedFileUri) {
        setErrorSource('live');
        setError('Pick an audio file first.');
        return;
      }
    }

    const segOption = buildSegmentationOption(segLiveConfig);
    if (
      !segOption ||
      segOption.mode === 'off' ||
      !segOption.policy ||
      segOption.policy.evaluator !== 'continuous_frames'
    ) {
      setErrorSource('live');
      setError('Live overload requires continuous_frames segmentation.');
      return;
    }

    setLiveRunState('running');
    setError(null);
    setErrorSource(null);
    setSeparateResult(null);
    setLiveProgress(null);
    setLiveSeparationProgress(null);
    setLiveSeparationSamplesWritten(0);
    liveSeparationSamplesWrittenRef.current = 0;
    setLiveTotalInputFrames(0);
    setLiveSegmentsProcessed(0);
    setLiveSegmentLog([]);
    await clearStemResults();
    await cleanupLiveRuntime();

    try {
      const engine = engineRef.current;
      const stems = await engine.getNumStems();
      const sr = await engine.getSampleRate();

      const liveIn = await createEmptyLiveAudioBuffer({
        sampleRate: sr,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      const liveOuts = await Promise.all(
        Array.from({ length: stems }, () =>
          createEmptyLiveAudioBuffer({
            sampleRate: sr,
            channelCount: 1,
            ringSeconds: 240,
            retention: 'auto',
            streamEvents: {
              framesAppended: { enabled: true, minIntervalMs: 0 },
            },
          })
        )
      );
      liveInRef.current = liveIn;
      liveOutRefs.current = liveOuts;

      const stem0 = liveOuts[0];
      if (stem0) {
        stopLiveOutputEvents();
        liveOutputEventsUnsubRef.current = subscribeLiveAudioBufferEvents(
          stem0.bufferId,
          {
            onFramesAppended: (event) => {
              if (
                event.appendKind !== 'pipeline' ||
                event.pipelineWriter !== 'separation'
              ) {
                return;
              }
              handleSeparationOutputFrames(event.totalSamplesWritten);
            },
          }
        );
      }

      let segmentEventCount = 0;
      const pipeline = await engine.separate(
        liveIn.bufferId,
        liveOuts.map((out) => out.bufferId),
        {
          segmentation: {
            mode: 'auto',
            policy: segOption.policy as typeof segOption.policy & {
              evaluator: 'continuous_frames';
            },
          },
          onSegment: (segment: SpeechSegment) => {
            segmentEventCount += 1;
            setLiveSegmentsProcessed(segmentEventCount);
            setLiveSegmentLog((prev) => {
              const line = `seg #${segment.segmentIndex} (${segment.reason})`;
              return [...prev.slice(-4), line];
            });
          },
        }
      );
      pipelineRef.current = pipeline;
      setLiveStatus('Separation pipeline running…');

      if (liveSourceMode === 'file') {
        const source = resolveLiveFileSource();
        const ingest = await ingestFileToLiveAudioBuffer(
          liveIn.bufferId,
          source,
          {
            targetSampleRateHz: sr,
            forceMono: true,
            autoFinalize: true,
            backpressure: 'block',
            onProgress: (event) => {
              setLiveProgress(event.percent);
              setLiveStatus(
                `Decoding ${event.percent.toFixed(
                  0
                )}% • ${event.framesDecoded.toLocaleString()} frames`
              );
            },
          }
        );
        ingestHandleRef.current = ingest;
        const ingestResult = await ingest.done;
        ingestHandleRef.current = null;
        totalInputFramesRef.current = ingestResult.totalFramesIngested;
        setLiveTotalInputFrames(ingestResult.totalFramesIngested);
        setLiveProgress(100);
        setLiveStatus(
          `Decode complete • ${ingestResult.totalFramesIngested.toLocaleString()} frames ingested. Separating stems…`
        );

        const completion = await waitForPipelineCompletion(pipeline);
        stopLiveOutputEvents();
        pipelineRef.current = null;
        await pipeline.stop().catch(() => {});

        const finalized = await finalizeLiveStemResults(sr, stems);
        const totalSamples = finalized.reduce(
          (sum, s) => sum + s.numSamples,
          0
        );
        setSeparateResult(
          `Mode: live overload (file)\nSegmentation: ${segLiveConfig.mode} / continuous_frames\nPipeline: ${completion.reason}\nSegment events: ${segmentEventCount}\nOutput samples (all stems): ${totalSamples}\nSample rate: ${sr} Hz`
        );
        setLiveStatus('Live separation completed.');
        await releaseLiveBuffers();
        setLiveRunState('idle');
        setLiveProgress(null);
        setLiveSeparationProgress(null);
        setLiveSeparationSamplesWritten(0);
        setLiveTotalInputFrames(0);
        setLiveSegmentsProcessed(0);
      } else {
        ingestHandleRef.current = null;
        await startMicToLiveAudioBuffer(liveIn, { emitToJs: false });
        liveUsingMicRef.current = true;
        setLiveStatus(
          'Microphone active. Tap Stop when finished to finalize and collect stems.'
        );
      }
    } catch (liveErr) {
      setErrorSource('live');
      setError(normalizeErrorMessage(liveErr));
      setLiveStatus('Live separation failed.');
      await cleanupLiveRuntime();
      setLiveRunState('idle');
    }
  };

  const stopLiveSeparation = useCallback(async () => {
    if (liveRunState !== 'running') {
      return;
    }
    setLiveRunState('stopping');
    setLiveStatus('Stopping live separation…');

    try {
      const pipeline = pipelineRef.current;
      const engine = engineRef.current;
      if (!pipeline || !engine) {
        throw new Error('Live pipeline is not active.');
      }

      if (liveUsingMicRef.current) {
        try {
          await stopMicToLiveAudioBuffer();
        } catch {
          // ignore mic stop races
        }
        liveUsingMicRef.current = false;
      } else {
        try {
          ingestHandleRef.current?.cancel();
        } catch {
          // ignore ingest cancel races
        }
        ingestHandleRef.current = null;
      }

      const liveIn = liveInRef.current;
      if (liveIn) {
        await finalizeLiveAudioBuffer(liveIn.bufferId);
        const inInfo = await getPipelineAudioBufferInfo(liveIn.bufferId);
        if (inInfo.kind === 'livePcmBuffer') {
          totalInputFramesRef.current = inInfo.numSamples;
          setLiveTotalInputFrames(inInfo.numSamples);
          handleSeparationOutputFrames(liveSeparationSamplesWrittenRef.current);
        }
        setLiveStatus('Input finalized. Separating remaining segments…');
      }

      const completion = await waitForPipelineCompletion(pipeline);
      stopLiveOutputEvents();
      pipelineRef.current = null;
      await pipeline.stop().catch(() => {});

      const stems = await engine.getNumStems();
      const sr = await engine.getSampleRate();
      const finalized = await finalizeLiveStemResults(sr, stems);
      const totalSamples = finalized.reduce((sum, s) => sum + s.numSamples, 0);
      setSeparateResult(
        `Mode: live overload (${liveSourceMode})\nSegmentation: ${segLiveConfig.mode} / continuous_frames\nPipeline: ${completion.reason}\nOutput samples (all stems): ${totalSamples}\nSample rate: ${sr} Hz`
      );
      setLiveStatus('Live separation completed.');
    } catch (stopErr) {
      setErrorSource('live');
      setError(normalizeErrorMessage(stopErr));
      setLiveStatus('Live separation stop failed.');
    } finally {
      stopLiveOutputEvents();
      await releaseLiveBuffers();
      setLiveRunState('idle');
      setLiveProgress(null);
      setLiveSeparationProgress(null);
      setLiveSeparationSamplesWritten(0);
      setLiveTotalInputFrames(0);
      setLiveSegmentsProcessed(0);
    }
  }, [
    finalizeLiveStemResults,
    handleSeparationOutputFrames,
    liveRunState,
    liveSourceMode,
    releaseLiveBuffers,
    segLiveConfig.mode,
    stopLiveOutputEvents,
    waitForPipelineCompletion,
  ]);

  const pickFile = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (result) {
        const resolvedName =
          resolveAudioFileDisplayName(result.uri, result.name) ??
          result.name ??
          result.uri;
        setSelectedFileUri(result.uri);
        setSelectedFileName(resolvedName);
        setLiveFileSourceType('own');
      }
    } catch (pickErr) {
      const isPickCancel =
        (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
          pickErr
        ) ||
        (pickErr as { code?: string })?.code === 'DOCUMENT_PICKER_CANCELED' ||
        (pickErr as { name?: string })?.name === 'DocumentPickerCanceled';
      if (!isPickCancel) {
        setErrorSource('live');
        setError(normalizeErrorMessage(pickErr));
      }
    }
  }, []);

  const canInitAuto =
    initMode === 'auto' && !!selectedModelForInit && !loading && !separating;
  const canInitCustom =
    initMode === 'custom' &&
    Object.keys(customInitForm.fileSources).length > 0 &&
    !loading &&
    !separating;

  const engineReady = !!engineRef.current && !!initializedSummary;
  const liveBusy = liveRunState !== 'idle';

  const canRunBatch =
    processingMode === 'batch' &&
    engineReady &&
    !!preparedInputBuffer &&
    !separating &&
    !liveBusy;

  const canRunLive =
    processingMode === 'liveOverload' &&
    engineReady &&
    liveRunState === 'idle' &&
    (liveSourceMode === 'mic' ||
      (liveFileSourceType === 'example' && !!selectedExampleAudioId) ||
      (liveFileSourceType === 'own' && !!selectedFileUri));

  return (
    <SafeAreaView
      style={screenStyles.container}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView contentContainerStyle={screenStyles.content}>
        <View style={screenStyles.headerRow}>
          <View style={screenStyles.headerIconWrap}>
            <Ionicons name="musical-notes" size={20} color="#0F62FE" />
          </View>
          <Text style={screenStyles.headerTitle}>Source Separation</Text>
        </View>
        <Text style={screenStyles.bodyText}>
          Offline batch (1→N stems) and live overload with segmentation.
        </Text>

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Processing mode</Text>
          <View style={lpStyles.sourceToggle}>
            {(
              [
                ['batch', 'Offline batch'],
                ['liveOverload', 'Live overload'],
              ] as const
            ).map(([mode, label]) => (
              <TouchableOpacity
                key={mode}
                style={[
                  lpStyles.sourceToggleBtn,
                  processingMode === mode && lpStyles.sourceToggleBtnActive,
                ]}
                onPress={() => {
                  if (liveBusy || separating) return;
                  setProcessingMode(mode);
                }}
                disabled={liveBusy || separating}
              >
                <Text
                  style={[
                    lpStyles.sourceToggleText,
                    processingMode === mode && lpStyles.sourceToggleTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Model</Text>
          <InitModeSelector
            value={initMode}
            onChange={setInitMode}
            disabled={loading || separating || liveBusy}
          />

          {initMode === 'auto' ? (
            <>
              <ModelFolderGrid
                entries={catalogEntries}
                selectedId={selectedModelForInit}
                initializedId={currentModelFolder}
                onSelect={setSelectedModelForInit}
                loading={loadingModels}
                disabled={loading || separating || liveBusy}
                emptyMessage="No separation models found."
              />
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
                  !canInitAuto && screenStyles.buttonDisabled,
                ]}
                onPress={() => {
                  if (selectedModelForInit) {
                    handleInitialize(selectedModelForInit).catch(() => {});
                  }
                }}
                disabled={!canInitAuto}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={screenStyles.primaryButtonText}>
                    Initialize model
                  </Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <SeparationCustomInitForm
                value={customInitForm}
                onChange={setCustomInitForm}
                selectedCatalogModelId={selectedModelForInit}
                onFillFromSelectedModel={() => {
                  handleFillFromSelectedModel().catch(() => {});
                }}
                onPrepareScatteredTest={handlePrepareScatteredTest}
                fillLoading={customFillLoading}
                disabled={loading || separating || liveBusy}
                fillHint={customFillHint}
              />
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
                  !canInitCustom && screenStyles.buttonDisabled,
                ]}
                onPress={() => {
                  handleInitializeCustom().catch(() => {});
                }}
                disabled={!canInitCustom}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={screenStyles.primaryButtonText}>
                    Initialize (custom)
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {initializedSummary ? (
            <Text style={baseStyles.currentModelText}>
              Ready: {initializedSummary}
              {modelSampleRate != null
                ? ` • ${numStems} stem(s) @ ${modelSampleRate} Hz`
                : ''}
            </Text>
          ) : null}
          {initResult ? (
            <Text style={screenStyles.monoResultText}>{initResult}</Text>
          ) : null}
          {engineReady ? (
            <TouchableOpacity
              style={baseStyles.secondaryButton}
              onPress={() => {
                handleFree().catch(() => {});
              }}
              disabled={loading || separating || liveBusy}
            >
              <Text style={baseStyles.secondaryButtonText}>Release engine</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Segmentation</Text>
          {processingMode === 'batch' ? (
            <SegmentationPolicyControls
              variant="speech-offline"
              value={segBatchConfig}
              onChange={setSegBatchConfig}
              disabled={separating || liveBusy}
            />
          ) : (
            <>
              <Text style={screenStyles.bodyText}>
                Live overload requires continuous_frames segmentation. Off and
                manual modes are disabled.
              </Text>
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segLiveConfig}
                onChange={setSegLiveConfig}
                disabled={liveBusy}
                disableOff
                disableManual
                allowedEvaluators={['continuous_frames']}
                offDisabledMessage="Live separation overload requires mandatory segmentation with continuous_frames."
              />
            </>
          )}
        </View>

        {processingMode === 'batch' ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Input (offline)</Text>
            <OfflineAudioBufferWidget
              ref={offlineWidgetRef}
              audioFiles={AUDIO_FILES}
              visible={engineReady}
              disabled={!engineReady || separating || liveBusy}
              decodeTargetSampleRateHz={modelSampleRate ?? undefined}
              onBufferReady={setPreparedInputBuffer}
              onBufferReleased={() => {
                setPreparedInputBuffer(null);
                setSeparateResult(null);
                clearStemResults().catch(() => {});
              }}
            />
            <TouchableOpacity
              style={[
                screenStyles.primaryButton,
                !canRunBatch && screenStyles.buttonDisabled,
              ]}
              onPress={() => {
                handleSeparateBatch().catch(() => {});
              }}
              disabled={!canRunBatch}
            >
              {separating ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={screenStyles.primaryButtonText}>
                  Run separation
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Input (live)</Text>
            <View style={lpStyles.sourceToggle}>
              {(['file', 'mic'] as LiveSourceMode[]).map((mode) => (
                <TouchableOpacity
                  key={mode}
                  style={[
                    lpStyles.sourceToggleBtn,
                    liveSourceMode === mode && lpStyles.sourceToggleBtnActive,
                  ]}
                  onPress={() => setLiveSourceMode(mode)}
                  disabled={liveBusy}
                >
                  <Text
                    style={[
                      lpStyles.sourceToggleText,
                      liveSourceMode === mode &&
                        lpStyles.sourceToggleTextActive,
                    ]}
                  >
                    {mode === 'mic' ? 'Microphone' : 'File'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {liveSourceMode === 'file' && (
              <>
                <View style={localStyles.exampleRow}>
                  {AUDIO_FILES.slice(0, 4).map((audioFile) => {
                    const active = selectedExampleAudioId === audioFile.id;
                    return (
                      <TouchableOpacity
                        key={audioFile.id}
                        style={[
                          localStyles.exampleChip,
                          active && localStyles.exampleChipActive,
                        ]}
                        onPress={() => {
                          setLiveFileSourceType('example');
                          setSelectedExampleAudioId(audioFile.id);
                        }}
                        disabled={liveBusy}
                      >
                        <Text
                          style={[
                            localStyles.exampleChipText,
                            active && localStyles.exampleChipTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          {audioFile.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {!selectedFileUri ? (
                  <TouchableOpacity
                    style={lpStyles.optionButton}
                    onPress={() => {
                      pickFile().catch(() => {});
                    }}
                    disabled={liveBusy}
                  >
                    <Text style={lpStyles.optionButtonText}>
                      Pick audio file…
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View style={screenStyles.selectedFileCard}>
                    <View style={screenStyles.selectedFileInfo}>
                      <Text style={screenStyles.selectedFileLabel}>
                        Selected file
                      </Text>
                      <Text
                        style={screenStyles.selectedFileName}
                        numberOfLines={2}
                      >
                        {selectedFileName ?? selectedFileUri}
                      </Text>
                    </View>
                    <Pressable
                      style={screenStyles.removeFileButton}
                      onPress={() => {
                        if (liveBusy) return;
                        setSelectedFileUri(null);
                        setSelectedFileName(null);
                      }}
                      disabled={liveBusy}
                    >
                      <Text style={screenStyles.removeFileButtonText}>
                        Clear
                      </Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

            {liveSourceMode === 'mic' && liveRunState === 'running' ? (
              <Text style={screenStyles.bodyText}>
                Recording into the live buffer. Tap Stop when you are done
                speaking or playing source audio near the mic.
              </Text>
            ) : null}

            {liveProgress != null ? (
              <Text style={screenStyles.bodyText}>
                Decode progress: {liveProgress.toFixed(0)}%
              </Text>
            ) : null}
            {liveSeparationProgress != null ? (
              <Text style={screenStyles.bodyText}>
                Separation progress: {liveSeparationProgress.toFixed(0)}%
              </Text>
            ) : liveSeparationSamplesWritten > 0 ? (
              <Text style={screenStyles.bodyText}>
                Separation output:{' '}
                {liveSeparationSamplesWritten.toLocaleString()} samples
              </Text>
            ) : null}
            {liveSegmentsProcessed > 0 ? (
              <Text style={screenStyles.monoResultText}>
                Segments processed: {liveSegmentsProcessed}
                {liveTotalInputFrames > 0
                  ? ` • stem0=${liveSeparationSamplesWritten.toLocaleString()} / ${liveTotalInputFrames.toLocaleString()} samples`
                  : ''}
              </Text>
            ) : null}
            {liveStatus ? (
              <Text style={screenStyles.bodyText}>{liveStatus}</Text>
            ) : null}
            {liveSegmentLog.length > 0 ? (
              <Text style={screenStyles.monoResultText}>
                {liveSegmentLog.join('\n')}
              </Text>
            ) : null}

            {liveRunState === 'running' && liveSourceMode === 'mic' ? (
              <TouchableOpacity
                style={[lpStyles.runButton, lpStyles.runButtonStop]}
                onPress={() => {
                  stopLiveSeparation().catch(() => {});
                }}
              >
                <Text style={lpStyles.runButtonText}>Stop</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[
                  lpStyles.runButton,
                  !canRunLive && lpStyles.runButtonDisabled,
                ]}
                onPress={() => {
                  handleSeparateLive().catch(() => {});
                }}
                disabled={!canRunLive}
              >
                <Text style={lpStyles.runButtonText}>Run separation</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {error ? (
          <View style={baseStyles.errorContainer}>
            <Text style={baseStyles.errorLabel}>
              {errorSource === 'init'
                ? 'Initialization error'
                : errorSource === 'live'
                ? 'Live separation error'
                : 'Separation error'}
            </Text>
            <Text style={baseStyles.errorText}>{error}</Text>
          </View>
        ) : null}

        {separateResult ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Result</Text>
            <Text style={screenStyles.monoResultText}>{separateResult}</Text>
          </View>
        ) : null}

        {stemResults.length > 0 ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Separated stems</Text>
            {stemResults.map((stem) => {
              const durationMs =
                stem.sampleRate > 0
                  ? Math.round((stem.numSamples / stem.sampleRate) * 1000)
                  : 0;
              return (
                <PipelineOfflineAudioResultCard
                  key={stem.bufferId}
                  bufferId={stem.bufferId}
                  sourceLabel={stem.label}
                  sampleRate={stem.sampleRate}
                  durationMs={durationMs}
                  onDismiss={() => {
                    releasePipelineAudioBuffer(stem.bufferId)
                      .catch(() => {})
                      .finally(() => {
                        setStemResults((prev) =>
                          prev.filter((s) => s.bufferId !== stem.bufferId)
                        );
                      });
                  }}
                  disabled={separating || liveBusy}
                />
              );
            })}
          </View>
        ) : null}

        {selectedModelKind ? (
          <Text style={screenStyles.footerHint}>
            Model type: {selectedModelKind} • Expect {numStems} output stem
            {numStems === 1 ? '' : 's'}
          </Text>
        ) : null}
      </ScrollView>
      <ScreenIntroModal screenId="Separation" />
    </SafeAreaView>
  );
}

const localStyles = StyleSheet.create({
  exampleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginVertical: 8,
  },
  exampleChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#C7C7CC',
    backgroundColor: '#F2F2F7',
    maxWidth: '48%',
  },
  exampleChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  exampleChipText: {
    fontSize: 12,
    color: '#3A3A3C',
  },
  exampleChipTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
});

const screenStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    gap: 14,
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 2,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E8F1FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '800',
    color: '#111827',
    flex: 1,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  bodyText: {
    marginTop: 4,
    marginBottom: 8,
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  monoResultText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#1F2937',
    fontFamily: 'Menlo',
  },
  primaryButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  selectedFileCard: {
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  selectedFileInfo: {
    flex: 1,
  },
  selectedFileLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  selectedFileName: {
    fontSize: 14,
    lineHeight: 20,
    color: '#111827',
    fontWeight: '600',
  },
  removeFileButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#FFF5F4',
    borderWidth: 1,
    borderColor: '#F4C7C3',
  },
  removeFileButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#B42318',
  },
  footerHint: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 4,
  },
});
