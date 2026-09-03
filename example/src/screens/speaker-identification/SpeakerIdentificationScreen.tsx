import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  DocumentDirectoryPath,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  assertSpeakerEmbeddingCustomConfig,
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
  type SpeakerEnrollmentBundle,
  type SpeakerIdentificationEngine,
  type SpeakerIdentificationPipelineHandle,
  type SpeakerEmbeddingCustomConfig,
  type SpeakerEmbeddingModelType,
} from 'react-native-sherpa-onnx/speaker-identification';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';
import { segmentOfflineBuffer } from 'react-native-sherpa-onnx/segment';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
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
import {
  InitModeSelector,
  ModelFolderGrid,
  SpeakerIdentificationCustomInitForm,
  type ModelInitMode,
  type SpeakerIdentificationCustomInitFormState,
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
  toFileSource,
} from '../../utils/fileSourceFromUri';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import { fillSidCustomConfigFromModelFolder } from '../../utils/sidCustomInitFill';

const PAD_PACK_NAME = 'sherpa_models';
const NUM_THREADS = 2;
const LIVE_SAMPLE_RATE = 16000;
const DEFAULT_THRESHOLD = 0.5;

type ProcessingMode = 'batch' | 'liveOverload';
type LiveSourceMode = 'file' | 'mic';
type LiveFileSourceType = 'example' | 'own';

const DEFAULT_SID_CUSTOM_INIT: SpeakerIdentificationCustomInitFormState = {
  modelType: 'wespeaker',
  fileSources: {},
};

