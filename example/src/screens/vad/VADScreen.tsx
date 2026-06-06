import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { listAssetModels } from 'react-native-sherpa-onnx/utils';
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
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  getPipelineSegmentBufferInfo,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type LiveSegmentBufferErrorEvent,
  type LiveSegmentBufferRef,
  type LiveSegmentBufferSegmentAppendedEvent,
  type OfflineSegmentBufferRef,
  type SegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createStreamingVAD,
  detectVadModel,
  assertVadCustomConfig,
  type VADEngine,
  type VADModelType,
  type VADOfflineRunOptions,
  type VADPipelineHandle,
  type VADPipelineStatus,
  type VADRuntimeOptions,
  type VADSummary,
} from 'react-native-sherpa-onnx/vad';
import {
  listDownloadedModels,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import {
  buildSegmentationOption,
  SegmentationPolicyControls,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import {
  InitModeSelector,
  ModelFolderGrid,
  VadCustomInitForm,
  type ModelInitMode,
  type VadCustomInitFormState,
} from '../../components/modelInit';
import { fillVadCustomConfigFromModelFolder } from '../../utils/vadCustomInitFill';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { AUDIO_FILES } from '../../audioConfig';

type Mode = 'live' | 'offline';
type LiveSource = 'file' | 'mic';
type StreamState = 'idle' | 'starting' | 'running' | 'stopping';

type TimelineEntry = {
  id: number;
  at: string;
  type: string;
  detail: string;
};

const TIMELINE_LIMIT = 200;
const SEGMENT_PREVIEW_LIMIT = 200;

const DEFAULT_VAD_CUSTOM_INIT: VadCustomInitFormState = {
  modelType: 'silero_vad',
  fileSources: {},
};

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

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return 'Unknown error';
}

function toFileSource(pathOrUri: string): FileSource {
  const trimmed = pathOrUri.trim();
  if (trimmed.startsWith('content://')) {
    return { kind: 'contentUri', uri: trimmed };
  }
  if (trimmed.startsWith('file://')) {
    return { kind: 'fs', path: decodeURI(trimmed.replace(/^file:\/\//, '')) };
  }
  return { kind: 'fs', path: trimmed };
}

export default function VADScreen() {
  const [mode, setMode] = useState<Mode>('live');
  const [liveSource, setLiveSource] = useState<LiveSource>('file');
  const [status, setStatus] = useState(
    'Load a model, then run VAD in live or offline mode.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [busyOffline, setBusyOffline] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customInitForm, setCustomInitForm] = useState<VadCustomInitFormState>(
    DEFAULT_VAD_CUSTOM_INIT
  );
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [sampleRateInput, setSampleRateInput] = useState('16000');
  const [chunkSizeInput, setChunkSizeInput] = useState('512');
  const [thresholdInput, setThresholdInput] = useState('0.5');
  const [speechEventMinInput, setSpeechEventMinInput] = useState('0');
  const [selectedLiveFileUri, setSelectedLiveFileUri] = useState<string | null>(
    null
  );
  const [selectedLiveFileName, setSelectedLiveFileName] = useState<
    string | null
  >(null);
  const [preparedOfflineInputBuffer, setPreparedOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [offlineSegConfig, setOfflineSegConfig] =
    useState<SegmentationControlConfig>({ mode: 'off' });
  const [ingestProgress, setIngestProgress] = useState<number | null>(null);
  const [engineInstanceId, setEngineInstanceId] = useState<string | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [isSpeechDetected, setIsSpeechDetected] = useState(false);
  const [pipelineStatus, setPipelineStatus] =
    useState<VADPipelineStatus | null>(null);
  const [summary, setSummary] = useState<VADSummary | null>(null);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const [segmentsExpanded, setSegmentsExpanded] = useState(true);

  const liveEngineRef = useRef<VADEngine | null>(null);
  const livePipelineRef = useRef<VADPipelineHandle | null>(null);
  const liveAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegmentRef = useRef<LiveSegmentBufferRef | null>(null);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const offlineSegmentRef = useRef<OfflineSegmentBufferRef | null>(null);
  const ingestRef = useRef<FileIngestHandle | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timelineIdRef = useRef(0);
  const liveUsingMicRef = useRef(false);
  const cleanupLockRef = useRef(false);

  const canStartLive =
    streamState === 'idle' &&
    !busyOffline &&
    !customFillLoading &&
    (initMode === 'custom'
      ? !!customInitForm.fileSources.model
      : !!selectedModelFolder) &&
    (liveSource === 'mic' || !!selectedLiveFileUri);

  const offlineSegReady =
    offlineSegConfig.mode === 'off' ||
    (offlineSegConfig.mode === 'auto' && offlineSegConfig.policy != null);

  const canStartOffline =
    !busyOffline &&
    !customFillLoading &&
    streamState === 'idle' &&
    (initMode === 'custom'
      ? !!customInitForm.fileSources.model
      : !!selectedModelFolder) &&
    preparedOfflineInputBuffer != null &&
    offlineSegReady;

  const isBusy = streamState !== 'idle' || busyOffline || customFillLoading;

  const catalogEntries = useMemo(
    () =>
      availableModels.map((id) => ({
        id,
        label: getModelDisplayName(id),
      })),
    [availableModels]
  );

  const pushTimeline = useCallback((type: string, detail: string) => {
    const now = new Date();
    setTimeline((prev) => {
      const next = [
        {
          id: ++timelineIdRef.current,
          at: now.toLocaleTimeString(),
          type,
          detail,
        },
        ...prev,
      ];
      return next.slice(0, TIMELINE_LIMIT);
    });
  }, []);

  const logOfflineLifecycle = useCallback((_step: string, _detail: string) => {
    // Intentionally no-op; keep call sites for fast local tracing toggles.
  }, []);

  const logLiveLifecycle = useCallback((_step: string, _detail: string) => {
    // Intentionally no-op; keep call sites for fast local tracing toggles.
  }, []);

  const waitForIngestDone = useCallback(
    async (ingest: FileIngestHandle, timeoutMs = 2000) => {
      const timeout = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id);
          reject(new Error('Timed out waiting for ingest termination.'));
        }, timeoutMs);
      });
      await Promise.race([ingest.done, timeout]);
    },
    []
  );

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Vad);
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds]
  );

  const detectResolvedModelType = useCallback(
    async (modelPath: FileSource): Promise<VADModelType> => {
      const detection = await detectVadModel(await toDetectSource(modelPath), {
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
    },
    []
  );

  const createVadEngine = useCallback(
    async (sampleRate: number, threshold: number): Promise<VADEngine> => {
      if (initMode === 'custom') {
        const modelSource = customInitForm.fileSources.model;
        if (!modelSource) {
          throw new Error('Pick a VAD model file for custom init.');
        }
        const customConfig = { model: modelSource };
        assertVadCustomConfig(
          customConfig as unknown as Record<string, unknown>
        );
        return createStreamingVAD({
          initMode: 'custom',
          modelType: customInitForm.modelType,
          customConfig,
          sampleRate,
          runtimeOptions: buildVadRuntimeOptions(
            customInitForm.modelType,
            threshold
          ),
        });
      }

      if (!selectedModelFolder) {
        throw new Error('Select a VAD model folder first.');
      }
      const modelPath = resolveModelPath(selectedModelFolder);
      const resolvedModelType = await detectResolvedModelType(modelPath);
      return createStreamingVAD({
        modelSource: modelPath,
        modelType: resolvedModelType,
        sampleRate,
        runtimeOptions: buildVadRuntimeOptions(resolvedModelType, threshold),
      });
    },
    [
      customInitForm.fileSources.model,
      customInitForm.modelType,
      detectResolvedModelType,
      initMode,
      resolveModelPath,
      selectedModelFolder,
    ]
  );

  const handleFillFromSelectedModel = useCallback(async () => {
    const modelFolder = selectedModelFolder;
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
    } catch (fillErr) {
      setCustomFillHint(null);
      setError(normalizeErrorMessage(fillErr));
    } finally {
      setCustomFillLoading(false);
    }
  }, [customInitForm.modelType, resolveModelPath, selectedModelFolder]);

  const handlePrepareScatteredTest = useCallback(() => {
    setCustomInitForm((prev) => ({ ...prev, fileSources: {} }));
    setCustomFillHint(
      'Scattered test: pick the model file from a different location, then run VAD.'
    );
  }, []);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const [assets, downloaded] = await Promise.all([
        listAssetModels(),
        listDownloadedModels(ModelCategory.Vad),
      ]);
      const assetModels = assets.map((m) => m.folder);
      const downloadedIds = downloaded.map((m) => m.id);
      const candidateModels = Array.from(
        new Set([...assetModels, ...downloadedIds])
      );
      const streamingModels: string[] = [];
      for (const modelFolder of candidateModels) {
        try {
          const modelPath = downloadedIds.includes(modelFolder)
            ? getFileModelPath(modelFolder, ModelCategory.Vad)
            : getAssetModelPath(modelFolder);
          const detection = await detectVadModel(
            await toDetectSource(modelPath),
            {
              modelType: 'auto',
            }
          );
          if (detection.success && detection.isStreaming) {
            streamingModels.push(modelFolder);
          }
        } catch {
          // Ignore candidates that fail detection; keep picker clean.
        }
      }
      setDownloadedModelIds(downloadedIds);
      setAvailableModels(streamingModels);
      setSelectedModelFolder((current) =>
        current && streamingModels.includes(current)
          ? current
          : streamingModels[0] ?? null
      );
    } catch (loadErr) {
      setError(normalizeErrorMessage(loadErr));
      setStatus('Failed to load VAD models.');
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const clearStatusPoll = useCallback(() => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
  }, []);

  const teardownLiveResources = useCallback(
    async (attemptStopPipeline: boolean) => {
      if (cleanupLockRef.current) return;
      cleanupLockRef.current = true;
      clearStatusPoll();
      try {
        const pipeline = livePipelineRef.current;
        if (pipeline) {
          logLiveLifecycle(
            'teardown.pipeline',
            `pipelineId=${pipeline.pipelineId}, attemptStop=${String(
              attemptStopPipeline
            )}`
          );
          pipeline.onSpeechStateChanged = undefined;
          if (attemptStopPipeline) {
            try {
              await pipeline.stop();
              logLiveLifecycle('teardown.pipeline.stop', pipeline.pipelineId);
            } catch {
              // Ignore stop races during teardown.
            }
          }
        }
        livePipelineRef.current = null;

        if (ingestRef.current) {
          const ingest = ingestRef.current;
          try {
            ingest.cancel();
            logLiveLifecycle(
              'teardown.ingest.cancel.requested',
              ingest.ingestId
            );
          } catch {
            // Ignore cancel races.
          }
          try {
            await waitForIngestDone(ingest);
            logLiveLifecycle('teardown.ingest.done', ingest.ingestId);
          } catch (ingestErr) {
            logLiveLifecycle(
              'teardown.ingest.done.error',
              normalizeErrorMessage(ingestErr)
            );
          }
          ingestRef.current = null;
        }

        if (liveUsingMicRef.current) {
          liveUsingMicRef.current = false;
          try {
            await stopMicToLiveAudioBuffer();
          } catch {
            // Ignore stop races.
          }
        }

        const engine = liveEngineRef.current;
        liveEngineRef.current = null;
        if (engine) {
          await engine.destroy().catch(() => {});
        }

        const segment = liveSegmentRef.current;
        liveSegmentRef.current = null;
        if (segment) {
          logLiveLifecycle('teardown.segment.release', segment.bufferId);
          segment.unsubscribeEvents();
          await releasePipelineSegmentBuffer(segment).catch(() => {});
        }

        const audio = liveAudioRef.current;
        liveAudioRef.current = null;
        if (audio) {
          logLiveLifecycle('teardown.audio.release', audio.bufferId);
          audio.unsubscribeEvents();
          await releasePipelineAudioBuffer(audio).catch(() => {});
        }
      } finally {
        cleanupLockRef.current = false;
      }
    },
    [clearStatusPoll, logLiveLifecycle, waitForIngestDone]
  );

  const clearOfflineBuffers = useCallback(async () => {
    const seg = offlineSegmentRef.current;
    offlineSegmentRef.current = null;
    if (seg) {
      console.log(
        `[VADScreen][offline][segment] clearOfflineBuffers.release: ${seg.bufferId}`
      );
      await releasePipelineSegmentBuffer(seg).catch(() => {});
    }
  }, []);

  const pickLiveFile = useCallback(async () => {
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri =
        file.uri ??
        (file as any).fileCopyUri ??
        (file as any).localUri ??
        (file as any).nativeUri;
      if (!uri) throw new Error('Could not resolve a file URI from picker.');
      setSelectedLiveFileUri(uri);
      setSelectedLiveFileName(
        file.name || uri.split('/').pop() || 'audio-file'
      );
      setStatus('Live input file selected.');
    } catch (pickErr: any) {
      const isCancel =
        (DocumentPicker as any)?.isCancel?.(pickErr) ||
        pickErr?.code === 'DOCUMENT_PICKER_CANCELED' ||
        pickErr?.name === 'DocumentPickerCanceled';
      if (!isCancel) {
        Alert.alert('File pick error', normalizeErrorMessage(pickErr));
      }
    }
  }, []);

  const startLive = useCallback(async () => {
    if (initMode === 'auto' && !selectedModelFolder) return;
    if (initMode === 'custom' && !customInitForm.fileSources.model) {
      setError('Pick a VAD model file for custom init.');
      return;
    }
    if (liveSource === 'file' && !selectedLiveFileUri) {
      setError('Select an audio file for live file-ingest mode.');
      return;
    }

    setError(null);
    setSummary(null);
    setSegments([]);
    setTimeline([]);
    setPipelineStatus(null);
    setIngestProgress(null);
    setIsSpeechDetected(false);
    setStreamState('starting');
    setStatus('Starting VAD live pipeline...');
    pushTimeline('run.started', 'Preparing live buffers and VAD engine.');
    logLiveLifecycle(
      'run.start',
      `source=${liveSource}, model=${selectedModelFolder ?? '-'}, file=${
        selectedLiveFileName ?? '-'
      }`
    );

    try {
      const sampleRate = Math.max(
        8000,
        Number.parseInt(sampleRateInput, 10) || 16000
      );
      const chunkSize = Math.max(1, Number.parseInt(chunkSizeInput, 10) || 512);
      const threshold = Number.parseFloat(thresholdInput);
      const speechStateEventMinIntervalMs = Math.max(
        0,
        Number.parseInt(speechEventMinInput, 10) || 0
      );

      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
      });
      liveAudioRef.current = liveAudio;
      logLiveLifecycle(
        'audio.created',
        `bufferId=${liveAudio.bufferId}, sampleRate=${sampleRate}`
      );

      const liveSegment = await createLiveSegmentBuffer({
        sourceAudioBufferId: liveAudio.bufferId,
        maxSegments: 2048,
        spooling: { mode: 'on' },
        streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
        onSegmentAppended: (event: LiveSegmentBufferSegmentAppendedEvent) => {
          logLiveLifecycle(
            'segment.appended',
            `index=${event.segmentIndex}, id=${event.segmentId}, samples=${event.startSample}-${event.endSample}, durationMs=${event.durationMs}`
          );
          pushTimeline(
            'segment.appended',
            `#${event.segmentIndex} ${event.startSample}-${event.endSample} (${event.durationMs}ms)`
          );
          setSegments((prev) => {
            const base = {
              id: event.segmentId,
              sourceAudioBufferId: event.sourceAudioBufferId,
              startSample: event.startSample,
              endSample: event.endSample,
              sampleRate: event.sampleRate,
              durationMs: event.durationMs,
              ...(typeof event.confidence === 'number'
                ? { confidence: event.confidence }
                : {}),
            };
            const next: SegmentMeta =
              event.kind === 'alignment'
                ? {
                    ...base,
                    kind: 'alignment',
                    ...(event.payload ? { payload: event.payload } : {}),
                  }
                : {
                    ...base,
                    kind: 'speech',
                    ...(event.payload ? { payload: event.payload } : {}),
                  };
            const merged = [...prev, next];
            return merged.slice(-SEGMENT_PREVIEW_LIMIT);
          });
        },
        onError: (event: LiveSegmentBufferErrorEvent) => {
          logLiveLifecycle('segment.error', event.message);
          pushTimeline('segment.error', event.message);
          setError(event.message);
        },
      });
      liveSegmentRef.current = liveSegment;
      logLiveLifecycle('segment.created', `bufferId=${liveSegment.bufferId}`);

      const engine = await createVadEngine(sampleRate, threshold);
      liveEngineRef.current = engine;
      setEngineInstanceId(engine.instanceId);
      logLiveLifecycle('engine.created', `instanceId=${engine.instanceId}`);

      const run = await engine.process({
        audioIn: liveAudio,
        segmentOut: liveSegment,
        options: {
          chunkSize,
          autoFlushOnInputEnded: false,
          speechStateEventMinIntervalMs,
        },
      });
      if (!('pipelineId' in run)) {
        throw new Error(
          'Expected live pipeline handle but got offline result.'
        );
      }
      livePipelineRef.current = run;
      setPipelineId(run.pipelineId);
      pushTimeline('pipeline.ready', run.pipelineId);
      logLiveLifecycle('pipeline.ready', run.pipelineId);

      run.onSpeechStateChanged = (event) => {
        setIsSpeechDetected(event.isSpeechDetected);
        logLiveLifecycle(
          'speech.stateChanged',
          `detected=${String(event.isSpeechDetected)}, ts=${event.ts}`
        );
        pushTimeline(
          'speech.stateChanged',
          `detected=${String(event.isSpeechDetected)}`
        );
      };

      statusPollRef.current = setInterval(() => {
        const pipeline = livePipelineRef.current;
        if (!pipeline) return;
        pipeline
          .getStatus()
          .then((s) => {
            logLiveLifecycle(
              'pipeline.status',
              `running=${String(s.isRunning)}, queueDepth=${
                s.queueDepth
              }, chunks=${s.chunksProcessed}, unitsRead=${
                s.unitsRead
              }, unitsWritten=${s.unitsWritten}`
            );
            setPipelineStatus(s);
          })
          .catch((statusErr) => {
            logLiveLifecycle(
              'pipeline.status.error',
              normalizeErrorMessage(statusErr)
            );
          });
      }, 600);

      if (liveSource === 'file' && selectedLiveFileUri) {
        logLiveLifecycle(
          'ingest.start',
          `audioBufferId=${liveAudio.bufferId}, file=${selectedLiveFileUri}`
        );
        const ingest = await ingestFileToLiveAudioBuffer(
          liveAudio,
          toFileSource(selectedLiveFileUri),
          {
            // Deterministic template flow: user explicitly finishes the pipeline.
            autoFinalize: false,
            onProgress: (event) => {
              setIngestProgress(event.percent);
              logLiveLifecycle(
                'ingest.progress',
                `${Math.round(event.percent ?? 0)}%`
              );
            },
          }
        );
        ingestRef.current = ingest;
        ingest.done
          .then((result) => {
            logLiveLifecycle(
              'ingest.done.result',
              `autoFinalized=${String(result.autoFinalized)}, totalFrames=${
                result.totalFramesIngested
              }, sourceRate=${result.sourceSampleRate}, sourceChannels=${
                result.sourceChannels
              }`
            );
            logLiveLifecycle(
              'ingest.completed',
              'Audio fully appended. Press Finish to finalize input and complete.'
            );
            pushTimeline('ingest.completed', 'Live input file fully appended.');
            setStatus(
              'File ingest finished. Use "Finish" to finalize input and complete.'
            );
          })
          .catch((ingestErr) => {
            logLiveLifecycle('ingest.error', normalizeErrorMessage(ingestErr));
            setError(normalizeErrorMessage(ingestErr));
            pushTimeline('ingest.error', normalizeErrorMessage(ingestErr));
          });
      } else {
        await startMicToLiveAudioBuffer(liveAudio);
        liveUsingMicRef.current = true;
        logLiveLifecycle('mic.started', `audioBufferId=${liveAudio.bufferId}`);
        setStatus(
          'Microphone capture active. Speak, then press Finish or Stop.'
        );
        pushTimeline('mic.started', 'Live mic capture started.');
      }

      setStreamState('running');
      setStatus((prev) =>
        prev.startsWith('Microphone')
          ? prev
          : 'Live VAD running. Watch speech and segment events.'
      );
    } catch (startErr) {
      const message = normalizeErrorMessage(startErr);
      logLiveLifecycle('run.error', message);
      setError(message);
      setStatus('Live VAD failed to start.');
      pushTimeline('run.error', message);
      await teardownLiveResources(true);
      setStreamState('idle');
      setEngineInstanceId(null);
      setPipelineId(null);
    }
  }, [
    chunkSizeInput,
    liveSource,
    logLiveLifecycle,
    pushTimeline,
    createVadEngine,
    customInitForm.fileSources.model,
    initMode,
    sampleRateInput,
    selectedLiveFileName,
    selectedLiveFileUri,
    selectedModelFolder,
    speechEventMinInput,
    teardownLiveResources,
    thresholdInput,
  ]);

  const stopLiveGraceful = useCallback(async () => {
    const pipeline = livePipelineRef.current;
    if (!pipeline || streamState !== 'running') return;
    setStreamState('stopping');
    setError(null);
    setStatus('Stopping live pipeline gracefully...');
    pushTimeline(
      'run.stop.graceful.requested',
      'Finalizing input and awaiting completion.'
    );
    logLiveLifecycle(
      'stop.graceful.requested',
      `pipelineId=${pipeline.pipelineId}`
    );
    try {
      try {
        const statusBeforeStop = await pipeline.getStatus();
        logLiveLifecycle(
          'stop.graceful.status.before',
          `running=${String(statusBeforeStop.isRunning)}, queueDepth=${
            statusBeforeStop.queueDepth
          }, chunks=${statusBeforeStop.chunksProcessed}, unitsRead=${
            statusBeforeStop.unitsRead
          }, unitsWritten=${statusBeforeStop.unitsWritten}, error=${
            statusBeforeStop.error ?? 'null'
          }`
        );
      } catch (statusErr) {
        logLiveLifecycle(
          'stop.graceful.status.before.error',
          normalizeErrorMessage(statusErr)
        );
      }

      if (liveSource === 'file') {
        const ingest = ingestRef.current;
        if (ingest) {
          try {
            ingest.cancel();
            logLiveLifecycle(
              'stop.graceful.ingest.cancel.requested',
              ingest.ingestId
            );
          } catch (cancelErr) {
            logLiveLifecycle(
              'stop.graceful.ingest.cancel.error',
              normalizeErrorMessage(cancelErr)
            );
          }
          try {
            await waitForIngestDone(ingest);
            logLiveLifecycle('stop.graceful.ingest.done', ingest.ingestId);
          } catch (ingestErr) {
            logLiveLifecycle(
              'stop.graceful.ingest.done.error',
              normalizeErrorMessage(ingestErr)
            );
          } finally {
            ingestRef.current = null;
          }
        }
        const audio = liveAudioRef.current;
        if (audio) {
          await finalizeLiveAudioBuffer(audio);
          logLiveLifecycle(
            'stop.graceful.input.finalized',
            `live buffer finalized: ${audio.bufferId}`
          );
        }
      } else if (liveUsingMicRef.current) {
        try {
          await stopMicToLiveAudioBuffer();
          liveUsingMicRef.current = false;
          logLiveLifecycle(
            'stop.graceful.mic.stopped',
            'Microphone capture stopped.'
          );
        } catch (micErr) {
          logLiveLifecycle(
            'stop.graceful.mic.stop.error',
            normalizeErrorMessage(micErr)
          );
        }
        const audio = liveAudioRef.current;
        if (audio) {
          await finalizeLiveAudioBuffer(audio);
          logLiveLifecycle(
            'stop.graceful.input.finalized',
            `live buffer finalized: ${audio.bufferId}`
          );
        }
      }

      logLiveLifecycle(
        'stop.graceful.await.completed',
        'Input finalized; awaiting pipeline.completed.'
      );
      const result = await pipeline.completed;
      logLiveLifecycle(
        'stop.graceful.completed',
        `segments=${result.segmentCount}, speechMs=${result.speechDurationMs}`
      );
      setSummary(result);
      pushTimeline(
        'run.completed',
        `segments=${result.segmentCount}, speechMs=${result.speechDurationMs}`
      );

      const segBuffer = liveSegmentRef.current;
      if (segBuffer) {
        const count = await getLiveSegmentBufferSegmentCount(segBuffer);
        logLiveLifecycle('stop.graceful.segment.count', String(count));
        const all =
          count > 0
            ? await getLiveSegmentBufferSegments(segBuffer, 0, count)
            : [];
        setSegments(all.slice(-SEGMENT_PREVIEW_LIMIT));
      }

      setStatus('Live run completed successfully (graceful stop).');
      await teardownLiveResources(false);
      setStreamState('idle');
      setPipelineStatus(null);
      setEngineInstanceId(null);
      setPipelineId(null);
    } catch (stopErr) {
      const message = normalizeErrorMessage(stopErr);
      logLiveLifecycle('stop.graceful.error', message);
      setError(message);
      setStatus('Live graceful stop failed.');
      pushTimeline('run.error', message);
      await teardownLiveResources(true);
      setStreamState('idle');
      setPipelineStatus(null);
      setEngineInstanceId(null);
      setPipelineId(null);
    }
  }, [
    liveSource,
    logLiveLifecycle,
    pushTimeline,
    streamState,
    teardownLiveResources,
    waitForIngestDone,
  ]);

  const abortLive = useCallback(async () => {
    if (streamState === 'idle') return;
    setStreamState('stopping');
    setStatus('Aborting live pipeline...');
    pushTimeline('run.abort.requested', 'Aborting active live pipeline.');
    logLiveLifecycle('run.abort.requested', 'stop() without graceful flush');
    await teardownLiveResources(true);
    setStreamState('idle');
    setPipelineStatus(null);
    setEngineInstanceId(null);
    setPipelineId(null);
    setStatus('Live run aborted.');
  }, [logLiveLifecycle, pushTimeline, streamState, teardownLiveResources]);

  const runOffline = useCallback(async () => {
    if (initMode === 'auto' && !selectedModelFolder) {
      setError('Select a VAD model first.');
      return;
    }
    if (initMode === 'custom' && !customInitForm.fileSources.model) {
      setError('Pick a VAD model file for custom init.');
      return;
    }
    if (!preparedOfflineInputBuffer) {
      setError('Prepare offline audio (example or file) first.');
      return;
    }

    setError(null);
    setSummary(null);
    setSegments([]);
    pushTimeline('run.started', 'Offline VAD on prepared buffer.');
    logOfflineLifecycle('run.start', `model=${selectedModelFolder}`);

    let createdEngine: VADEngine | null = null;
    let createdSegment: OfflineSegmentBufferRef | null = null;

    setBusyOffline(true);

    try {
      const existingSegment = offlineSegmentRef.current;
      if (existingSegment) {
        await releasePipelineSegmentBuffer(existingSegment);
        logOfflineLifecycle(
          'segment.release.prev.done',
          existingSegment.bufferId
        );
      }

      const sampleRate = Math.max(
        8000,
        Number.parseInt(sampleRateInput, 10) || 16000
      );
      const threshold = Number.parseFloat(thresholdInput);
      const segment = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: preparedOfflineInputBuffer.bufferId,
      });
      createdSegment = segment;
      offlineSegmentRef.current = segment;
      logOfflineLifecycle('segment.create', segment.bufferId);
      const beforeInfo = await getPipelineSegmentBufferInfo(segment);
      logOfflineLifecycle(
        'segment.info.beforeProcess',
        `id=${segment.bufferId}, count=${beforeInfo.segmentCount ?? 0}, state=${
          beforeInfo.state
        }`
      );

      const engine = await createVadEngine(sampleRate, threshold);
      createdEngine = engine;

      const builtSeg = buildSegmentationOption(offlineSegConfig);
      let processOptions: VADOfflineRunOptions | undefined;
      if (builtSeg?.mode === 'auto' && builtSeg.policy) {
        processOptions = {
          segmentation: { mode: 'auto', policy: builtSeg.policy },
          onProgress: (p) => {
            pushTimeline(
              'vad.offline.progress',
              `${p.currentSegment + 1}/${
                p.totalSegments
              } · fraction ${p.fraction.toFixed(2)}`
            );
          },
        };
      } else if (builtSeg?.mode === 'off') {
        processOptions = { segmentation: { mode: 'off' } };
      }

      const run = await engine.process({
        audioIn: preparedOfflineInputBuffer.bufferId,
        segmentOut: segment,
        options: processOptions ?? {},
      });
      if (!('summary' in run)) {
        throw new Error('Expected offline VAD result but got live handle.');
      }
      setSummary(run.summary);
      pushTimeline(
        'run.completed',
        `segments=${run.summary.segmentCount}, speechMs=${run.summary.speechDurationMs}`
      );
      const afterInfo = await getPipelineSegmentBufferInfo(segment);
      logOfflineLifecycle(
        'segment.info.afterProcess',
        `id=${segment.bufferId}, count=${afterInfo.segmentCount ?? 0}, state=${
          afterInfo.state
        }`
      );
      const all =
        run.summary.segmentCount > 0
          ? await getOfflineSegmentBufferSegments(
              segment,
              0,
              run.summary.segmentCount
            )
          : [];
      setSegments(all.slice(-SEGMENT_PREVIEW_LIMIT));

      await engine.destroy();
      createdEngine = null;
      setStatus('Offline run completed successfully.');
    } catch (offlineErr) {
      const message = normalizeErrorMessage(offlineErr);
      setError(message);
      setStatus('Offline run failed.');
      pushTimeline('run.error', message);
      logOfflineLifecycle('run.error', message);
    } finally {
      if (createdEngine) {
        await createdEngine.destroy().catch(() => {});
      }
      if (createdSegment) {
        logOfflineLifecycle(
          'segment.release.finally.start',
          createdSegment.bufferId
        );
        await releasePipelineSegmentBuffer(createdSegment).catch((err) => {
          logOfflineLifecycle(
            'segment.release.finally.error',
            normalizeErrorMessage(err)
          );
        });
        logOfflineLifecycle(
          'segment.release.finally.done',
          createdSegment.bufferId
        );
      }
      if (
        offlineSegmentRef.current &&
        createdSegment &&
        offlineSegmentRef.current.bufferId === createdSegment.bufferId
      ) {
        offlineSegmentRef.current = null;
      }
      setBusyOffline(false);
    }
  }, [
    logOfflineLifecycle,
    offlineSegConfig,
    preparedOfflineInputBuffer,
    pushTimeline,
    createVadEngine,
    customInitForm.fileSources.model,
    initMode,
    sampleRateInput,
    selectedModelFolder,
    thresholdInput,
  ]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    loadModels().catch(() => {});
  }, [loadModels]);

  useEffect(() => {
    return () => {
      (async () => {
        await teardownLiveResources(true);
        await clearOfflineBuffers();
      })().catch(() => {});
    };
  }, [clearOfflineBuffers, teardownLiveResources]);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="pulse-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Voice Activity Detection</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Intro</Text>
          <Text style={styles.description}>
            Standalone VAD showcase with live pipeline and offline batch.
            Offline supports optional speech segmentation (same controls as
            offline STT). SegmentBuffer is the primary output contract.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Mode</Text>
          <View style={styles.toggleRow}>
            <Pressable
              style={[
                styles.toggleChip,
                mode === 'live' && styles.toggleChipActive,
              ]}
              onPress={() => setMode('live')}
              disabled={isBusy}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  mode === 'live' && styles.toggleChipTextActive,
                ]}
              >
                Live
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.toggleChip,
                mode === 'offline' && styles.toggleChipActive,
              ]}
              onPress={() => setMode('offline')}
              disabled={isBusy}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  mode === 'offline' && styles.toggleChipTextActive,
                ]}
              >
                Offline
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Engine config</Text>
          <InitModeSelector
            value={initMode}
            onChange={setInitMode}
            disabled={isBusy}
          />
          <Text style={styles.mutedText}>
            {initMode === 'auto'
              ? 'Select a model folder; type is detected when you start live or offline VAD.'
              : 'Choose silero_vad or ten_vad, pick the ONNX file (or Fill from catalog), then run VAD.'}
          </Text>
          {loadingModels ? (
            <View style={styles.inlineRow}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>
                Detecting available VAD models...
              </Text>
            </View>
          ) : availableModels.length === 0 ? (
            <Text style={styles.warningText}>
              No streaming VAD model found. Download one from Downloadmanager
              first.
            </Text>
          ) : (
            <ModelFolderGrid
              entries={catalogEntries}
              selectedId={selectedModelFolder}
              initializedId={null}
              onSelect={setSelectedModelFolder}
              loading={loadingModels}
              disabled={isBusy}
              emptyMessage="No streaming VAD models found."
            />
          )}
          {initMode === 'custom' ? (
            <VadCustomInitForm
              value={customInitForm}
              onChange={setCustomInitForm}
              selectedCatalogModelId={selectedModelFolder}
              onFillFromSelectedModel={() => {
                handleFillFromSelectedModel().catch(() => {});
              }}
              onPrepareScatteredTest={handlePrepareScatteredTest}
              fillLoading={customFillLoading}
              disabled={isBusy}
              fillHint={customFillHint}
            />
          ) : null}
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>sampleRate: {sampleRateInput}</Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setSampleRateInput((prev) =>
                  prev === '16000' ? '8000' : '16000'
                )
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>
              chunkSize (live drain): {chunkSizeInput}
            </Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setChunkSizeInput((prev) => (prev === '512' ? '320' : '512'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>threshold: {thresholdInput}</Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setThresholdInput((prev) => (prev === '0.5' ? '0.35' : '0.5'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>
              speechStateEventMinIntervalMs: {speechEventMinInput}
            </Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setSpeechEventMinInput((prev) => (prev === '0' ? '120' : '0'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <Pressable
            style={[styles.secondaryButton, isBusy && styles.buttonDisabled]}
            disabled={isBusy}
            onPress={() => {
              loadModels().catch(() => {});
            }}
          >
            <Text style={styles.secondaryButtonText}>Reload model list</Text>
          </Pressable>
        </View>

        {mode === 'live' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input / output setup (Live)</Text>
            <View style={styles.toggleRow}>
              <Pressable
                style={[
                  styles.toggleChip,
                  liveSource === 'file' && styles.toggleChipActive,
                ]}
                onPress={() => setLiveSource('file')}
                disabled={streamState !== 'idle'}
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    liveSource === 'file' && styles.toggleChipTextActive,
                  ]}
                >
                  File ingest
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.toggleChip,
                  liveSource === 'mic' && styles.toggleChipActive,
                ]}
                onPress={() => setLiveSource('mic')}
                disabled={streamState !== 'idle'}
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    liveSource === 'mic' && styles.toggleChipTextActive,
                  ]}
                >
                  Microphone
                </Text>
              </Pressable>
            </View>

            {liveSource === 'file' ? (
              <>
                <Text style={styles.mutedText}>
                  Start begins ingest + streaming VAD. Stop performs graceful
                  finalize completion. Abort cancels immediately.
                </Text>
                <Pressable
                  style={[
                    styles.secondaryButton,
                    streamState !== 'idle' && styles.buttonDisabled,
                  ]}
                  onPress={() => {
                    pickLiveFile().catch(() => {});
                  }}
                  disabled={streamState !== 'idle'}
                >
                  <Text style={styles.secondaryButtonText}>
                    Pick live input file
                  </Text>
                </Pressable>
                <Text style={styles.mutedText}>
                  {selectedLiveFileName ?? 'No file selected'}
                </Text>
                {typeof ingestProgress === 'number' ? (
                  <Text style={styles.mutedText}>
                    Ingest progress: {ingestProgress}%
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Text style={styles.mutedText}>
                  Mic mode captures directly into LiveAudioBuffer when starting.
                  Stop performs graceful finalize completion. Abort cancels
                  immediately.
                </Text>
              </>
            )}

            <View style={styles.actionRow}>
              <Pressable
                style={[
                  styles.primaryButton,
                  !canStartLive && styles.buttonDisabled,
                ]}
                onPress={() => {
                  startLive().catch(() => {});
                }}
                disabled={!canStartLive}
              >
                <Text style={styles.primaryButtonText}>Start Live</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.primaryButton,
                  streamState !== 'running' && styles.buttonDisabled,
                ]}
                onPress={() => {
                  stopLiveGraceful().catch(() => {});
                }}
                disabled={streamState !== 'running'}
              >
                <Text style={styles.primaryButtonText}>Stop</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.dangerButton,
                  streamState === 'idle' && styles.buttonDisabled,
                ]}
                onPress={() => {
                  abortLive().catch(() => {});
                }}
                disabled={streamState === 'idle'}
              >
                <Text style={styles.primaryButtonText}>Abort</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input / output setup (Offline)</Text>
            <OfflineAudioBufferWidget
              ref={offlineWidgetRef}
              audioFiles={AUDIO_FILES}
              disabled={busyOffline}
              onBufferReady={(info) => {
                setPreparedOfflineInputBuffer(info);
                setSummary(null);
                setSegments([]);
                setError(null);
                setStatus('Offline input prepared. Ready to run VAD.');
              }}
              onBufferReleased={() => {
                setPreparedOfflineInputBuffer(null);
                setSummary(null);
                setSegments([]);
                setStatus('Offline input buffer removed.');
              }}
            />
            <Text style={styles.mutedText}>
              Segmentation uses the same engine as offline STT (speech domain).{' '}
              <Text style={{ fontWeight: '600' }}>Off</Text> = one native pass
              over the file. <Text style={{ fontWeight: '600' }}>Auto</Text> =
              split into speech slices, then VAD per slice; progress events go
              to the timeline.
            </Text>
            <SegmentationPolicyControls
              variant="speech-offline"
              value={offlineSegConfig}
              onChange={setOfflineSegConfig}
              disabled={busyOffline}
            />
            <Pressable
              style={[
                styles.primaryButton,
                !canStartOffline && styles.buttonDisabled,
              ]}
              onPress={() => {
                runOffline().catch(() => {});
              }}
              disabled={!canStartOffline}
            >
              <Text style={styles.primaryButtonText}>Run Offline VAD</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Runtime status</Text>
          <Text style={styles.monoText}>state: {streamState}</Text>
          <Text style={styles.monoText}>engine: {engineInstanceId ?? '-'}</Text>
          <Text style={styles.monoText}>pipeline: {pipelineId ?? '-'}</Text>
          <Text style={styles.monoText}>
            speechDetected: {isSpeechDetected ? 'true' : 'false'}
          </Text>
          <Text style={styles.monoText}>
            isRunning: {String(pipelineStatus?.isRunning)}
          </Text>
          <Text style={styles.monoText}>
            isFlushing: {String(pipelineStatus?.isFlushing)}
          </Text>
          <Text style={styles.monoText}>
            queueDepth: {pipelineStatus?.queueDepth ?? 0}
          </Text>
          <Text style={styles.monoText}>
            chunksProcessed:{' '}
            {pipelineStatus?.chunksProcessed ?? summary?.chunksProcessed ?? 0}
          </Text>
          <Text style={styles.monoText}>
            unitsRead: {pipelineStatus?.unitsRead ?? summary?.unitsRead ?? 0}
          </Text>
          <Text style={styles.monoText}>
            unitsWritten:{' '}
            {pipelineStatus?.unitsWritten ?? summary?.unitsWritten ?? 0}
          </Text>
          {summary ? (
            <Text style={styles.monoText}>
              summary: segments={summary.segmentCount}, speechMs=
              {summary.speechDurationMs}
            </Text>
          ) : null}
          <Text style={styles.statusText}>{status}</Text>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable style={styles.smallButton} onPress={clearError}>
                <Text style={styles.smallButtonText}>Clear Error</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Pressable
            style={styles.sectionHeaderButton}
            onPress={() => setTimelineExpanded((prev) => !prev)}
          >
            <Text style={styles.cardTitle}>Event timeline</Text>
            <Text style={styles.sectionHeaderChevron}>
              {timelineExpanded ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
          {timelineExpanded ? (
            timeline.length === 0 ? (
              <Text style={styles.mutedText}>No events yet.</Text>
            ) : (
              timeline.map((item) => (
                <View key={item.id} style={styles.timelineRow}>
                  <Text style={styles.timelineTime}>{item.at}</Text>
                  <View style={styles.timelineBody}>
                    <Text style={styles.timelineType}>{item.type}</Text>
                    <Text style={styles.timelineDetail}>{item.detail}</Text>
                  </View>
                </View>
              ))
            )
          ) : null}
        </View>

        <View style={styles.card}>
          <Pressable
            style={styles.sectionHeaderButton}
            onPress={() => setSegmentsExpanded((prev) => !prev)}
          >
            <Text style={styles.cardTitle}>
              Segment results ({segments.length})
            </Text>
            <Text style={styles.sectionHeaderChevron}>
              {segmentsExpanded ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
          {segmentsExpanded ? (
            segments.length === 0 ? (
              <Text style={styles.mutedText}>No segments yet.</Text>
            ) : (
              segments.map((segment, idx) => (
                <View key={`${segment.id}_${idx}`} style={styles.segmentRow}>
                  <Text style={styles.segmentTitle}>
                    #{idx} {segment.id}
                  </Text>
                  <Text style={styles.segmentMeta}>
                    {segment.startSample}-{segment.endSample} (
                    {segment.durationMs}ms)
                  </Text>
                  <Text style={styles.segmentMeta}>
                    sampleRate={segment.sampleRate}
                  </Text>
                  {typeof segment.confidence === 'number' ? (
                    <Text style={styles.segmentMeta}>
                      confidence={segment.confidence.toFixed(3)}
                    </Text>
                  ) : null}
                </View>
              ))
            )
          ) : null}
        </View>
      </ScrollView>
      <ScreenIntroModal screenId="VAD" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#EAF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#111827',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 10,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  sectionHeaderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHeaderChevron: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
  },
  description: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  toggleChipActive: {
    backgroundColor: '#0F62FE',
    borderColor: '#0F62FE',
  },
  toggleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1F2937',
  },
  toggleChipTextActive: {
    color: '#FFFFFF',
  },
  modelList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modelChip: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#FFFFFF',
  },
  modelChipActive: {
    backgroundColor: '#EAF2FF',
    borderColor: '#0F62FE',
  },
  modelChipText: {
    fontSize: 13,
    color: '#1F2937',
  },
  modelChipTextActive: {
    color: '#0F62FE',
    fontWeight: '600',
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inputLabel: {
    flex: 1,
    fontSize: 13,
    color: '#374151',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: '#0F62FE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: '#D92D20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  smallButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  monoText: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#111827',
  },
  statusText: {
    fontSize: 13,
    color: '#374151',
    marginTop: 4,
  },
  mutedText: {
    fontSize: 13,
    color: '#6B7280',
  },
  warningText: {
    fontSize: 13,
    color: '#92400E',
  },
  errorBox: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    padding: 10,
    gap: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#991B1B',
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  timelineTime: {
    width: 74,
    fontSize: 11,
    color: '#6B7280',
  },
  timelineBody: {
    flex: 1,
    gap: 2,
  },
  timelineType: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1F2937',
  },
  timelineDetail: {
    fontSize: 12,
    color: '#4B5563',
  },
  segmentRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    padding: 10,
    gap: 2,
  },
  segmentTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  segmentMeta: {
    fontSize: 12,
    color: '#4B5563',
  },
});
