import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  assertAudioTaggingCustomConfig,
  createAudioTagging,
  detectAudioTaggingModel,
  DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY,
  type AudioTaggingCustomConfig,
  type AudioTaggingEngine,
  type AudioTaggingLiveSegmentEvent,
  type AudioTaggingModelType,
  type AudioTaggingPipelineHandle,
  type AudioTaggingResult,
  type SegmentedAudioTaggingResult,
} from 'react-native-sherpa-onnx/audio-tagging';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { styles as baseStyles } from '../stt/STTScreen.styles';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  ExampleAudioFileList,
  type OfflineAudioBufferInfo,
} from '../../components/OfflineAudioBufferWidget';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import {
  InitModeSelector,
  ModelFolderGrid,
  AudioTaggingCustomInitForm,
  type ModelInitMode,
  type AudioTaggingCustomInitFormState,
} from '../../components/modelInit';
import { getModelDisplayName, toDetectSource } from '../../modelConfig';
import {
  AUDIO_TAGGING_AUDIO_FILES,
  TEST_AUDIO_TAGGING_FILES,
  type AudioFileId,
} from '../../audioConfig';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import { fillAudioTaggingCustomConfigFromModelFolder } from '../../utils/audioTaggingCustomInitFill';
import {
  getAudioTaggingModelPathConfig,
  loadAudioTaggingModelCatalog,
  type AudioTaggingCatalogSnapshot,
} from '../../utils/audioTaggingModelCatalog';
import type { RootStackParamList } from '../../types/navigation';
import { colorForEvent, styles } from './AudioTaggingScreen.styles';

const NUM_THREADS = 2;
const LIVE_SAMPLE_RATE = 16000;
const TOP_K_OPTIONS = [3, 5, 10] as const;
const AT_OFFLINE_EVALUATORS = ['speech_energy_silence'] as const;
const AT_LIVE_EVALUATORS = [
  'speech_energy_silence',
  'continuous_frames',
] as const;

type ProcessingMode = 'batch' | 'liveOverload';
type LiveSourceMode = 'file' | 'mic';
type LiveFileSourceType = 'example' | 'own';
type PathCtx = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

const EMPTY_CATALOG: AudioTaggingCatalogSnapshot = {
  entries: [],
  padModelIds: [],
  padModelsPath: null,
  bundledFolders: [],
  downloadedIds: [],
};
const DEFAULT_CUSTOM_INIT: AudioTaggingCustomInitFormState = {
  modelType: 'ced',
  fileSources: {},
};
const LIVE_SEG_DEFAULT: SegmentationControlConfig = {
  mode: 'auto',
  policy: { ...DEFAULT_AUDIO_TAGGING_SEGMENTATION_POLICY },
};
const DEFAULT_EXAMPLE_ID: AudioFileId =
  (AUDIO_TAGGING_AUDIO_FILES[0]?.id as AudioFileId | undefined) ??
  TEST_AUDIO_TAGGING_FILES.CAT;

