import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
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

  const [exportJson, setExportJson] = useState('');
  const [importJson, setImportJson] = useState('');

  const engineRef = useRef<SpeakerIdentificationEngine | null>(null);
  const pipelineRef = useRef<SpeakerIdentificationPipelineHandle | null>(null);
  const liveInRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegOutRef = useRef<string | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const cleanupLockRef = useRef(false);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const liveRunEpochRef = useRef(0);

  const refreshSpeakers = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      setEnrolledSpeakers([]);
      return;
    }
    try {
      setEnrolledSpeakers(await engine.listSpeakers());
    } catch {
      setEnrolledSpeakers([]);
    }
  }, []);

  const resolveThreshold = useCallback((): number => {
    const parsed = Number.parseFloat(thresholdText);
    return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
  }, [thresholdText]);

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
        setErrorSource('init');
        setError(
          'No speaker-embedding models found. Add a WeSpeaker / 3D-Speaker / NeMo model as a bundled asset, download, or PAD model.'
        );
      }
    } catch (loadErr) {
      console.error(
        'SpeakerIdentificationScreen: Failed to load models:',
        loadErr
      );
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
      setErrorSource('init');
      setError(normalizeErrorMessage(fillErr));
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
        setErrorSource('init');
        setError('No speaker-embedding models detected in the directory');
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
      setErrorSource('init');
      setError(normalizeErrorMessage(initErr));
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
    setExportJson('');
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

  const handleEnroll = async () => {
    setBusy(true);
    setError(null);
    setErrorSource(null);
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const name = speakerName.trim();
      if (!name) {
        throw new Error('Enter a speaker name to enroll.');
      }

      if (segBatchConfig.mode === 'off') {
        await engine.enroll(name, audio.bufferId);
        setActionResult(`Enrolled '${name}' from whole buffer.`);
      } else {
        await withSpeechSegments(audio.bufferId, async (segmentsIn) => {
          await engine.enrollOfflineSegments(name, audio.bufferId, segmentsIn, {
            onProgress: (p) => {
              setActionResult(
                `Enrolling '${name}'… ${p.currentSegment + 1}/${
                  p.totalSegments
                }`
              );
            },
          });
        });
        setActionResult(`Enrolled '${name}' from speech segments.`);
      }
      await refreshSpeakers();
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleIdentify = async () => {
    setBusy(true);
    setError(null);
    setErrorSource(null);
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const result = await engine.identify(audio.bufferId, {
        threshold: resolveThreshold(),
      });
      setActionResult(
        result.name
          ? `Identify → ${result.name}`
          : 'Identify → unknown (below threshold)'
      );
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    setBusy(true);
    setError(null);
    setErrorSource(null);
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      const name = speakerName.trim();
      if (!name) {
        throw new Error('Enter a speaker name to verify.');
      }
      const ok = await engine.verify(name, audio.bufferId, {
        threshold: resolveThreshold(),
      });
      setActionResult(`Verify '${name}' → ${ok ? 'match' : 'no match'}`);
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLabelOffline = async () => {
    setBusy(true);
    setError(null);
    setErrorSource(null);
    setLabeledLog([]);
    try {
      const engine = requireEngine();
      const audio = requirePreparedAudio();
      if (segBatchConfig.mode === 'off') {
        throw new Error(
          'Label offline segments requires segmentation mode Auto.'
        );
      }

      const lines: string[] = [];
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
              onLabeled: (e) => {
                const line = `#${e.segmentIndex} ${
                  e.speakerName ?? 'unknown'
                } (${e.durationMs}ms)`;
                lines.push(line);
                setLabeledLog([...lines]);
              },
            }
          );
          const segs = await getOfflineSegmentBufferSegments(
            segmentsOut.bufferId
          );
          setActionResult(
            `Labeled ${result.labeledCount}, unknown ${result.unknownCount}, out rows ${segs.length}`
          );
        } finally {
          await releasePipelineSegmentBuffer(segmentsOut.bufferId).catch(
            () => {}
          );
        }
      });
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    } finally {
      setBusy(false);
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
      setErrorSource('live');
      setError('Initialize a speaker-embedding model first.');
      return;
    }
    if (enrolledSpeakers.length === 0) {
      setErrorSource('live');
      setError('Enroll at least one speaker offline before live labeling.');
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
      setErrorSource('live');
      setError(
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
        setActionResult(`Live label complete (${lines.length} events).`);
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
      setErrorSource('live');
      setError(normalizeErrorMessage(err));
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
        setActionResult('Live mic label stopped.');
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

  const handleExport = async () => {
    try {
      const engine = requireEngine();
      const bundle = await engine.exportEnrollments();
      const json = JSON.stringify(bundle, null, 2);
      setExportJson(json);
      setImportJson(json);
      setActionResult(
        `Exported ${bundle.speakers.length} speaker(s) (dim=${bundle.dim}).`
      );
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    }
  };

  const handleImport = async (replaceExisting: boolean) => {
    try {
      const engine = requireEngine();
      const parsed = JSON.parse(importJson) as SpeakerEnrollmentBundle;
      const result = await engine.importEnrollments(parsed, {
        replaceExisting,
      });
      await refreshSpeakers();
      setActionResult(
        `Imported ${result.imported} speaker(s)${
          replaceExisting ? ' (replace)' : ''
        }.`
      );
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
    }
  };

  const handleRemoveSpeaker = async (name: string) => {
    try {
      const engine = requireEngine();
      await engine.removeSpeaker(name);
      await refreshSpeakers();
      setActionResult(`Removed '${name}'.`);
    } catch (err) {
      setErrorSource('action');
      setError(normalizeErrorMessage(err));
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
      setErrorSource('live');
      setError(normalizeErrorMessage(err));
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

  return (
    <SafeAreaView
      style={screenStyles.container}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView contentContainerStyle={screenStyles.content}>
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
                  if (mode === 'liveOverload') {
                    setSegLiveConfig(LIVE_SEG_DEFAULT);
                  }
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

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Segmentation</Text>
          {processingMode === 'batch' ? (
            <>
              <Text style={screenStyles.bodyText}>
                Off: whole-buffer enroll / identify. Auto: speech spans via
                segmentOfflineBuffer for enrollOfflineSegments / label.
              </Text>
              <SegmentationPolicyControls
                variant="speech-offline"
                value={segBatchConfig}
                onChange={setSegBatchConfig}
                disabled={busy || liveBusy}
              />
            </>
          ) : (
            <>
              <Text style={screenStyles.bodyText}>
                Live overload requires speech segmentation
                (speech_energy_silence or speech_vad_model). Off and manual are
                disabled.
              </Text>
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
            </>
          )}
        </View>

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
            <Text style={screenStyles.bodyText}>Speaker name</Text>
            <TextInput
              style={screenStyles.textInput}
              value={speakerName}
              onChangeText={setSpeakerName}
              autoCapitalize="none"
              editable={!busy && !liveBusy}
            />
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
                <Text style={screenStyles.primaryButtonText}>Enroll</Text>
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
                <Text style={screenStyles.primaryButtonText}>Identify</Text>
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
                <Text style={screenStyles.primaryButtonText}>Verify</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
                  screenStyles.flexButton,
                  (!canRunBatch || segBatchConfig.mode === 'off') &&
                    screenStyles.buttonDisabled,
                ]}
                onPress={() => {
                  handleLabelOffline().catch(() => {});
                }}
                disabled={!canRunBatch || segBatchConfig.mode === 'off'}
              >
                <Text style={screenStyles.primaryButtonText}>Label segs</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Live label</Text>
            <Text style={screenStyles.bodyText}>
              Enroll speakers offline first (switch to Offline batch, or use the
              buffer below after stopping live). Live only labels.
            </Text>
            <OfflineAudioBufferWidget
              ref={offlineWidgetRef}
              audioFiles={AUDIO_FILES}
              visible={engineReady && !liveBusy}
              disabled={!engineReady || busy || liveBusy}
              onBufferReady={setPreparedInputBuffer}
              onBufferReleased={() => setPreparedInputBuffer(null)}
            />
            <View style={screenStyles.buttonRow}>
              <TextInput
                style={[screenStyles.textInput, screenStyles.flexButton]}
                value={speakerName}
                onChangeText={setSpeakerName}
                autoCapitalize="none"
                editable={!busy && !liveBusy}
                placeholder="Speaker name"
              />
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
                  screenStyles.flexButton,
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
                <Text style={screenStyles.primaryButtonText}>Enroll</Text>
              </TouchableOpacity>
            </View>

            <Text style={screenStyles.cardTitle}>Source</Text>
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
                    liveSourceMode === mode && lpStyles.sourceToggleBtnActive,
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

            {liveSourceMode === 'file' ? (
              <>
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
                {liveFileSourceType === 'example' ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={screenStyles.chipRow}
                  >
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
                          >
                            {file.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
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
            ) : null}

            {liveRunState === 'idle' ? (
              <TouchableOpacity
                style={[
                  screenStyles.primaryButton,
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
                style={[screenStyles.primaryButton, screenStyles.stopButton]}
                onPress={() => {
                  handleStopLive().catch(() => {});
                }}
              >
                <Text style={screenStyles.primaryButtonText}>Stop</Text>
              </TouchableOpacity>
            )}
            {liveStatus ? (
              <Text style={screenStyles.bodyText}>{liveStatus}</Text>
            ) : null}
            {liveLabelLog.map((line) => (
              <Text key={line} style={screenStyles.monoResultText}>
                {line}
              </Text>
            ))}
          </View>
        )}

        {(error || actionResult || labeledLog.length > 0) && (
          <View style={screenStyles.card}>
            <Text style={screenStyles.cardTitle}>Result</Text>
            {error ? (
              <Text style={screenStyles.errorText}>
                [{errorSource ?? 'error'}] {error}
              </Text>
            ) : null}
            {actionResult ? (
              <Text style={screenStyles.monoResultText}>{actionResult}</Text>
            ) : null}
            {labeledLog.map((line) => (
              <Text key={line} style={screenStyles.monoResultText}>
                {line}
              </Text>
            ))}
          </View>
        )}

        <View style={screenStyles.card}>
          <Text style={screenStyles.cardTitle}>Export / import</Text>
          <Text style={screenStyles.bodyText}>
            Snapshot of the JS enrollment mirror. App owns persistence — this
            screen only shows the JSON.
          </Text>
          <TouchableOpacity
            style={[
              screenStyles.primaryButton,
              (!engineReady || busy || liveBusy) && screenStyles.buttonDisabled,
            ]}
            onPress={() => {
              handleExport().catch(() => {});
            }}
            disabled={!engineReady || busy || liveBusy}
          >
            <Text style={screenStyles.primaryButtonText}>
              Export enrollments
            </Text>
          </TouchableOpacity>
          {exportJson ? (
            <Text style={screenStyles.monoResultText} selectable>
              {exportJson}
            </Text>
          ) : null}
          <Text style={screenStyles.bodyText}>Import JSON</Text>
          <TextInput
            style={screenStyles.multilineInput}
            value={importJson}
            onChangeText={setImportJson}
            multiline
            editable={!busy && !liveBusy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={screenStyles.buttonRow}>
            <TouchableOpacity
              style={[
                screenStyles.primaryButton,
                screenStyles.flexButton,
                (!engineReady || !importJson.trim() || busy || liveBusy) &&
                  screenStyles.buttonDisabled,
              ]}
              onPress={() => {
                handleImport(false).catch(() => {});
              }}
              disabled={!engineReady || !importJson.trim() || busy || liveBusy}
            >
              <Text style={screenStyles.primaryButtonText}>Import</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                screenStyles.primaryButton,
                screenStyles.flexButton,
                (!engineReady || !importJson.trim() || busy || liveBusy) &&
                  screenStyles.buttonDisabled,
              ]}
              onPress={() => {
                handleImport(true).catch(() => {});
              }}
              disabled={!engineReady || !importJson.trim() || busy || liveBusy}
            >
              <Text style={screenStyles.primaryButtonText}>Import replace</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={screenStyles.footerHint}>
          Models: ModelCategory.SpeakerEmbedding · Live = offline weights +
          speech segmentation
        </Text>
      </ScrollView>
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
  stopButton: {
    backgroundColor: '#B42318',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  flexButton: {
    flex: 1,
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
  chipRow: {
    gap: 8,
    paddingVertical: 8,
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