const LIVE_SEG_DEFAULT: SegmentationControlConfig = {
  mode: 'auto',
  policy: {
    evaluator: 'speech_energy_silence',
    silenceThresholdMs: 500,
    energyThresholdDb: -40,
    minSegmentMs: 1000,
    maxSegmentMs: 120_000,
    hangoverMs: 300,
  },
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

function isSidHint(folder: string, hint: string): boolean {
  if (hint === 'speakerEmbedding' || hint === 'speaker-embedding') return true;
  const n = folder.toLowerCase();
  return (
    n.includes('wespeaker') ||
    n.includes('3d-speaker') ||
    n.includes('3dspeaker') ||
    n.includes('nemo') ||
    n.includes('speaker') ||
    n.includes('embedding')
  );
}

const EXPORT_SPEAKER_ALL = '__all__';

function filterEnrollmentBundle(
  bundle: SpeakerEnrollmentBundle,
  speakerFilter: string
): SpeakerEnrollmentBundle {
  if (speakerFilter === EXPORT_SPEAKER_ALL) {
    return bundle;
  }
  return {
    ...bundle,
    speakers: bundle.speakers.filter((entry) => entry.name === speakerFilter),
  };
}

export default function SpeakerIdentificationScreen() {
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('batch');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] =
    useState<SpeakerIdentificationCustomInitFormState>(DEFAULT_SID_CUSTOM_INIT);
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
  const [modelDim, setModelDim] = useState<number | null>(null);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<
    | 'enroll'
    | 'identify'
    | 'verify'
    | 'label'
    | 'exportEditor'
    | 'exportFile'
    | 'importEditor'
    | 'importFile'
    | null
  >(null);
  const [actionProgress, setActionProgress] = useState<{
    label: string;
    percent: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<
    'init' | 'action' | 'live' | null
  >(null);

  const [segBatchConfig, setSegBatchConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [segLiveConfig, setSegLiveConfig] =
    useState<SegmentationControlConfig>(LIVE_SEG_DEFAULT);

  const [preparedInputBuffer, setPreparedInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [speakerName, setSpeakerName] = useState('alice');
  const [thresholdText, setThresholdText] = useState(String(DEFAULT_THRESHOLD));
  const [enrolledSpeakers, setEnrolledSpeakers] = useState<string[]>([]);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [labeledLog, setLabeledLog] = useState<string[]>([]);
  /** Speaker names from the last label run — for comma-separated copy. */
  const [spanLabelNames, setSpanLabelNames] = useState<string[]>([]);
  const [enrollmentJson, setEnrollmentJson] = useState('');
  const [jsonBufferExpanded, setJsonBufferExpanded] = useState(false);
  const [exportSectionExpanded, setExportSectionExpanded] = useState(true);
  const [importSectionExpanded, setImportSectionExpanded] = useState(true);
  const [exportSpeakerFilter, setExportSpeakerFilter] =
    useState<string>(EXPORT_SPEAKER_ALL);
  const [exportSpeakerPickerOpen, setExportSpeakerPickerOpen] = useState(false);

  const [liveSourceMode, setLiveSourceMode] = useState<LiveSourceMode>('file');
  const [liveFileSourceType, setLiveFileSourceType] =
    useState<LiveFileSourceType>('example');
  const [selectedExampleAudioId, setSelectedExampleAudioId] = useState(
    AUDIO_FILES[0]?.id ?? ''
  );
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [liveRunState, setLiveRunState] = useState<
    'idle' | 'running' | 'stopping'
  >('idle');
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveLabelLog, setLiveLabelLog] = useState<string[]>([]);

  const engineRef = useRef<SpeakerIdentificationEngine | null>(null);
  const pipelineRef = useRef<SpeakerIdentificationPipelineHandle | null>(null);
  const liveInRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegOutRef = useRef<string | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const cleanupLockRef = useRef(false);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const liveRunEpochRef = useRef(0);
  const scrollViewRef = useRef<ScrollView>(null);
  const enrollmentTransferYRef = useRef(0);
  const jsonBufferSectionYRef = useRef(0);

  const scrollToJsonBuffer = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        const y =
          enrollmentTransferYRef.current + jsonBufferSectionYRef.current;
        scrollViewRef.current?.scrollTo({
          y: Math.max(0, y - 12),
          animated: true,
        });
      }, 80);
    });
  }, []);

  const refreshSpeakers = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      setEnrolledSpeakers([]);
      return;
    }
    try {
      const names = await engine.listSpeakers();
      setEnrolledSpeakers(names);
      setExportSpeakerFilter((prev) =>
        prev === EXPORT_SPEAKER_ALL || names.includes(prev)
          ? prev
          : EXPORT_SPEAKER_ALL
      );
    } catch {
      setEnrolledSpeakers([]);
    }
  }, []);

  const resolveThreshold = useCallback((): number => {
    const parsed = Number.parseFloat(thresholdText);
    return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
  }, [thresholdText]);

  const showActionError = (
    source: 'init' | 'action' | 'live',
    message: string
  ) => {
    setActionResult(null);
    setLabeledLog([]);
    setSpanLabelNames([]);
    setErrorSource(source);
    setError(message);
    const title =
      source === 'init'
        ? 'Initialization failed'
        : source === 'live'
        ? 'Live pipeline error'
        : 'Action failed';
    Alert.alert(title, message);
  };

  const showActionSuccess = (
    message: string,
    options?: { keepLabeledLog?: boolean }
  ) => {
    setError(null);
    setErrorSource(null);
    if (!options?.keepLabeledLog) {
      setLabeledLog([]);
      setSpanLabelNames([]);
    }
    setActionResult(message);
  };

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    setErrorSource(null);
    try {
      const assetModels = await listAssetModels();
      const sidFolders = assetModels
        .filter((m) => isSidHint(m.folder, m.hint))
        .map((m) => m.folder);
      const downloadedModels = await listDownloadedModels(
        ModelCategory.SpeakerEmbedding
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
          .filter((m) => isSidHint(m.folder, m.hint))
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
        }
      } catch (loadPadErr) {
        console.warn(
          'SpeakerIdentificationScreen: PAD/listModelsAtPath failed',
          loadPadErr
        );
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);

      const combined = [
        ...padFolders,
        ...sidFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !sidFolders.includes(f)
        ),
      ];
      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      setAvailableModels(combined);

      if (combined.length === 0) {
        showActionError(
          'init',
          'No speaker-embedding models found. Add a WeSpeaker / 3D-Speaker / NeMo model as a bundled asset, download, or PAD model.'
        );
      }
    } catch (loadErr) {
      console.error(
        'SpeakerIdentificationScreen: Failed to load models:',
        loadErr
      );
      showActionError('init', 'Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadAvailableModels().catch(() => {});
    const unsubscribe = onModelsListUpdated((category) => {
      if (category === ModelCategory.SpeakerEmbedding) {
        loadAvailableModels().catch(() => {});
      }
    });
    return unsubscribe;
  }, [loadAvailableModels]);

  const resolveSidModelPath = useCallback(
    (modelFolder: string) => {
      if (padModelIds.includes(modelFolder)) {
        return padModelsPath
          ? getFileModelPath(
              modelFolder,
              ModelCategory.SpeakerEmbedding,
              padModelsPath
            )
          : getFileModelPath(modelFolder, ModelCategory.SpeakerEmbedding);
      }
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.SpeakerEmbedding);
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
      try {
        ingestHandleRef.current?.cancel();
      } catch {
        // ignore
      }
      ingestHandleRef.current = null;

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore
      }

      try {
        await pipelineRef.current?.stop();
      } catch {
        // ignore
      }
      pipelineRef.current = null;

      const segOut = liveSegOutRef.current;
      liveSegOutRef.current = null;
      if (segOut) {
        await releasePipelineSegmentBuffer(segOut).catch(() => {});
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
      const modelPath = resolveSidModelPath(modelFolder);
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
      showActionError('init', normalizeErrorMessage(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveSidModelPath, selectedModelForInit]);

  const handlePrepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick the embedding ONNX from any location, then Initialize.'
    );
  }, []);

  const handleInitializeCustom = async () => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setInitializedSummary(null);

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }

      const customConfig = { ...customInitForm.fileSources };
      assertSpeakerEmbeddingCustomConfig(
        customConfig as unknown as Record<string, unknown>
      );

      const engine = await createSpeakerIdentification({
        initMode: 'custom',
        modelType: customInitForm.modelType,
        customConfig: customConfig as SpeakerEmbeddingCustomConfig,
        numThreads: NUM_THREADS,
      });

      engineRef.current = engine;
      setModelDim(engine.dim);
      setCurrentModelFolder(null);
      setInitializedSummary(`custom:${customInitForm.modelType}`);
      setInitResult(
        `Initialized (custom): ${customInitForm.modelType}\nDim: ${engine.dim}`
      );
      setActionResult(null);
      await refreshSpeakers();
    } catch (initErr) {
      showActionError('init', normalizeErrorMessage(initErr));
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

    try {
      const previous = engineRef.current;
      if (previous) {
        await previous.destroy();
        engineRef.current = null;
      }

      const modelPath = resolveSidModelPath(modelFolder);
      const modelSource = await toDetectSource(modelPath);

      const detectResult = await detectSpeakerEmbeddingModel(modelSource, {
        modelType: 'auto',
      });
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        showActionError(
          'init',
          'No speaker-embedding models detected in the directory'
        );
        return;
      }

      const modelType =
        detectResult.modelType === 'wespeaker' ||
        detectResult.modelType === '3d-speaker' ||
        detectResult.modelType === 'nemo'
          ? detectResult.modelType
          : (detectResult.detectedModels[0]?.type as SpeakerEmbeddingModelType);

      const engine = await createSpeakerIdentification({
        modelSource,
        modelType,
        numThreads: NUM_THREADS,
      });

      engineRef.current = engine;
      setModelDim(engine.dim);
      setCurrentModelFolder(modelFolder);
      setInitializedSummary(modelFolder);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )} (${modelType})\nDim: ${engine.dim}`
      );
      setActionResult(null);
      await refreshSpeakers();
    } catch (initErr) {
      showActionError('init', normalizeErrorMessage(initErr));
      setInitResult(`Initialization failed: ${normalizeErrorMessage(initErr)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFree = async () => {
    await cleanupLiveRuntime();
    const engine = engineRef.current;
    if (engine) {
      await engine.destroy().catch(() => {});
    }
    engineRef.current = null;
    setCurrentModelFolder(null);
    setInitializedSummary(null);
    setInitResult(null);
    setModelDim(null);
    setEnrolledSpeakers([]);
    setActionResult(null);
    setLabeledLog([]);
    setLiveStatus(null);
    setLiveLabelLog([]);
    setEnrollmentJson('');
    setJsonBufferExpanded(false);
  };

  const requireEngine = (): SpeakerIdentificationEngine => {
    const engine = engineRef.current;
    if (!engine) {
      throw new Error('Initialize a speaker-embedding model first.');
    }
    return engine;
  };

  const requirePreparedAudio = (): OfflineAudioBufferInfo => {
    if (!preparedInputBuffer) {
      throw new Error('Prepare an offline audio buffer first.');
    }
    return preparedInputBuffer;
  };

  const withSpeechSegments = async <T,>(
    audioBufferId: string,
    run: (segmentsInId: string) => Promise<T>
  ): Promise<T> => {
    const built = buildSegmentationOption(segBatchConfig);
    if (!built?.policy || built.mode === 'off') {
      throw new Error('Segmentation must be Auto with a speech policy.');
    }
    const segmented = await segmentOfflineBuffer(audioBufferId, built.policy);
    try {
      return await run(segmented.segmentBufferId);
    } finally {
      await releasePipelineSegmentBuffer(segmented.segmentBufferId).catch(
        () => {}
      );
    }
  };

  const beginBusy = (action: NonNullable<typeof busyAction>, label: string) => {
    setBusy(true);
    setBusyAction(action);
    setActionProgress({ label, percent: null });
    setError(null);
    setErrorSource(null);
    setActionResult(null);
    setLabeledLog([]);
    setSpanLabelNames([]);
  };

  const updateBusyProgress = (
    baseLabel: string,
    progress: {
      currentSegment: number;
      totalSegments: number;
      fraction: number;
    }
  ) => {
    const percent =
      progress.totalSegments > 0
        ? Math.min(
            99,
            Math.round(
              ((progress.currentSegment + 1) / progress.totalSegments) * 100
            )
          )
        : Math.min(99, Math.round(progress.fraction * 100));
    setActionProgress({
      label: `${baseLabel} · ${progress.currentSegment + 1}/${
        progress.totalSegments
      }`,
      percent,
    });
  };

  const endBusy = () => {
    setBusy(false);
    setBusyAction(null);
    setActionProgress(null);
  };

  /** One name, or comma-separated names (one per speech span when segmenting). */
  const parseEnrollNames = (raw: string): string | string[] => {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error('Enter a speaker name (or comma-separated names).');
    }
    if (!trimmed.includes(',')) {
      return trimmed;
    }
    return trimmed.split(',').map((part) => part.trim());
  };

  /** First non-empty name — used by verify (and whole-buffer enroll). */
  const parseSingleSpeakerName = (raw: string, action: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`Enter a speaker name to ${action}.`);
    }
    if (!trimmed.includes(',')) {
      return trimmed;
    }
    const first = trimmed
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (!first) {
      throw new Error(`Enter a speaker name to ${action}.`);
    }
    return first;
  };

  const handleEnroll = async () => {
    beginBusy('enroll', 'Enrolling…');
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();

      if (segBatchConfig.mode === 'off') {
        const name = parseSingleSpeakerName(speakerName, 'enroll');
        await engine.enroll(name, audio.bufferId);
        showActionSuccess(`Enrolled '${name}' from whole buffer.`);
      } else {
        const names = parseEnrollNames(speakerName);
        const progressLabel = Array.isArray(names)
          ? `Enrolling ${names.length} spans`
          : `Enrolling '${names}'`;
        setActionProgress({ label: 'Segmenting speech…', percent: null });
        await withSpeechSegments(audio.bufferId, async (segmentsIn) => {
          await engine.enrollOfflineSegments(
            names,
            audio.bufferId,
            segmentsIn,
            {
              onProgress: (p) => {
                updateBusyProgress(progressLabel, p);
              },
            }
          );
        });
        showActionSuccess(
          Array.isArray(names)
            ? `Enrolled ${
                [...new Set(names.filter(Boolean))].length
              } speaker(s) from ${names.length} speech spans.`
            : `Enrolled '${names}' from speech spans.`
        );
      }
      await refreshSpeakers();
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

  const handleIdentify = async () => {
    beginBusy('identify', 'Identifying…');
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const result = await engine.identify(audio.bufferId, {
        threshold: resolveThreshold(),
      });
      showActionSuccess(
        result.name
          ? `Identify → ${result.name}`
          : 'Identify → unknown (below threshold)'
      );
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

  const handleVerify = async () => {
    beginBusy('verify', 'Verifying…');
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const name = parseSingleSpeakerName(speakerName, 'verify');
      const ok = await engine.verify(name, audio.bufferId, {
        threshold: resolveThreshold(),
      });
      showActionSuccess(`Verify '${name}' → ${ok ? 'match' : 'no match'}`);
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

  const handleVerifyOffline = async () => {
    beginBusy('verify', 'Verifying speech spans…');
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const names = parseEnrollNames(speakerName);
      if (segBatchConfig.mode === 'off') {
        throw new Error('Verify speech spans requires segmentation mode Auto.');
      }

      const lines: string[] = [];
      const progressLabel = Array.isArray(names)
        ? `Verifying ${names.length} spans`
        : `Verifying '${names}'`;
      setActionProgress({ label: 'Segmenting speech…', percent: null });
      await withSpeechSegments(audio.bufferId, async (segmentsIn) => {
        const result = await engine.verifyOfflineSegments(
          names,
          audio.bufferId,
          segmentsIn,
          {
            threshold: resolveThreshold(),
            onProgress: (p) => {
              updateBusyProgress(progressLabel, p);
            },
            onVerified: (e) => {
              const line = `#${e.segmentIndex} ${e.expectedName} → ${
                e.matched ? 'match' : 'no match'
              } (${e.durationMs}ms)`;
              lines.push(line);
              setLabeledLog([...lines]);
            },
          }
        );
        showActionSuccess(
          Array.isArray(names)
            ? `Verify spans → ${result.matchCount} match, ${result.mismatchCount} no match`
            : `Verify '${names}' → ${result.matchCount} match, ${result.mismatchCount} no match`,
          { keepLabeledLog: true }
        );
      });
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

  const handleLabelOffline = async () => {
    beginBusy('label', 'Labeling speech spans…');
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      if (segBatchConfig.mode === 'off') {
        throw new Error(
          'Label offline segments requires segmentation mode Auto.'
        );
      }

      const lines: string[] = [];
      const labelNames: string[] = [];
      setActionProgress({ label: 'Segmenting speech…', percent: null });
      await withSpeechSegments(audio.bufferId, async (segmentsIn) => {
        const segmentsOut = await createEmptyOfflineSegmentBuffer({
          sourceAudioBufferId: audio.bufferId,
        });
        try {
          const result = await engine.labelOfflineSegments(
            audio.bufferId,
            segmentsIn,
            segmentsOut.bufferId,
            {
              threshold: resolveThreshold(),
              onProgress: (p) => {
                updateBusyProgress('Labeling', p);
              },
              onLabeled: (e) => {
                const name = e.speakerName ?? 'unknown';
                const line = `#${e.segmentIndex} ${name} (${e.durationMs}ms)`;
                lines.push(line);
                labelNames.push(name);
                setLabeledLog([...lines]);
                setSpanLabelNames([...labelNames]);
              },
            }
          );
          const segs = await getOfflineSegmentBufferSegments(
            segmentsOut.bufferId
          );
          showActionSuccess(
            `Labeled ${result.labeledCount}, unknown ${result.unknownCount}, out rows ${segs.length}`,
            { keepLabeledLog: true }
          );
        } finally {
          await releasePipelineSegmentBuffer(segmentsOut.bufferId).catch(
            () => {}
          );
        }
      });
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

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

  const handleLabelLive = async () => {
    if (!engineRef.current) {
      showActionError('live', 'Initialize a speaker-embedding model first.');
      return;
    }
    if (enrolledSpeakers.length === 0) {
      showActionError(
        'live',
        'Enroll at least one speaker offline before live labeling.'
      );
      return;
    }

    const segOption = buildSegmentationOption(segLiveConfig);
    if (
      !segOption ||
      segOption.mode === 'off' ||
      !segOption.policy ||
      (segOption.policy.evaluator !== 'speech_energy_silence' &&
        segOption.policy.evaluator !== 'speech_vad_model')
    ) {
      showActionError(
        'live',
        'Live overload requires speech_energy_silence or speech_vad_model segmentation.'
      );
      return;
    }

    setLiveRunState('running');
    const runEpoch = ++liveRunEpochRef.current;
    setError(null);
    setErrorSource(null);
    setLiveStatus(null);
    setLiveLabelLog([]);
    setActionResult(null);
    setLabeledLog([]);
    setSpanLabelNames([]);
    await cleanupLiveRuntime();
    if (runEpoch !== liveRunEpochRef.current) {
      return;
    }

    try {
      const engine = engineRef.current;
      const liveIn = await createEmptyLiveAudioBuffer({
        sampleRate: LIVE_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
      });
      liveInRef.current = liveIn;

      const labeledOut = await createLiveSegmentBuffer({
        sourceAudioBufferId: liveIn.bufferId,
        spooling: { mode: 'on' },
        streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
      });
      liveSegOutRef.current = labeledOut.bufferId;

      const lines: string[] = [];
      const pipeline = await engine.labelLiveSegments(
        liveIn.bufferId,
        labeledOut.bufferId,
        {
          segmentation: {
            mode: 'auto',
            policy: segOption.policy,
          },
          threshold: resolveThreshold(),
          onLabeled: (e) => {
            const line = `#${e.segmentIndex} ${e.speakerName ?? 'unknown'} (${
              e.durationMs
            }ms)`;
            lines.push(line);
            setLiveLabelLog([...lines.slice(-20)]);
          },
        }
      );
      pipelineRef.current = pipeline;
      if (runEpoch !== liveRunEpochRef.current) {
        return;
      }

      if (liveSourceMode === 'file') {
        setLiveStatus('Ingesting file…');
        const source = resolveLiveFileSource();
        const ingest = await ingestFileToLiveAudioBuffer(
          liveIn.bufferId,
          source,
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
        if (runEpoch !== liveRunEpochRef.current) {
          return;
        }
        setLiveStatus('Draining labels…');
        await pipeline.completed;
        if (runEpoch !== liveRunEpochRef.current) {
          return;
        }
        pipelineRef.current = null;
        await pipeline.stop().catch(() => {});
        setLiveStatus(`Done — ${lines.length} labeled utterance(s).`);
        showActionSuccess(`Live label complete (${lines.length} events).`);
        setLiveRunState('idle');
        await cleanupLiveRuntime().catch(() => {});
      } else {
        setLiveStatus('Recording — speak, then Stop.');
        await startMicToLiveAudioBuffer(liveIn);
        // Pipeline stays running until handleStopLive finalizes input.
      }
    } catch (err) {
      if (runEpoch !== liveRunEpochRef.current) {
        return;
      }
      showActionError('live', normalizeErrorMessage(err));
      setLiveRunState('idle');
      setLiveStatus(null);
      await cleanupLiveRuntime().catch(() => {});
    }
  };

  const handleStopLive = async () => {
    if (liveRunState === 'stopping') {
      return;
    }
    if (liveRunState !== 'running') {
      return;
    }
    setLiveRunState('stopping');
    const wasMic = liveSourceMode === 'mic';
    liveRunEpochRef.current += 1;

    try {
      ingestHandleRef.current?.cancel();
      ingestHandleRef.current = null;
      await stopMicToLiveAudioBuffer().catch(() => {});

      const liveIn = liveInRef.current;
      if (liveIn) {
        await finalizeLiveAudioBuffer(liveIn.bufferId).catch(() => {});
      }

      const pipeline = pipelineRef.current;
      if (pipeline && wasMic) {
        setLiveStatus('Draining labels…');
        await pipeline.flush().catch(() => {});
        await pipeline.completed.catch(() => {});
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Stopped — mic session complete.');
        showActionSuccess('Live mic label stopped.');
      } else if (pipeline) {
        await pipeline.stop().catch(() => {});
        pipelineRef.current = null;
        setLiveStatus('Cancelled.');
      }
    } finally {
      await cleanupLiveRuntime().catch(() => {});
      setLiveRunState('idle');
    }
  };

  const isDocumentPickerCanceled = (err: unknown): boolean => {
    if (
      DocumentPicker.isErrorWithCode?.(err) &&
      (err as { code?: string }).code ===
        DocumentPicker.errorCodes?.OPERATION_CANCELED
    ) {
      return true;
    }
    return (
      (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
        err
      ) === true ||
      (err as { name?: string })?.name === 'DocumentPickerCanceled'
    );
  };

  const handleExportToEditor = async () => {
    beginBusy('exportEditor', 'Exporting to editor…');
    let didExport = false;
    try {
      const engine = requireEngine();
      const bundle = filterEnrollmentBundle(
        await engine.exportEnrollments(),
        exportSpeakerFilter
      );
      if (bundle.speakers.length === 0) {
        throw new Error(
          exportSpeakerFilter === EXPORT_SPEAKER_ALL
            ? 'No enrolled speakers to export.'
            : `Speaker '${exportSpeakerFilter}' is not in the enrollment mirror.`
        );
      }
      setEnrollmentJson(JSON.stringify(bundle, null, 2));
      setJsonBufferExpanded(true);
      showActionSuccess(
        `Exported ${bundle.speakers.length} speaker(s) (dim=${bundle.dim}) to editor.`
      );
      didExport = true;
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
      if (didExport) {
        scrollToJsonBuffer();
      }
    }
  };

  const handleExportToJsonFile = async () => {
    const stagingDir = `${DocumentDirectoryPath}/SherpaOnnxSid/exports`;
    const stagingPath = `${stagingDir}/enrollments_${Date.now()}.json`;
    beginBusy('exportFile', 'Exporting to JSON file…');
    try {
      const engine = requireEngine();
      const bundle = filterEnrollmentBundle(
        await engine.exportEnrollments(),
        exportSpeakerFilter
      );
      if (bundle.speakers.length === 0) {
        throw new Error(
          exportSpeakerFilter === EXPORT_SPEAKER_ALL
            ? 'No enrolled speakers to export.'
            : `Speaker '${exportSpeakerFilter}' is not in the enrollment mirror.`
        );
      }
      const json = JSON.stringify(bundle, null, 2);
      setEnrollmentJson(json);
      setJsonBufferExpanded(true);

      await mkdir(stagingDir).catch(() => {});
      await writeFile(stagingPath, json, 'utf8');
      const sourceUri = encodeURI(
        stagingPath.startsWith('file://')
          ? stagingPath
          : `file://${stagingPath}`
      );
      const fileLabel =
        exportSpeakerFilter === EXPORT_SPEAKER_ALL
          ? `speaker-enrollments_${Date.now()}.json`
          : `speaker-${exportSpeakerFilter}_${Date.now()}.json`;
      const responses = await DocumentPicker.saveDocuments({
        sourceUris: [sourceUri],
        mimeType: 'application/json',
        fileName: fileLabel,
      });
      const first = responses[0];
      if (first?.error) {
        throw new Error(first.error);
      }
      showActionSuccess(
        `Saved ${bundle.speakers.length} speaker(s) to ${
          first?.name?.trim() || 'JSON file'
        }.`
      );
    } catch (err) {
      if (isDocumentPickerCanceled(err)) {
        return;
      }
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      await unlink(stagingPath).catch(() => {});
      endBusy();
    }
  };

  const applyImportBundle = async (
    parsed: SpeakerEnrollmentBundle,
    replaceExisting: boolean
  ) => {
    beginBusy('importEditor', 'Importing enrollments…');
    try {
      const engine = requireEngine();
      const result = await engine.importEnrollments(parsed, {
        replaceExisting,
      });
      await refreshSpeakers();
      showActionSuccess(
        `Imported ${result.imported} speaker(s)${
          replaceExisting ? ' (replaced existing names)' : ''
        }.`
      );
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    } finally {
      endBusy();
    }
  };

  const handleImportFromEditor = async () => {
    try {
      const engine = requireEngine();
      let parsed: SpeakerEnrollmentBundle;
      try {
        parsed = JSON.parse(enrollmentJson) as SpeakerEnrollmentBundle;
      } catch {
        throw new Error('Editor JSON is invalid.');
      }
      if (!Array.isArray(parsed?.speakers)) {
        throw new Error('Bundle must include a speakers array.');
      }

      const existing = new Set(await engine.listSpeakers());
      const collisions = [
        ...new Set(
          parsed.speakers
            .map((entry) =>
              typeof entry?.name === 'string' ? entry.name.trim() : ''
            )
            .filter((name) => name.length > 0 && existing.has(name))
        ),
      ];

      if (collisions.length > 0) {
        Alert.alert(
          'Overwrite existing speakers?',
          `These names already exist and would be replaced:\n${collisions.join(
            ', '
          )}`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Import & replace',
              style: 'destructive',
              onPress: () => {
                applyImportBundle(parsed, true).catch(() => {});
              },
            },
          ]
        );
        return;
      }

      await applyImportBundle(parsed, false);
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    }
  };

  const handleImportFromFile = async () => {
    try {
      const [picked] = await DocumentPicker.pick({
        type: [DocumentPicker.types.json, DocumentPicker.types.plainText],
        allowMultiSelection: false,
      });
      const uri = picked?.uri?.trim();
      if (!uri) {
        return;
      }
      const fileName =
        picked.name?.trim() ||
        uri.split('/').pop()?.split('?')[0] ||
        'enrollments.json';

      beginBusy('importFile', 'Loading JSON file…');
      try {
        const [localCopy] = await DocumentPicker.keepLocalCopy({
          files: [
            {
              uri,
              fileName: fileName.endsWith('.json')
                ? fileName
                : `${fileName}.json`,
            },
          ],
          destination: 'cachesDirectory',
        });
        if (!localCopy || localCopy.status !== 'success') {
          throw new Error(
            localCopy && 'copyError' in localCopy && localCopy.copyError
              ? String(localCopy.copyError)
              : 'Could not copy the picked JSON file.'
          );
        }
        const localPath = localCopy.localUri.replace(/^file:\/\//, '');
        const raw = await readFile(decodeURI(localPath), 'utf8');
        try {
          const parsed = JSON.parse(raw) as unknown;
          setEnrollmentJson(JSON.stringify(parsed, null, 2));
        } catch {
          setEnrollmentJson(raw);
        }
        setJsonBufferExpanded(true);
        showActionSuccess(`Loaded '${fileName}' into editor.`);
      } finally {
        endBusy();
      }
    } catch (err) {
      if (isDocumentPickerCanceled(err)) {
        return;
      }
      showActionError('action', normalizeErrorMessage(err));
      endBusy();
    }
  };

  const handleRemoveSpeaker = async (name: string) => {
    try {
      const engine = requireEngine();
      await engine.removeSpeaker(name);
      await refreshSpeakers();
      showActionSuccess(`Removed '${name}'.`);
    } catch (err) {
      showActionError('action', normalizeErrorMessage(err));
    }
  };

  const pickOwnFile = async () => {
    try {
      const results = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
        allowMultiSelection: false,
      });
      const first = results[0];
      if (!first?.uri) {
        return;
      }
      setSelectedFileUri(first.uri);
      setSelectedFileName(first.name ?? 'audio');
      setLiveFileSourceType('own');
    } catch (err) {
      const canceled =
        (DocumentPicker as { isCancel?: (e: unknown) => boolean }).isCancel?.(
          err
        ) === true ||
        (err as { name?: string })?.name === 'DocumentPickerCanceled';
      if (canceled) {
        return;
      }
      showActionError('live', normalizeErrorMessage(err));
    }
  };

  const liveBusy = liveRunState === 'running' || liveRunState === 'stopping';
  const engineReady = !!engineRef.current && !!initializedSummary;
  const canInitAuto =
    initMode === 'auto' &&
    !!selectedModelForInit &&
    !loading &&
    !busy &&
    !liveBusy;
  const canInitCustom =
    initMode === 'custom' &&
    Object.keys(customInitForm.fileSources).length > 0 &&
    !loading &&
    !busy &&
    !liveBusy;
  const canRunBatch =
    processingMode === 'batch' &&
    engineReady &&
    !!preparedInputBuffer &&
    !busy &&
    !liveBusy;
  const canRunLive =
    processingMode === 'liveOverload' &&
    engineReady &&
    !liveBusy &&
    !busy &&
    (liveSourceMode === 'mic' ||
      (liveFileSourceType === 'example' && !!selectedExampleAudioId) ||
      (liveFileSourceType === 'own' && !!selectedFileUri));

  const renderProgressBlock = (
    progress: { label: string; percent: number | null },
    opts?: { titled?: boolean }
  ) => (
    <View
      style={opts?.titled ? screenStyles.card : screenStyles.inlineProgress}
    >
      {opts?.titled ? (
        <Text style={screenStyles.cardTitle}>In progress</Text>
      ) : null}
      <View style={screenStyles.progressStatusRow}>
        <ActivityIndicator color="#0F62FE" />
        <Text style={screenStyles.progressStatusText}>{progress.label}</Text>
        {progress.percent != null ? (
          <Text style={screenStyles.progressPercentText}>
            {progress.percent}%
          </Text>
        ) : null}
      </View>
      <View style={screenStyles.progressBarTrack}>
        <View
          style={[
            screenStyles.progressBarFill,
            progress.percent != null
              ? { width: `${progress.percent}%` }
              : screenStyles.progressBarIndeterminate,
          ]}
        />
      </View>
    </View>
  );

  const liveProgressLabel =
    liveStatus ??
    (liveRunState === 'stopping'
      ? 'Stopping…'
      : liveRunState === 'running'
        ? 'Live labeling…'
        : null);

  const showSharedActionProgress =
    !!actionProgress &&
    !(processingMode === 'liveOverload' && busyAction === 'enroll');

  return (
    <SafeAreaView
      style={screenStyles.container}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={screenStyles.content}
      >
        <View style={screenStyles.headerRow}>
          <View style={screenStyles.headerIconWrap}>
            <Ionicons name="person" size={20} color="#0F62FE" />
          </View>
          <Text style={screenStyles.headerTitle}>Speaker Identification</Text>
        </View>
        <Text style={screenStyles.bodyText}>
          Offline enroll / identify / label and live overload labeling with the
          same embedding model.
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
                  if (liveBusy || busy) return;
                  setProcessingMode(mode);
                }}
                disabled={liveBusy || busy}
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
            disabled={loading || busy || liveBusy}
          />

          {initMode === 'auto' ? (
            <>
              <ModelFolderGrid
                entries={catalogEntries}
                selectedId={selectedModelForInit}
                initializedId={currentModelFolder}
                onSelect={setSelectedModelForInit}
                loading={loadingModels}
                disabled={loading || busy || liveBusy}
                emptyMessage="No speaker-embedding models found."
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
              <ModelFolderGrid
                entries={catalogEntries}
                selectedId={selectedModelForInit}
                initializedId={currentModelFolder}
                onSelect={setSelectedModelForInit}
                loading={loadingModels}
                disabled={loading || busy || liveBusy}
                emptyMessage="No speaker-embedding models found (optional for Fill)."
              />
              <SpeakerIdentificationCustomInitForm
                value={customInitForm}
                onChange={setCustomInitForm}
                selectedCatalogModelId={selectedModelForInit}
                onFillFromSelectedModel={() => {
                  handleFillFromSelectedModel().catch(() => {});
                }}
                onPrepareScatteredTest={handlePrepareScatteredTest}
                fillLoading={customFillLoading}
                disabled={loading || busy || liveBusy}
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
              {modelDim != null ? ` • dim ${modelDim}` : ''}
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
              disabled={loading || busy || liveBusy}
            >
              <Text style={baseStyles.secondaryButtonText}>Release engine</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {processingMode === 'batch' ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Segmentation</Text>
            <Text style={screenStyles.sectionHint}>
              Off: whole-buffer enroll / identify. Auto: speech spans via
              segmentOfflineBuffer for enroll / label / verify.
            </Text>
            <SegmentationPolicyControls
              variant="speech-offline"
              value={segBatchConfig}
              onChange={setSegBatchConfig}
              disabled={busy || liveBusy}
            />
          </View>
        ) : null}

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Enrolled speakers</Text>
          <View style={screenStyles.row}>
            <Text style={screenStyles.bodyText}>Threshold</Text>
            <TextInput
              style={screenStyles.smallInput}
              value={thresholdText}
              onChangeText={setThresholdText}
              keyboardType="decimal-pad"
              editable={!busy && !liveBusy}
            />
          </View>
          {enrolledSpeakers.length === 0 ? (
            <Text style={screenStyles.bodyText}>None yet.</Text>
          ) : (
            enrolledSpeakers.map((name) => (
              <View key={name} style={screenStyles.speakerRow}>
                <Text style={screenStyles.speakerName}>{name}</Text>
                <TouchableOpacity
                  style={screenStyles.removeFileButton}
                  onPress={() => {
                    handleRemoveSpeaker(name).catch(() => {});
                  }}
                  disabled={busy || liveBusy}
                >
                  <Text style={screenStyles.removeFileButtonText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {processingMode === 'batch' ? (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Input (offline)</Text>
            <OfflineAudioBufferWidget
              ref={offlineWidgetRef}
              audioFiles={AUDIO_FILES}
              visible={engineReady}
              disabled={!engineReady || busy || liveBusy}
              onBufferReady={setPreparedInputBuffer}
              onBufferReleased={() => setPreparedInputBuffer(null)}
            />
            <Text style={screenStyles.fieldLabel}>
              {segBatchConfig.mode === 'off'
                ? 'Speaker name'
                : 'Speaker name(s)'}
            </Text>
            <TextInput
              style={screenStyles.textInput}
              value={speakerName}
              onChangeText={setSpeakerName}
              autoCapitalize="none"
              editable={!busy && !liveBusy}
              placeholder={
                segBatchConfig.mode === 'off'
                  ? 'e.g. alice'
                  : 'alice   or   alice, bob, alice'
              }
            />
            {segBatchConfig.mode === 'off' ? (
              <>
                <Text style={screenStyles.sectionHint}>
                  Segmentation off — whole-buffer enroll / identify / verify.
                </Text>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleEnroll().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'enroll' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>Enroll</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleIdentify().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'identify' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>
                        Identify
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleVerify().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'verify' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>Verify</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={screenStyles.sectionHint}>
                  Segmentation on — one name averages/checks all speech spans;
                  comma-separated names assign one speaker per span for enroll
                  and verify (same count). Label identifies each span against
                  all enrollments.
                </Text>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      screenStyles.twoLineButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleEnroll().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'enroll' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <>
                        <Text style={screenStyles.primaryButtonText}>
                          Enroll
                        </Text>
                        <Text style={screenStyles.primaryButtonSubText}>
                          speech spans
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      screenStyles.twoLineButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleLabelOffline().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'label' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <>
                        <Text style={screenStyles.primaryButtonText}>
                          Label
                        </Text>
                        <Text style={screenStyles.primaryButtonSubText}>
                          each span
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      screenStyles.twoLineButton,
                      !canRunBatch && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleVerifyOffline().catch(() => {});
                    }}
                    disabled={!canRunBatch}
                  >
                    {busyAction === 'verify' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <>
                        <Text style={screenStyles.primaryButtonText}>
                          Verify
                        </Text>
                        <Text style={screenStyles.primaryButtonSubText}>
                          each span
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        ) : (
          <>
            <View style={screenStyles.card}>
              <Text style={screenStyles.cardTitle}>Quick enroll (offline)</Text>
              <SegmentationPolicyControls
                variant="speech-offline"
                value={segBatchConfig}
                onChange={setSegBatchConfig}
                disabled={busy || liveBusy}
              />
              <OfflineAudioBufferWidget
                ref={offlineWidgetRef}
                audioFiles={AUDIO_FILES}
                visible={engineReady && !liveBusy}
                disabled={!engineReady || busy || liveBusy}
                onBufferReady={setPreparedInputBuffer}
                onBufferReleased={() => setPreparedInputBuffer(null)}
              />
              <Text style={screenStyles.fieldLabel}>
                {segBatchConfig.mode === 'off'
                  ? 'Speaker name'
                  : 'Speaker name(s)'}
              </Text>
              <TextInput
                style={screenStyles.textInput}
                value={speakerName}
                onChangeText={setSpeakerName}
                autoCapitalize="none"
                editable={!busy && !liveBusy}
                placeholder={
                  segBatchConfig.mode === 'off'
                    ? 'e.g. alice'
                    : 'alice   or   alice, bob, alice'
                }
              />
              {segBatchConfig.mode !== 'off' ? (
                <Text style={screenStyles.sectionHint}>
                  One name averages all speech spans; comma-separated names assign
                  one speaker per span.
                </Text>
              ) : null}
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
                  screenStyles.sectionPrimaryButton,
                  (!engineReady || !preparedInputBuffer || busy || liveBusy) &&
                    screenStyles.buttonDisabled,
                ]}
                onPress={() => {
                  handleEnroll().catch(() => {});
                }}
                disabled={
                  !engineReady || !preparedInputBuffer || busy || liveBusy
                }
              >
                {busyAction === 'enroll' ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={screenStyles.primaryButtonText}>Enroll</Text>
                )}
              </TouchableOpacity>
              {busyAction === 'enroll' && actionProgress
                ? renderProgressBlock(actionProgress)
                : null}
            </View>

            <View style={screenStyles.card}>
              <Text style={screenStyles.cardTitle}>Live label</Text>
              <SegmentationPolicyControls
                variant="speech-streaming"
                value={segLiveConfig}
                onChange={setSegLiveConfig}
                disabled={liveBusy}
                disableOff
                disableManual
                allowedEvaluators={[
                  'speech_energy_silence',
                  'speech_vad_model',
                ]}
                offDisabledMessage="Live SID overload requires mandatory speech segmentation."
              />
              <Text style={screenStyles.sectionHint}>
                Live commits on silence or maxSegmentMs. Continuous speech with a
                high max (e.g. 120s default) can yield long labels; lower
                maxSegmentMs to force shorter utterances.
              </Text>

              <Text style={screenStyles.sectionLabel}>Live source</Text>
              <View style={screenStyles.toggleGroup}>
                <View style={lpStyles.sourceToggle}>
                  {(
                    [
                      ['file', 'File'],
                      ['mic', 'Mic'],
                    ] as const
                  ).map(([mode, label]) => (
                    <TouchableOpacity
                      key={mode}
                      style={[
                        lpStyles.sourceToggleBtn,
                        liveSourceMode === mode &&
                          lpStyles.sourceToggleBtnActive,
                      ]}
                      onPress={() => {
                        if (liveBusy) return;
                        setLiveSourceMode(mode);
                      }}
                      disabled={liveBusy}
                    >
                      <Text
                        style={[
                          lpStyles.sourceToggleText,
                          liveSourceMode === mode &&
                            lpStyles.sourceToggleTextActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {liveSourceMode === 'file' ? (
                <>
                  <Text style={screenStyles.fieldLabel}>File input</Text>
                  <View style={screenStyles.toggleGroup}>
                    <View style={lpStyles.sourceToggle}>
                      {(
                        [
                          ['example', 'Example'],
                          ['own', 'Own file'],
                        ] as const
                      ).map(([mode, label]) => (
                        <TouchableOpacity
                          key={mode}
                          style={[
                            lpStyles.sourceToggleBtn,
                            liveFileSourceType === mode &&
                              lpStyles.sourceToggleBtnActive,
                          ]}
                          onPress={() => {
                            if (liveBusy) return;
                            setLiveFileSourceType(mode);
                          }}
                          disabled={liveBusy}
                        >
                          <Text
                            style={[
                              lpStyles.sourceToggleText,
                              liveFileSourceType === mode &&
                                lpStyles.sourceToggleTextActive,
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                  {liveFileSourceType === 'example' ? (
                    <View style={screenStyles.chipWrap}>
                      {AUDIO_FILES.map((file) => {
                        const active = selectedExampleAudioId === file.id;
                        return (
                          <TouchableOpacity
                            key={file.id}
                            style={[
                              screenStyles.chip,
                              active && screenStyles.chipActive,
                            ]}
                            onPress={() => setSelectedExampleAudioId(file.id)}
                            disabled={liveBusy}
                          >
                            <Text
                              style={[
                                screenStyles.chipText,
                                active && screenStyles.chipTextActive,
                              ]}
                              numberOfLines={1}
                            >
                              {file.name}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={baseStyles.secondaryButton}
                      onPress={() => {
                        pickOwnFile().catch(() => {});
                      }}
                      disabled={liveBusy}
                    >
                      <Text style={baseStyles.secondaryButtonText}>
                        {selectedFileName
                          ? `File: ${selectedFileName}`
                          : 'Pick audio file'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <Text style={screenStyles.sectionHint}>
                  Microphone audio is labeled in real time. Stop when finished.
                </Text>
              )}

              {liveRunState === 'idle' ? (
                <TouchableOpacity
                  style={[
                    screenStyles.primaryButton,
                    screenStyles.sectionPrimaryButton,
                    !canRunLive && screenStyles.buttonDisabled,
                  ]}
                  onPress={() => {
                    handleLabelLive().catch(() => {});
                  }}
                  disabled={!canRunLive}
                >
                  <Text style={screenStyles.primaryButtonText}>
                    Start live label
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[
                    screenStyles.primaryButton,
                    screenStyles.sectionPrimaryButton,
                    screenStyles.stopButton,
                  ]}
                  onPress={() => {
                    handleStopLive().catch(() => {});
                  }}
                >
                  <Text style={screenStyles.primaryButtonText}>Stop</Text>
                </TouchableOpacity>
              )}
              {liveBusy && liveProgressLabel
                ? renderProgressBlock({
                    label: liveProgressLabel,
                    percent: null,
                  })
                : liveStatus && !liveBusy ? (
                    <Text
                      style={[screenStyles.bodyText, screenStyles.statusAfterRun]}
                    >
                      {liveStatus}
                    </Text>
                  ) : null}
              {liveLabelLog.map((line) => (
                <Text key={line} style={screenStyles.monoResultText}>
                  {line}
                </Text>
              ))}
            </View>
          </>
        )}

        {showSharedActionProgress && actionProgress
          ? renderProgressBlock(actionProgress, { titled: true })
          : null}

        {(error || actionResult || labeledLog.length > 0) && (
          <View style={screenStyles.card}>
            <View style={screenStyles.resultHeaderRow}>
              <Text style={[screenStyles.cardTitle, { marginBottom: 0 }]}>
                Result
              </Text>
              {spanLabelNames.length > 0 ? (
                <TouchableOpacity
                  style={screenStyles.copyLabelsButton}
                  onPress={() => {
                    Clipboard.setString(spanLabelNames.join(', '));
                    Alert.alert(
                      'Copied',
                      `Copied ${spanLabelNames.length} label(s) as comma-separated names.`
                    );
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="copy-outline" size={16} color="#0F62FE" />
                  <Text style={screenStyles.copyLabelsButtonText}>
                    Copy labels
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {error ? (
              <Text style={[screenStyles.errorText, { marginTop: 12 }]}>
                [{errorSource ?? 'error'}] {error}
              </Text>
            ) : actionResult ? (
              <Text style={[screenStyles.monoResultText, { marginTop: 12 }]}>
                {actionResult}
              </Text>
            ) : null}
            {labeledLog.map((line) => (
              <Text key={line} style={screenStyles.monoResultText}>
                {line}
              </Text>
            ))}
          </View>
        )}

        <View
          style={screenStyles.card}
          onLayout={(e) => {
            enrollmentTransferYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <Text style={screenStyles.cardTitle}>Enrollment transfer</Text>
          <Text style={screenStyles.bodyText}>
            Move enrolled speaker embeddings in or out as JSON. Independent of
            the Speaker name field — export picks from the enrolled list; import
            reads speakers[].name from the JSON.
          </Text>

          <View style={screenStyles.sectionBlock}>
            <TouchableOpacity
              style={screenStyles.collapseHeader}
              onPress={() => setExportSectionExpanded((open) => !open)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <Text style={screenStyles.collapseHeaderTitle}>Export</Text>
              <Ionicons
                name={
                  exportSectionExpanded ? 'chevron-down' : 'chevron-forward'
                }
                size={18}
                color="#6B7280"
              />
            </TouchableOpacity>
            {exportSectionExpanded ? (
              <>
                <Text style={screenStyles.sectionHint}>
                  Choose all enrolled speakers or one speaker, then write into
                  the JSON buffer and/or a file.
                </Text>
                <Text style={screenStyles.fieldLabel}>Speakers to export</Text>
                <TouchableOpacity
                  style={[
                    screenStyles.dropdownTrigger,
                    (!engineReady || busy || liveBusy) &&
                      screenStyles.buttonDisabled,
                  ]}
                  onPress={() => setExportSpeakerPickerOpen(true)}
                  disabled={!engineReady || busy || liveBusy}
                >
                  <Text
                    style={screenStyles.dropdownTriggerText}
                    numberOfLines={1}
                  >
                    {exportSpeakerFilter === EXPORT_SPEAKER_ALL
                      ? `All speakers (${enrolledSpeakers.length})`
                      : exportSpeakerFilter}
                  </Text>
                  <Text style={screenStyles.dropdownChevron}>▼</Text>
                </TouchableOpacity>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      (!engineReady || busy || liveBusy) &&
                        screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleExportToEditor().catch(() => {});
                    }}
                    disabled={!engineReady || busy || liveBusy}
                  >
                    {busyAction === 'exportEditor' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>
                        To JSON buffer
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      (!engineReady || busy || liveBusy) &&
                        screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleExportToJsonFile().catch(() => {});
                    }}
                    disabled={!engineReady || busy || liveBusy}
                  >
                    {busyAction === 'exportFile' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>
                        To JSON file
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>

          <View style={screenStyles.sectionBlock}>
            <TouchableOpacity
              style={screenStyles.collapseHeader}
              onPress={() => setImportSectionExpanded((open) => !open)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <Text style={screenStyles.collapseHeaderTitle}>Import</Text>
              <Ionicons
                name={
                  importSectionExpanded ? 'chevron-down' : 'chevron-forward'
                }
                size={18}
                color="#6B7280"
              />
            </TouchableOpacity>
            {importSectionExpanded ? (
              <>
                <Text style={screenStyles.sectionHint}>
                  Load a file into the JSON buffer, then apply it to the engine.
                  Speaker names come only from the JSON (speakers[].name).
                </Text>
                <View style={screenStyles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      (busy || liveBusy) && screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleImportFromFile().catch(() => {});
                    }}
                    disabled={busy || liveBusy}
                  >
                    {busyAction === 'importFile' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>
                        Load file → buffer
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      screenStyles.primaryButton,
                      screenStyles.flexButton,
                      (!engineReady ||
                        !enrollmentJson.trim() ||
                        busy ||
                        liveBusy) &&
                        screenStyles.buttonDisabled,
                    ]}
                    onPress={() => {
                      handleImportFromEditor().catch(() => {});
                    }}
                    disabled={
                      !engineReady ||
                      !enrollmentJson.trim() ||
                      busy ||
                      liveBusy
                    }
                  >
                    {busyAction === 'importEditor' ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={screenStyles.primaryButtonText}>
                        Apply buffer
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </View>

          <View
            style={screenStyles.sectionBlock}
            onLayout={(e) => {
              jsonBufferSectionYRef.current = e.nativeEvent.layout.y;
            }}
          >
            <TouchableOpacity
              style={screenStyles.collapseHeader}
              onPress={() => setJsonBufferExpanded((open) => !open)}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            >
              <View style={screenStyles.collapseHeaderTitleWrap}>
                <Text style={screenStyles.collapseHeaderTitle}>JSON buffer</Text>
                {!jsonBufferExpanded && enrollmentJson.trim() ? (
                  <Text style={screenStyles.collapseHeaderMeta}>
                    {enrollmentJson.length} chars
                  </Text>
                ) : null}
              </View>
              <Ionicons
                name={jsonBufferExpanded ? 'chevron-down' : 'chevron-forward'}
                size={18}
                color="#6B7280"
              />
            </TouchableOpacity>
            <Text style={screenStyles.sectionHint}>
              Editable SpeakerEnrollmentBundle. Paste here, load from a file, or
              fill via Export.
            </Text>
            {jsonBufferExpanded ? (
              <TextInput
                style={screenStyles.multilineInput}
                value={enrollmentJson}
                onChangeText={setEnrollmentJson}
                multiline
                editable={!busy && !liveBusy}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="{ version: 1, dim, speakers: [{ name, embeddings }] }"
              />
            ) : (
              <TouchableOpacity
                style={screenStyles.jsonBufferCollapsed}
                onPress={() => setJsonBufferExpanded(true)}
                disabled={busy || liveBusy}
              >
                <Text
                  style={screenStyles.jsonBufferCollapsedText}
                  numberOfLines={2}
                >
                  {enrollmentJson.trim()
                    ? enrollmentJson.trim().slice(0, 120) +
                      (enrollmentJson.trim().length > 120 ? '…' : '')
                    : 'Empty — export or load a file, then expand to edit.'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <Text style={screenStyles.footerHint}>
          Models: ModelCategory.SpeakerEmbedding · Live = offline weights +
          speech segmentation
        </Text>
      </ScrollView>
      <Modal
        visible={exportSpeakerPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setExportSpeakerPickerOpen(false)}
      >
        <Pressable
          style={screenStyles.dropdownOverlay}
          onPress={() => setExportSpeakerPickerOpen(false)}
        >
          <Pressable
            style={screenStyles.dropdownSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={screenStyles.dropdownSheetTitle}>
              Speakers to export
            </Text>
            <ScrollView style={screenStyles.dropdownList}>
              <TouchableOpacity
                style={[
                  screenStyles.dropdownItem,
                  exportSpeakerFilter === EXPORT_SPEAKER_ALL &&
                    screenStyles.dropdownItemActive,
                ]}
                onPress={() => {
                  setExportSpeakerFilter(EXPORT_SPEAKER_ALL);
                  setExportSpeakerPickerOpen(false);
                }}
              >
                <Text
                  style={[
                    screenStyles.dropdownItemText,
                    exportSpeakerFilter === EXPORT_SPEAKER_ALL &&
                      screenStyles.dropdownItemTextActive,
                  ]}
                >
                  All speakers ({enrolledSpeakers.length})
                </Text>
              </TouchableOpacity>
              {enrolledSpeakers.map((name) => {
                const active = exportSpeakerFilter === name;
                return (
                  <TouchableOpacity
                    key={name}
                    style={[
                      screenStyles.dropdownItem,
                      active && screenStyles.dropdownItemActive,
                    ]}
                    onPress={() => {
                      setExportSpeakerFilter(name);
                      setExportSpeakerPickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        screenStyles.dropdownItemText,
                        active && screenStyles.dropdownItemTextActive,
                      ]}
                    >
                      {name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={screenStyles.dropdownCancel}
              onPress={() => setExportSpeakerPickerOpen(false)}
            >
              <Text style={screenStyles.dropdownCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
      <ScreenIntroModal screenId="SpeakerIdentification" />
    </SafeAreaView>
  );
}

const screenStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 32,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
  resultHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  copyLabelsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#E8F1FF',
  },
  copyLabelsButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0F62FE',
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#F9FAFB',
    marginBottom: 12,
  },
  dropdownTriggerText: {
    flex: 1,
    fontSize: 15,
    color: '#111827',
    marginRight: 8,
  },
  dropdownChevron: {
    fontSize: 11,
    color: '#6B7280',
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  dropdownSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingBottom: 24,
    maxHeight: '70%',
  },
  dropdownSheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  dropdownList: {
    paddingHorizontal: 8,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 10,
  },
  dropdownItemActive: {
    backgroundColor: '#E8F1FF',
  },
  dropdownItemText: {
    fontSize: 15,
    color: '#111827',
  },
  dropdownItemTextActive: {
    fontWeight: '700',
    color: '#0F62FE',
  },
  dropdownCancel: {
    marginTop: 8,
    marginHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
  },
  dropdownCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
  },
  sectionBlock: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
  },
  collapseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
    minHeight: 28,
  },
  collapseHeaderTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  collapseHeaderTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  collapseHeaderMeta: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  sectionLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  jsonBufferCollapsed: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#F9FAFB',
  },
  jsonBufferCollapsedText: {
    fontSize: 12,
    lineHeight: 18,
    color: '#6B7280',
    fontFamily: 'Menlo',
  },
  sectionHint: {
    fontSize: 13,
    lineHeight: 18,
    color: '#6B7280',
    marginBottom: 12,
  },
  statusAfterRun: {
    marginTop: 12,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginTop: 12,
    marginBottom: 6,
  },
  toggleGroup: {
    marginBottom: 12,
  },
  sectionPrimaryButton: {
    marginTop: 12,
  },
  inlineProgress: {
    marginTop: 12,
  },
  progressStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  progressStatusText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  progressPercentText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F62FE',
    minWidth: 44,
    textAlign: 'right',
  },
  progressBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E5E7EB',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0F62FE',
  },
  progressBarIndeterminate: {
    width: '35%',
    opacity: 0.55,
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
  errorText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#B42318',
    marginBottom: 8,
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
  primaryButtonSubText: {
    color: '#E8F1FF',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  twoLineButton: {
    paddingVertical: 10,
  },
  stopButton: {
    backgroundColor: '#B42318',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  flexButton: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 110,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  smallInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 72,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#F9FAFB',
  },
  multilineInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 120,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#F9FAFB',
    fontFamily: 'Menlo',
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  speakerName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
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
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#C7C7CC',
    backgroundColor: '#F2F2F7',
  },
  chipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  chipText: {
    fontSize: 13,
    color: '#3A3A3C',
  },
  chipTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  footerHint: {
    fontSize: 12,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 4,
  },
});