function errMsg(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `[${code}] ${error.message}` : error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0.0s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatProb(prob: number): string {
  return `${(prob * 100).toFixed(0)}%`;
}

function isSegmentedResult(
  result: AudioTaggingResult | SegmentedAudioTaggingResult
): result is SegmentedAudioTaggingResult {
  return (
    'segments' in result &&
    'totalSegments' in result &&
    'processingTimeMs' in result
  );
}

function EventDistBars({ events }: { events: AudioTaggingResult['events'] }) {
  if (events.length === 0) {
    return <Text style={styles.sectionHint}>No events.</Text>;
  }
  return (
    <>
      {events.map((ev, index) => (
        <View key={`${ev.index}_${ev.name}_${index}`} style={styles.distRow}>
          <Text style={styles.distLabel} numberOfLines={1}>
            {ev.name}
          </Text>
          <View style={styles.distTrack}>
            <View
              style={[
                styles.distFill,
                {
                  width: `${Math.max(2, Math.round(ev.prob * 100))}%`,
                  backgroundColor: colorForEvent(ev.name, index),
                },
              ]}
            />
          </View>
          <Text style={styles.distPct}>{formatProb(ev.prob)}</Text>
        </View>
      ))}
    </>
  );
}

function ModeToggle<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <View style={lpStyles.sourceToggle}>
      {options.map(([mode, label]) => (
        <TouchableOpacity
          key={mode}
          style={[
            lpStyles.sourceToggleBtn,
            value === mode && lpStyles.sourceToggleBtnActive,
          ]}
          onPress={() => {
            if (!disabled) onChange(mode);
          }}
          disabled={disabled}
        >
          <Text
            style={[
              lpStyles.sourceToggleText,
              value === mode && lpStyles.sourceToggleTextActive,
            ]}
          >
            {label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function AudioTaggingScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [processingMode, setProcessingMode] = useState<ProcessingMode>('batch');
  const [catalog, setCatalog] =
    useState<AudioTaggingCatalogSnapshot>(EMPTY_CATALOG);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<AudioTaggingCustomInitFormState>(DEFAULT_CUSTOM_INIT);
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
  const [initResult, setInitResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<
    'init' | 'tag' | 'live' | null
  >(null);

  const [topK, setTopK] = useState<(typeof TOP_K_OPTIONS)[number]>(5);
  const [segBatchConfig, setSegBatchConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [segLiveConfig, setSegLiveConfig] =
    useState<SegmentationControlConfig>(LIVE_SEG_DEFAULT);

  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [tagProgress, setTagProgress] = useState<{
    label: string;
    percent: number | null;
  } | null>(null);
  const [oneshotResult, setOneshotResult] = useState<AudioTaggingResult | null>(
    null
  );
  const [segmentedResult, setSegmentedResult] =
    useState<SegmentedAudioTaggingResult | null>(null);
  const [expandedSegment, setExpandedSegment] = useState<number | null>(null);

  const [liveSourceMode, setLiveSourceMode] = useState<LiveSourceMode>('file');
  const [liveFileSourceType, setLiveFileSourceType] =
    useState<LiveFileSourceType>('example');
  const [selectedExampleAudioId, setSelectedExampleAudioId] =
    useState<AudioFileId>(DEFAULT_EXAMPLE_ID);
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [liveRunState, setLiveRunState] = useState<
    'idle' | 'running' | 'stopping'
  >('idle');
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveLastPrimary, setLiveLastPrimary] = useState<string | null>(null);
  const [liveSegments, setLiveSegments] = useState<
    AudioTaggingLiveSegmentEvent[]
  >([]);
  const [expandedLiveSegment, setExpandedLiveSegment] = useState<number | null>(
    null
  );

  const engineRef = useRef<AudioTaggingEngine | null>(null);
  const pipelineRef = useRef<AudioTaggingPipelineHandle | null>(null);
  const liveInRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextRef = useRef<LiveTextBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const cleanupLockRef = useRef(false);
  const liveRunEpochRef = useRef(0);
  const liveAutoExpandDoneRef = useRef(false);
  const pathCtxRef = useRef<PathCtx | null>(null);

  const pathCtx = useMemo((): PathCtx => {
    const ctx: PathCtx = {
      padModelIds: catalog.padModelIds,
      padModelsPath: catalog.padModelsPath,
      bundledFolders: catalog.bundledFolders,
      downloadedIds: new Set(catalog.downloadedIds),
    };
    pathCtxRef.current = ctx;
    return ctx;
  }, [catalog]);

  const catalogEntries = catalog.entries;
  const engineReady = !!engineRef.current && !!initializedSummary;
  const liveBusy = liveRunState === 'running' || liveRunState === 'stopping';
  const busy = loading || tagging || liveBusy || customFillLoading;

  const clearResults = useCallback(() => {
    setOneshotResult(null);
    setSegmentedResult(null);
    setTagProgress(null);
    setExpandedSegment(null);
  }, []);

  const setErr = useCallback((source: 'init' | 'tag' | 'live', e: unknown) => {
    setErrorSource(source);
    setError(errMsg(e));
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoadingModels(true);
    try {
      const snapshot = await loadAudioTaggingModelCatalog();
      setCatalog(snapshot);
      setSelectedModelForInit((prev) =>
        prev && snapshot.entries.some((e) => e.id === prev)
          ? prev
          : snapshot.entries[0]?.id ?? null
      );
    } catch (e) {
      setCatalog(EMPTY_CATALOG);
      setErr('init', e);
    } finally {
      setLoadingModels(false);
    }
  }, [setErr]);

  useEffect(() => {
    loadCatalog().catch(() => {});
    return onModelsListUpdated((category) => {
      if (category === ModelCategory.AudioTagging)
        loadCatalog().catch(() => {});
    });
  }, [loadCatalog]);

  const cleanupLiveRuntime = useCallback(async () => {
    if (cleanupLockRef.current) return;
    cleanupLockRef.current = true;
    try {
      try {
        ingestHandleRef.current?.cancel();
      } catch {
        /* ignore */
      }
      ingestHandleRef.current = null;
      await stopMicToLiveAudioBuffer().catch(() => {});
      await pipelineRef.current?.stop().catch(() => {});
      pipelineRef.current = null;
      const liveText = liveTextRef.current;
      liveTextRef.current = null;
      if (liveText) {
        await releasePipelineTextBuffer(liveText.bufferId).catch(() => {});
      }
      const liveIn = liveInRef.current;
      liveInRef.current = null;
      if (liveIn) {
        await releasePipelineAudioBuffer(liveIn.bufferId).catch(() => {});
      }
    } finally {
      cleanupLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupLiveRuntime().catch(() => {});
      const engine = engineRef.current;
      engineRef.current = null;
      engine?.destroy().catch(() => {});
    };
  }, [cleanupLiveRuntime]);

  const resolveModelPath = useCallback(
    (modelId: string): FileSource =>
      getAudioTaggingModelPathConfig(modelId, pathCtxRef.current ?? pathCtx),
    [pathCtx]
  );

  const handleFillFromSelectedModel = useCallback(async () => {
    if (!selectedModelForInit) {
      Alert.alert('Select a model', 'Pick an audio tagging pack first.');
      return;
    }
    setCustomFillLoading(true);
    setCustomFillHint(null);
    setError(null);
    setErrorSource(null);
    try {
      const fillResult = await fillAudioTaggingCustomConfigFromModelFolder(
        await toDetectSource(resolveModelPath(selectedModelForInit))
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
        `Filled from ${getModelDisplayName(selectedModelForInit)}.${missing}`
      );
    } catch (e) {
      setCustomFillHint(null);
      setErr('init', e);
    } finally {
      setCustomFillLoading(false);
    }
  }, [resolveModelPath, selectedModelForInit, setErr]);

  const destroyEngine = useCallback(async () => {
    await cleanupLiveRuntime();
    const previous = engineRef.current;
    engineRef.current = null;
    if (previous) await previous.destroy().catch(() => {});
  }, [cleanupLiveRuntime]);

  const handleInitialize = useCallback(
    async (modelFolder: string) => {
      if (!modelFolder) {
        setErr('init', 'Select an audio tagging model folder first.');
        return;
      }
      setLoading(true);
      setError(null);
      setErrorSource(null);
      setInitResult(null);
      setInitializedSummary(null);
      clearResults();
      try {
        await destroyEngine();
        const modelSource = await toDetectSource(resolveModelPath(modelFolder));
        const detectResult = await detectAudioTaggingModel(modelSource, {
          modelType: 'auto',
        });
        if (!detectResult.success) {
          setErr(
            'init',
            detectResult.error?.trim() ||
              'No audio tagging model detected (need ONNX + labels CSV)'
          );
          setInitResult('Initialization failed: detection unsuccessful');
          return;
        }
        const detectedType: AudioTaggingModelType =
          detectResult.modelType === 'zipformer' ? 'zipformer' : 'ced';
        engineRef.current = await createAudioTagging({
          modelSource,
          numThreads: NUM_THREADS,
          topK,
        });
        setCurrentModelFolder(modelFolder);
        setInitializedSummary(getModelDisplayName(modelFolder));
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected: ${detectedType}`
        );
      } catch (e) {
        setErr('init', e);
        setInitResult(`Initialization failed: ${errMsg(e)}`);
      } finally {
        setLoading(false);
      }
    },
    [clearResults, destroyEngine, resolveModelPath, setErr, topK]
  );

  const handleInitializeCustom = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setInitializedSummary(null);
    clearResults();
    try {
      await destroyEngine();
      const model = customInitForm.fileSources.model;
      const labels = customInitForm.fileSources.labels;
      if (!model || !labels) {
        throw new Error('Custom init requires model ONNX and labels CSV.');
      }
      const customConfig = { model, labels } as AudioTaggingCustomConfig;
      assertAudioTaggingCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );
      engineRef.current = await createAudioTagging({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig,
        numThreads: NUM_THREADS,
        topK,
      });
      setCurrentModelFolder(null);
      setInitializedSummary(`custom:${customInitForm.modelType}`);
      setInitResult(
        `Initialized (custom): ${customInitForm.modelType} model + labels`
      );
    } catch (e) {
      setErr('init', e);
      setInitResult(`Custom initialization failed: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, [
    clearResults,
    customInitForm.fileSources,
    customInitForm.modelType,
    destroyEngine,
    setErr,
    topK,
  ]);

  const handleFree = useCallback(async () => {
    await destroyEngine();
    setCurrentModelFolder(null);
    setInitializedSummary(null);
    setInitResult(null);
    clearResults();
    setLiveStatus(null);
    setLiveLastPrimary(null);
    setLiveSegments([]);
    setExpandedLiveSegment(null);
    setLiveRunState('idle');
  }, [clearResults, destroyEngine]);

  const handleTagBatch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !preparedInputBuffer) {
      setErr('tag', 'Initialize a model and prepare an offline buffer first.');
      return;
    }
    setTagging(true);
    setError(null);
    setErrorSource(null);
    clearResults();
    setTagProgress({ label: 'Tagging…', percent: null });
    try {
      const segOption = buildSegmentationOption(segBatchConfig);
      const useAuto =
        segOption != null &&
        segOption.mode === 'auto' &&
        segOption.policy != null;
      const result = useAuto
        ? await engine.tag(preparedInputBuffer.bufferId, {
            topK,
            segmentation: { mode: 'auto', policy: segOption!.policy },
            onProgress: (progress) => {
              const percent =
                progress.totalSegments > 0
                  ? Math.min(
                      99,
                      Math.round(
                        ((progress.currentSegment + 1) /
                          progress.totalSegments) *
                          100
                      )
                    )
                  : Math.min(99, Math.round(progress.fraction * 100));
              setTagProgress({
                label: `Segment ${progress.currentSegment + 1}/${
                  progress.totalSegments
                }`,
                percent,
              });
            },
          })
        : await engine.tag(preparedInputBuffer.bufferId, { topK });
      if (isSegmentedResult(result)) setSegmentedResult(result);
      else setOneshotResult(result);
      setTagProgress(useAuto ? { label: 'Done', percent: 100 } : null);
    } catch (e) {
      setErr('tag', e);
      setTagProgress(null);
    } finally {
      setTagging(false);
    }
  }, [clearResults, preparedInputBuffer, segBatchConfig, setErr, topK]);

  const resolveLiveFileSource = useCallback((): FileSource => {
    if (liveFileSourceType === 'own') {
      if (!selectedFileUri) throw new Error('Pick an audio file first.');
      return toFileSource(selectedFileUri, selectedFileName ?? undefined);
    }
    const example =
      AUDIO_TAGGING_AUDIO_FILES.find((f) => f.id === selectedExampleAudioId) ??
      AUDIO_TAGGING_AUDIO_FILES[0];
    if (!example) throw new Error('No example audio available.');
    return fileSourceFromBundledPath(example.id);
  }, [
    liveFileSourceType,
    selectedExampleAudioId,
    selectedFileName,
    selectedFileUri,
  ]);

  const handleLiveSegment = useCallback(
    (event: AudioTaggingLiveSegmentEvent) => {
      const primary =
        event.result.primary?.name ?? event.result.events[0]?.name ?? '—';
      setLiveLastPrimary(primary);
      setLiveSegments((prev) => [...prev, event].slice(-80));
      if (!liveAutoExpandDoneRef.current) {
        liveAutoExpandDoneRef.current = true;
        setExpandedLiveSegment(event.segmentIndex);
      }
    },
    []
  );

  const handleStartLive = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      setErr('live', 'Initialize an audio tagging model first.');
      return;
    }
    const segOption = buildSegmentationOption(segLiveConfig);
    if (
      !segOption ||
      segOption.mode === 'off' ||
      !segOption.policy ||
      (segOption.policy.evaluator !== 'speech_energy_silence' &&
        segOption.policy.evaluator !== 'continuous_frames')
    ) {
      setErr(
        'live',
        'Live overload needs Auto + speech_energy_silence or continuous_frames.'
      );
      return;
    }

    setLiveRunState('running');
    const runEpoch = ++liveRunEpochRef.current;
    setError(null);
    setErrorSource(null);
    setLiveStatus(null);
    setLiveLastPrimary(null);
    setLiveSegments([]);
    setExpandedLiveSegment(null);
    liveAutoExpandDoneRef.current = false;
    clearResults();
    await cleanupLiveRuntime();
    if (runEpoch !== liveRunEpochRef.current) return;

    try {
      const liveIn = await createEmptyLiveAudioBuffer({
        sampleRate: LIVE_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
      });
      liveInRef.current = liveIn;
      const liveText = await createLiveTextBuffer();
      liveTextRef.current = liveText;

      const pipeline = await engine.tag(liveIn, liveText, {
        topK,
        segmentation: { mode: 'auto', policy: segOption.policy },
        onSegment: handleLiveSegment,
      });
      pipelineRef.current = pipeline;
      if (runEpoch !== liveRunEpochRef.current) return;

      if (liveSourceMode === 'file') {
        setLiveStatus('Ingesting file…');
        const ingest = await ingestFileToLiveAudioBuffer(
          liveIn.bufferId,
          resolveLiveFileSource(),
          {
            targetSampleRateHz: LIVE_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
            backpressure: 'block',
          }
        );
        ingestHandleRef.current = ingest;
        await ingest.done;
        ingestHandleRef.current = null;
        if (runEpoch !== liveRunEpochRef.current) return;
        setLiveStatus('Draining tag events…');
        await pipeline.completed;
        if (runEpoch !== liveRunEpochRef.current) return;
        pipelineRef.current = null;
        await pipeline.stop().catch(() => {});
        setLiveStatus('Done — file live overload complete.');
        setLiveRunState('idle');
        await cleanupLiveRuntime().catch(() => {});
      } else {
        setLiveStatus('Recording — Stop when finished.');
        await startMicToLiveAudioBuffer(liveIn);
      }
    } catch (e) {
      if (runEpoch !== liveRunEpochRef.current) return;
      setErr('live', e);
      setLiveRunState('idle');
      setLiveStatus(null);
      await cleanupLiveRuntime().catch(() => {});
    }
  }, [
    cleanupLiveRuntime,
    clearResults,
    handleLiveSegment,
    liveSourceMode,
    resolveLiveFileSource,
    segLiveConfig,
    setErr,
    topK,
  ]);

  const handleStopLive = useCallback(async () => {
    if (liveRunState !== 'running') return;
    setLiveRunState('stopping');
    const wasMic = liveSourceMode === 'mic';
    liveRunEpochRef.current += 1;
    try {
      ingestHandleRef.current?.cancel();
      ingestHandleRef.current = null;
      await stopMicToLiveAudioBuffer().catch(() => {});
      if (liveInRef.current) {
        await finalizeLiveAudioBuffer(liveInRef.current.bufferId).catch(
          () => {}
        );
      }
      const pipeline = pipelineRef.current;
      if (pipeline && wasMic) {
        setLiveStatus('Draining tag events…');
        await pipeline.flush().catch(() => {});
        await pipeline.completed.catch(() => {});
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Stopped — mic session complete.');
      } else if (pipeline) {
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Cancelled.');
      }
    } finally {
      await cleanupLiveRuntime().catch(() => {});
      setLiveRunState('idle');
    }
  }, [cleanupLiveRuntime, liveRunState, liveSourceMode]);

  const pickFile = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (!result) return;
      setSelectedFileUri(result.uri);
      setSelectedFileName(
        resolveAudioFileDisplayName(result.uri, result.name) ??
          result.name ??
          result.uri
      );
      setLiveFileSourceType('own');
    } catch (e) {
      const cancelled =
        (DocumentPicker as { isCancel?: (err: unknown) => boolean }).isCancel?.(
          e
        ) ||
        (e as { code?: string })?.code === 'DOCUMENT_PICKER_CANCELED' ||
        (e as { name?: string })?.name === 'DocumentPickerCanceled';
      if (!cancelled) setErr('live', e);
    }
  }, [setErr]);

  const copyJson = useCallback((payload: unknown, label: string) => {
    Clipboard.setString(JSON.stringify(payload, null, 2));
    Alert.alert('Copied', `${label} JSON copied.`);
  }, []);

  const canInitAuto = initMode === 'auto' && !!selectedModelForInit && !busy;
  const canInitCustom =
    initMode === 'custom' &&
    !!customInitForm.fileSources.model &&
    !!customInitForm.fileSources.labels &&
    !busy;
  const canRunBatch =
    processingMode === 'batch' &&
    engineReady &&
    !!preparedInputBuffer &&
    !tagging &&
    !liveBusy;
  const canRunLive =
    processingMode === 'liveOverload' &&
    engineReady &&
    !liveBusy &&
    (liveSourceMode === 'mic' ||
      (liveFileSourceType === 'example' && !!selectedExampleAudioId) ||
      (liveFileSourceType === 'own' && !!selectedFileUri));

  const oneshotPrimary =
    oneshotResult?.primary?.name ?? oneshotResult?.events[0]?.name ?? null;
  const oneshotRtf =
    oneshotResult && oneshotResult.audioDuration > 0
      ? oneshotResult.elapsedMs / (oneshotResult.audioDuration * 1000)
      : null;

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScreenIntroModal screenId="AudioTagging" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="musical-notes" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Audio Tagging</Text>
        </View>
        <Text style={styles.bodyText}>
          Offline oneshot / segmented classify, plus live overload — CED or
          zipformer packs.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Processing mode</Text>
          <ModeToggle
            value={processingMode}
            disabled={liveBusy || tagging}
            onChange={setProcessingMode}
            options={[
              ['batch', 'Offline batch'],
              ['liveOverload', 'Live overload'],
            ]}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Model</Text>
          <Text style={styles.sectionHint}>
            Dedicated packs (ONNX + class_labels_indices.csv).
          </Text>
          <InitModeSelector
            value={initMode}
            onChange={setInitMode}
            disabled={busy}
          />

          {initMode === 'auto' ? (
            <>
              {catalogEntries.length === 0 && !loadingModels ? (
                <View style={styles.emptyCatalog}>
                  <Text style={styles.bodyText}>
                    No audio tagging models found. Download from Download
                    Showcase.
                  </Text>
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => navigation.navigate('DownloadShowcase')}
                  >
                    <Text style={styles.primaryButtonText}>
                      Open Download Showcase
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <ModelFolderGrid
                  entries={catalogEntries}
                  selectedId={selectedModelForInit}
                  initializedId={currentModelFolder}
                  onSelect={setSelectedModelForInit}
                  loading={loadingModels}
                  disabled={busy}
                  emptyMessage="No audio tagging models found."
                />
              )}
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  !canInitAuto && styles.buttonDisabled,
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
                  <Text style={styles.primaryButtonText}>Initialize model</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              {catalogEntries.length > 0 ? (
                <ModelFolderGrid
                  entries={catalogEntries}
                  selectedId={selectedModelForInit}
                  initializedId={currentModelFolder}
                  onSelect={setSelectedModelForInit}
                  loading={loadingModels}
                  disabled={busy}
                  emptyMessage="No catalog models for Fill."
                />
              ) : null}
              <AudioTaggingCustomInitForm
                value={customInitForm}
                onChange={setCustomInitForm}
                selectedCatalogModelId={selectedModelForInit}
                onFillFromSelectedModel={() => {
                  handleFillFromSelectedModel().catch(() => {});
                }}
                onPrepareScatteredTest={() => {
                  setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
                  setCustomFillHint(
                    'Scattered test: pick model ONNX + labels CSV, then Init.'
                  );
                }}
                fillLoading={customFillLoading}
                disabled={busy}
                fillHint={customFillHint}
              />
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  !canInitCustom && styles.buttonDisabled,
                ]}
                onPress={() => {
                  handleInitializeCustom().catch(() => {});
                }}
                disabled={!canInitCustom}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Initialize (custom)
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}

          {initializedSummary ? (
            <Text style={baseStyles.currentModelText}>
              Ready: {initializedSummary}
            </Text>
          ) : null}
          {initResult && !(error && errorSource === 'init') ? (
            <Text style={styles.bodyText}>{initResult}</Text>
          ) : null}
          {error && errorSource === 'init' ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          {engineReady ? (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                handleFree().catch(() => {});
              }}
              disabled={busy}
            >
              <Text style={styles.secondaryButtonText}>Release engine</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>topK</Text>
          <View style={styles.chipRow}>
            {TOP_K_OPTIONS.map((value) => {
              const active = topK === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => {
                    if (!busy) setTopK(value);
                  }}
                  disabled={busy}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {value}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Segmentation</Text>
          {processingMode === 'batch' ? (
            <>
              <Text style={styles.sectionHint}>
                Off = oneshot. Auto = energy windows only (cont. frames is
                live-only).
              </Text>
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segBatchConfig}
                onChange={setSegBatchConfig}
                disabled={tagging || liveBusy}
                disableManual
                allowedEvaluators={[...AT_OFFLINE_EVALUATORS]}
              />
            </>
          ) : (
            <>
              <Text style={styles.sectionHint}>
                Live requires Auto. Energy or continuous_frames; windows ≥
                1500ms.
              </Text>
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segLiveConfig}
                onChange={setSegLiveConfig}
                disabled={liveBusy}
                disableOff
                disableManual
                allowedEvaluators={[...AT_LIVE_EVALUATORS]}
                offDisabledMessage="Live audio tagging overload requires Auto segmentation."
              />
            </>
          )}
        </View>

        {processingMode === 'batch' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input (offline)</Text>
            <OfflineAudioBufferWidget
              audioFiles={AUDIO_TAGGING_AUDIO_FILES}
              visible={engineReady}
              disabled={!engineReady || tagging || liveBusy}
              onBufferReady={(info) => {
                setPreparedInputBuffer(info);
                clearResults();
              }}
              onBufferReleased={() => {
                setPreparedInputBuffer(null);
                clearResults();
              }}
            />
            {tagProgress ? (
              <View style={styles.progressBox}>
                <Text style={styles.progressLabel}>
                  {tagProgress.label}
                  {tagProgress.percent != null
                    ? ` · ${tagProgress.percent}%`
                    : ''}
                </Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      tagProgress.percent == null
                        ? styles.progressIndeterminate
                        : { width: `${tagProgress.percent}%` },
                    ]}
                  />
                </View>
              </View>
            ) : null}
            <TouchableOpacity
              style={[
                styles.primaryButton,
                !canRunBatch && styles.buttonDisabled,
              ]}
              onPress={() => {
                handleTagBatch().catch(() => {});
              }}
              disabled={!canRunBatch}
            >
              {tagging ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryButtonText}>Tag</Text>
              )}
            </TouchableOpacity>
            {error && errorSource === 'tag' ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input (live)</Text>
            <ModeToggle
              value={liveSourceMode}
              disabled={liveBusy}
              onChange={setLiveSourceMode}
              options={[
                ['file', 'File'],
                ['mic', 'Microphone'],
              ]}
            />

            {liveSourceMode === 'file' ? (
              <>
                <ModeToggle
                  value={liveFileSourceType}
                  disabled={liveBusy}
                  onChange={setLiveFileSourceType}
                  options={[
                    ['example', 'Example'],
                    ['own', 'Own file'],
                  ]}
                />
                {liveFileSourceType === 'example' ? (
                  <ExampleAudioFileList
                    audioFiles={AUDIO_TAGGING_AUDIO_FILES}
                    selectedId={selectedExampleAudioId}
                    onSelect={(audioFile) => {
                      setSelectedExampleAudioId(audioFile.id);
                      setLiveFileSourceType('example');
                    }}
                    disabled={liveBusy}
                  />
                ) : !selectedFileUri ? (
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
                  <View style={styles.selectedFileRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sectionHint}>Selected file</Text>
                      <Text style={styles.bodyText} numberOfLines={2}>
                        {selectedFileName ?? selectedFileUri}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => {
                        if (!liveBusy) {
                          setSelectedFileUri(null);
                          setSelectedFileName(null);
                        }
                      }}
                      disabled={liveBusy}
                    >
                      <Text style={styles.errorText}>Clear</Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.sectionHint}>
                Mic audio is tagged per Auto window. Stop when finished.
              </Text>
            )}

            <View style={[styles.hud, !liveLastPrimary && styles.hudIdle]}>
              <Text style={styles.hudLabel}>Last primary</Text>
              <Text style={styles.hudPrimary}>{liveLastPrimary ?? '—'}</Text>
            </View>

            {liveStatus ? (
              <Text style={styles.bodyText}>{liveStatus}</Text>
            ) : null}

            {liveSegments.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  Live segments ({liveSegments.length})
                </Text>
                <Text style={styles.sectionHint}>
                  Tap a row for that window’s top-K.
                </Text>
                {liveSegments.map((seg) => {
                  const primary =
                    seg.result.primary?.name ??
                    seg.result.events[0]?.name ??
                    '—';
                  const expanded = expandedLiveSegment === seg.segmentIndex;
                  return (
                    <View key={`${seg.segmentIndex}_${seg.startTime}`}>
                      <Pressable
                        style={styles.timelineRow}
                        onPress={() =>
                          setExpandedLiveSegment(
                            expanded ? null : seg.segmentIndex
                          )
                        }
                      >
                        <View style={styles.timelineChip}>
                          <Text
                            style={styles.timelineChipText}
                            numberOfLines={1}
                          >
                            {primary}
                          </Text>
                        </View>
                        <Text style={styles.timelineMeta}>
                          #{seg.segmentIndex} · {formatSeconds(seg.startTime)}–
                          {formatSeconds(seg.endTime)} · {seg.durationMs}ms
                        </Text>
                        <Text style={styles.timelineExpand}>
                          {expanded ? 'Hide' : 'Top-K'}
                        </Text>
                      </Pressable>
                      {expanded ? (
                        <View style={styles.timelineDetail}>
                          <EventDistBars events={seg.result.events} />
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}

            {liveRunState === 'idle' ? (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  !canRunLive && styles.buttonDisabled,
                ]}
                onPress={() => {
                  handleStartLive().catch(() => {});
                }}
                disabled={!canRunLive}
              >
                <Text style={styles.primaryButtonText}>Start</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.dangerButton, styles.flexButton]}
                onPress={() => {
                  handleStopLive().catch(() => {});
                }}
                disabled={liveRunState === 'stopping'}
              >
                {liveRunState === 'stopping' ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.dangerButtonText}>Stop</Text>
                )}
              </TouchableOpacity>
            )}

            {error && errorSource === 'live' ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        )}

        {oneshotResult ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Oneshot result</Text>
            <View style={styles.eventHero}>
              <View style={styles.eventChip}>
                <Text style={styles.eventChipText} numberOfLines={2}>
                  {oneshotPrimary ?? '—'}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaText}>
                  Audio {formatSeconds(oneshotResult.audioDuration)}
                </Text>
                <Text style={styles.metaText}>
                  {oneshotResult.elapsedMs.toFixed(0)} ms
                </Text>
                <Text style={styles.metaText}>topK {oneshotResult.topK}</Text>
                {oneshotRtf != null ? (
                  <Text style={styles.metaText}>
                    RTF {oneshotRtf.toFixed(2)}×
                  </Text>
                ) : null}
              </View>
            </View>
            <Text style={styles.cardTitle}>top-K</Text>
            <EventDistBars events={oneshotResult.events} />
            <TouchableOpacity
              style={styles.copyBtn}
              onPress={() => copyJson(oneshotResult, 'Oneshot')}
            >
              <Text style={styles.copyBtnText}>Copy JSON</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {segmentedResult ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Segmented result</Text>
            <Text style={styles.metaText}>
              {segmentedResult.totalSegments} segment(s) ·{' '}
              {segmentedResult.processingTimeMs.toFixed(0)} ms
            </Text>
            {segmentedResult.segments.map((seg) => {
              const primary =
                seg.result.primary?.name ?? seg.result.events[0]?.name ?? '—';
              const expanded = expandedSegment === seg.segmentIndex;
              return (
                <View key={seg.segmentIndex}>
                  <Pressable
                    style={styles.timelineRow}
                    onPress={() =>
                      setExpandedSegment(expanded ? null : seg.segmentIndex)
                    }
                  >
                    <View style={styles.timelineChip}>
                      <Text style={styles.timelineChipText} numberOfLines={1}>
                        {primary}
                      </Text>
                    </View>
                    <Text style={styles.timelineMeta}>
                      #{seg.segmentIndex} · {formatSeconds(seg.startTime)}–
                      {formatSeconds(seg.endTime)} · {seg.durationMs}ms
                    </Text>
                    <Text style={styles.timelineExpand}>
                      {expanded ? 'Hide' : 'Top-K'}
                    </Text>
                  </Pressable>
                  {expanded ? (
                    <View style={styles.timelineDetail}>
                      <EventDistBars events={seg.result.events} />
                    </View>
                  ) : null}
                </View>
              );
            })}
            <TouchableOpacity
              style={styles.copyBtn}
              onPress={() => copyJson(segmentedResult, 'Segmented')}
            >
              <Text style={styles.copyBtnText}>Copy JSON</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
