import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  createStreamingSTT,
  detectSttModel,
  type LiveSttEngine,
  type SttPipelineHandle,
} from 'react-native-sherpa-onnx/stt';
import {
  createStreamingTTS,
  detectTtsModel,
  type StreamingTtsEngine,
  type TtsPipelineHandle,
  type TtsPipelineOptions,
} from 'react-native-sherpa-onnx/tts';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromLive,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
  type OfflineAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  appendLiveTextSegment,
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import {
  listAvailableInputDevices,
  listAvailableOutputDevices,
  setPipelineAudioRoutePreference,
} from 'react-native-sherpa-onnx/audio';
import { AudioSaveDestinationPicker } from '../../components/AudioSaveDestinationPicker';
import { formatResolvedLocation } from '../../components/audioSaveUtils';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { styles } from './PipelineShowcaseScreen.styles';
import { AudioDeviceDropdown } from '../../components/AudioDeviceDropdown';
import {
  keepValidDeviceSelection,
  type AudioRouteDevice,
} from '../../utils/audioDevices';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

const PAD_PACK_NAME = 'sherpa_models';
const STT_INPUT_SAMPLE_RATE = 16000;
const POLL_INTERVAL_MS = 150;

type SessionMode = 'realtime' | 'finalize';
type SourceMode = 'mic' | 'file';

type SavedOutputInfo = {
  bufferId: string;
  sampleRate: number;
  numSamples: number;
};

type PipelineStep = {
  key: 'stt' | 'segment' | 'tts' | 'playback';
  label: string;
  active: boolean;
};

type StreamingSessionController = {
  pipeline: TtsPipelineHandle;
  pushText: (text: string) => void;
  commit: (_options?: { force?: boolean }) => void;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
  getMetrics: () => { queueDepth: number };
  readonly state: 'active' | 'idle';
};

type StreamingSessionEngine = {
  getSampleRate: () => Promise<number>;
  startSession: (
    audioOut: LiveAudioBufferRef,
    options?: TtsPipelineOptions
  ) => Promise<StreamingSessionController>;
  destroy: () => Promise<void>;
};

async function createStreamingSessionEngine(options: {
  modelSource: FileSource;
  modelType: 'auto';
  numThreads: number;
  debug: boolean;
}): Promise<StreamingSessionEngine> {
  const ttsEngine: StreamingTtsEngine = await createStreamingTTS(options);
  let activePipeline: TtsPipelineHandle | null = null;
  let activeTextBufferId: string | null = null;
  let activeState: 'active' | 'idle' = 'idle';

  const releaseTextBufferIfNeeded = async () => {
    if (!activeTextBufferId) return;
    const id = activeTextBufferId;
    activeTextBufferId = null;
    await releasePipelineTextBuffer(id).catch(() => {});
  };

  return {
    getSampleRate: () => ttsEngine.getSampleRate(),
    async startSession(audioOut, pipelineOptions) {
      const textBuffer = await createLiveTextBuffer({
        windowMaxChars: 65536,
        maxSegments: 4096,
      });
      activeTextBufferId = textBuffer.bufferId;
      const pipeline = await ttsEngine.synthesize(
        textBuffer.bufferId,
        audioOut.bufferId,
        {
          ...(pipelineOptions ?? {}),
          segmentation: { mode: 'auto' },
        }
      );
      activePipeline = pipeline;
      activeState = 'active';

      return {
        pipeline,
        pushText(text: string) {
          if (!activeTextBufferId || text.length === 0) return;
          appendLiveTextSegment(activeTextBufferId, text).catch(() => {});
        },
        commit() {
          // StreamingTTS consumes committed segments directly; appendLiveTextSegment already commits.
        },
        flush: () => pipeline.flush(),
        cancel: async () => {
          activeState = 'idle';
          if (activePipeline) {
            await activePipeline.stop().catch(() => {});
            activePipeline = null;
          }
          await releaseTextBufferIfNeeded();
        },
        getMetrics: () => ({ queueDepth: 0 }),
        get state() {
          return activeState;
        },
      };
    },
    async destroy() {
      activeState = 'idle';
      if (activePipeline) {
        await activePipeline.stop().catch(() => {});
        activePipeline = null;
      }
      await releaseTextBufferIfNeeded();
      await ttsEngine.destroy();
    },
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: string; code?: string };
    if (maybe.message && maybe.code) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) return maybe.message;
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

async function discoverPadModelsByHint(hint: 'stt' | 'tts'): Promise<{
  modelIds: string[];
  padPath: string | null;
}> {
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const padPath = padPathFromNative ?? fallbackPath;
    const listed = await listModelsAtPath(padPath);
    const modelIds = listed
      .filter((item) => item.hint === hint)
      .map((item) => item.folder);
    return { modelIds, padPath: modelIds.length > 0 ? padPath : null };
  } catch {
    return { modelIds: [], padPath: null };
  }
}

export default function PipelineShowcaseScreen() {
  const [mode, setMode] = useState<SessionMode>('realtime');
  const [sourceMode, setSourceMode] = useState<SourceMode>('mic');

  const [pickedFileUri, setPickedFileUri] = useState<string | null>(null);
  const [pickedFileName, setPickedFileName] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioRouteDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceIdState] = useState<
    string | null
  >(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceIdState] = useState<
    string | null
  >(null);

  // Push route preference to native coordinator whenever device selection changes
  const setSelectedInputDeviceId = useCallback(
    (id: string | null) => {
      setSelectedInputDeviceIdState(id);
      setPipelineAudioRoutePreference({
        inputDeviceId: id,
        outputDeviceId: selectedOutputDeviceId,
      }).catch(() => {});
    },
    [selectedOutputDeviceId]
  );
  const setSelectedOutputDeviceId = useCallback(
    (id: string | null) => {
      setSelectedOutputDeviceIdState(id);
      setPipelineAudioRoutePreference({
        inputDeviceId: selectedInputDeviceId,
        outputDeviceId: id,
      }).catch(() => {});
    },
    [selectedInputDeviceId]
  );

  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const [availableSttModels, setAvailableSttModels] = useState<string[]>([]);
  const [availableTtsModels, setAvailableTtsModels] = useState<string[]>([]);

  const [sttPadModelIds, setSttPadModelIds] = useState<string[]>([]);
  const [ttsPadModelIds, setTtsPadModelIds] = useState<string[]>([]);
  const [sttDownloadedModelIds, setSttDownloadedModelIds] = useState<string[]>(
    []
  );
  const [ttsDownloadedModelIds, setTtsDownloadedModelIds] = useState<string[]>(
    []
  );
  const [sttPadModelsPath, setSttPadModelsPath] = useState<string | null>(null);
  const [ttsPadModelsPath, setTtsPadModelsPath] = useState<string | null>(null);

  const [selectedSttModel, setSelectedSttModel] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);

  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  const [statusText, setStatusText] = useState<string>(
    'Ready to start showcase pipeline.'
  );
  const [error, setError] = useState<string | null>(null);

  const [committedTranscript, setCommittedTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');

  const [processedSegments, setProcessedSegments] = useState(0);
  const [generatedSpeechSeconds, setGeneratedSpeechSeconds] = useState(0);
  const [queueDepth, setQueueDepth] = useState(0);
  const [ttsSessionState, setTtsSessionState] = useState('idle');
  const [ingestProgress, setIngestProgress] = useState<number | null>(null);
  const [ingestStatusText, setIngestStatusText] = useState<string | null>(null);
  const [lastCommittedSegmentIndex, setLastCommittedSegmentIndex] = useState<
    number | null
  >(null);
  const [segmentEvents, setSegmentEvents] = useState<string[]>([]);

  const [savedOutput, setSavedOutput] = useState<SavedOutputInfo | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const sttEngineRef = useRef<LiveSttEngine | null>(null);
  const streamingTtsEngineRef = useRef<StreamingSessionEngine | null>(null);
  const sttPipelineRef = useRef<SttPipelineHandle | null>(null);
  const ttsControllerRef = useRef<StreamingSessionController | null>(null);

  const inputAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const sttTextBufferRef = useRef<LiveTextBufferRef | null>(null);
  const outputAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const playbackRef = useRef<PcmPlayer | null>(null);
  const fileIngestRef = useRef<FileIngestHandle | null>(null);

  const finalizedOutputBufferRef = useRef<OfflineAudioBufferRef | null>(null);

  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingInFlightRef = useRef(false);
  const outputSampleRateRef = useRef(16000);
  const playbackStartedLoggedRef = useRef(false);
  const segmentTrackerRef = useRef<{
    lastSeenSegmentCount: number;
    lastForwardedSegmentIndex: number;
    committedSegments: string[];
  }>({
    lastSeenSegmentCount: 0,
    lastForwardedSegmentIndex: -1,
    committedSegments: [],
  });

  const combinedTranscript = useMemo(() => {
    const parts = [committedTranscript.trim(), partialTranscript.trim()].filter(
      (part) => part.length > 0
    );
    return parts.join(' ').trim();
  }, [committedTranscript, partialTranscript]);

  const clearSegmentTracker = useCallback(() => {
    segmentTrackerRef.current = {
      lastSeenSegmentCount: 0,
      lastForwardedSegmentIndex: -1,
      committedSegments: [],
    };
  }, []);

  const appendSegmentEvent = useCallback((message: string) => {
    setSegmentEvents((prev) => [message, ...prev].slice(0, 5));
  }, []);

  const pipelineSteps = useMemo<PipelineStep[]>(
    () => [
      {
        key: 'stt',
        label: 'STT listening',
        active: isRunning,
      },
      {
        key: 'segment',
        label: 'Segment committed',
        active: lastCommittedSegmentIndex != null,
      },
      {
        key: 'tts',
        label: 'TTS generating',
        active:
          queueDepth > 0 ||
          ttsSessionState !== 'idle' ||
          lastCommittedSegmentIndex != null,
      },
      {
        key: 'playback',
        label: 'Playback',
        active: generatedSpeechSeconds > 0,
      },
    ],
    [
      generatedSpeechSeconds,
      isRunning,
      lastCommittedSegmentIndex,
      queueDepth,
      ttsSessionState,
    ]
  );

  const refreshAudioDevices = useCallback(async () => {
    const [nextInputDevices, nextOutputDevices] = await Promise.all([
      listAvailableInputDevices().catch(() => []),
      listAvailableOutputDevices().catch(() => []),
    ]);

    setInputDevices(nextInputDevices);
    setOutputDevices(nextOutputDevices);

    let newInputId: string | null = null;
    let newOutputId: string | null = null;
    setSelectedInputDeviceIdState((prev) => {
      newInputId = keepValidDeviceSelection(prev, nextInputDevices);
      return newInputId;
    });
    setSelectedOutputDeviceIdState((prev) => {
      newOutputId = keepValidDeviceSelection(prev, nextOutputDevices);
      return newOutputId;
    });

    // Push validated selections to the native coordinator
    setPipelineAudioRoutePreference({
      inputDeviceId: newInputId,
      outputDeviceId: newOutputId,
    }).catch(() => {});
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current != null) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    pollingInFlightRef.current = false;
  }, []);

  const releaseFinalizedOutput = useCallback(async () => {
    const output = finalizedOutputBufferRef.current;
    finalizedOutputBufferRef.current = null;
    if (output) {
      await releasePipelineAudioBuffer(output.bufferId).catch(() => {});
    }
    setSavedOutput(null);
    setSavedPath(null);
  }, []);

  const cleanupRuntimeResources = useCallback(async () => {
    stopPolling();

    await stopMicToLiveAudioBuffer().catch(() => {});

    const ingest = fileIngestRef.current;
    fileIngestRef.current = null;
    if (ingest) {
      try {
        ingest.cancel();
      } catch {
        // ignore cancellation races
      }
    }

    const controller = ttsControllerRef.current;
    ttsControllerRef.current = null;
    if (controller) {
      await controller.cancel().catch(() => {});
    }

    const sttPipeline = sttPipelineRef.current;
    sttPipelineRef.current = null;
    if (sttPipeline) {
      await sttPipeline.stop().catch(() => {});
    }

    const player = playbackRef.current;
    playbackRef.current = null;
    if (player) {
      await player.destroy().catch(() => {});
    }

    const textBuffer = sttTextBufferRef.current;
    sttTextBufferRef.current = null;
    if (textBuffer) {
      textBuffer.unsubscribeEvents();
      await releasePipelineTextBuffer(textBuffer.bufferId).catch(() => {});
    }

    const inputAudio = inputAudioBufferRef.current;
    inputAudioBufferRef.current = null;
    if (inputAudio) {
      inputAudio.unsubscribeEvents();
      await releasePipelineAudioBuffer(inputAudio.bufferId).catch(() => {});
    }

    const outputAudio = outputAudioBufferRef.current;
    outputAudioBufferRef.current = null;
    if (outputAudio) {
      outputAudio.unsubscribeEvents();
      await releasePipelineAudioBuffer(outputAudio.bufferId).catch(() => {});
    }

    const sttEngine = sttEngineRef.current;
    sttEngineRef.current = null;
    if (sttEngine) {
      await sttEngine.destroy().catch(() => {});
    }

    const streamingTtsEngine = streamingTtsEngineRef.current;
    streamingTtsEngineRef.current = null;
    if (streamingTtsEngine) {
      await streamingTtsEngine.destroy().catch(() => {});
    }

    setIngestProgress(null);
    setIngestStatusText(null);
  }, [stopPolling]);

  const resolveSttModelPath = useCallback(
    (modelFolder: string) => {
      if (sttPadModelIds.includes(modelFolder)) {
        return sttPadModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Stt, sttPadModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Stt);
      }
      if (sttDownloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Stt);
      }
      return getAssetModelPath(modelFolder);
    },
    [sttDownloadedModelIds, sttPadModelIds, sttPadModelsPath]
  );

  const resolveTtsModelPath = useCallback(
    (modelFolder: string) => {
      if (ttsPadModelIds.includes(modelFolder)) {
        return ttsPadModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Tts, ttsPadModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      if (ttsDownloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      return getAssetModelPath(modelFolder);
    },
    [ttsDownloadedModelIds, ttsPadModelIds, ttsPadModelsPath]
  );

  const syncSttSegmentsToTts = useCallback(async () => {
    const textBuffer = sttTextBufferRef.current;
    if (!textBuffer) return;

    const textBufferId = textBuffer.bufferId;
    const tracker = segmentTrackerRef.current;

    const segmentCount = await getLiveTextBufferSegmentCount(textBufferId);

    let segments: Awaited<ReturnType<typeof getLiveTextBufferSegments>> = [];
    if (segmentCount > tracker.lastSeenSegmentCount) {
      segments = await getLiveTextBufferSegments(
        textBufferId,
        tracker.lastSeenSegmentCount,
        segmentCount - tracker.lastSeenSegmentCount
      );
    } else if (segmentCount < tracker.lastSeenSegmentCount) {
      segments =
        segmentCount > 0
          ? await getLiveTextBufferSegments(textBufferId, 0, segmentCount)
          : [];
    }
    tracker.lastSeenSegmentCount = segmentCount;

    let forwardedCount = 0;
    const controller = ttsControllerRef.current;

    for (const segment of segments) {
      if (segment.segmentIndex <= tracker.lastForwardedSegmentIndex) {
        continue;
      }
      tracker.lastForwardedSegmentIndex = segment.segmentIndex;

      const trimmed = segment.text.trim();
      if (trimmed.length === 0) {
        continue;
      }

      tracker.committedSegments.push(trimmed);
      setLastCommittedSegmentIndex(segment.segmentIndex);
      appendSegmentEvent(
        `#${segment.segmentIndex} committed: "${trimmed.slice(0, 64)}${
          trimmed.length > 64 ? '...' : ''
        }"`
      );
      forwardedCount += 1;

      if (controller) {
        try {
          controller.pushText(`${trimmed} `);
          controller.commit({ force: true });
          appendSegmentEvent(`#${segment.segmentIndex} pushed to TTS`);
        } catch {
          // ignore controller state races during stop/teardown
        }
      }
    }

    if (forwardedCount > 0) {
      setProcessedSegments((prev) => prev + forwardedCount);
    }

    const partial = await getLiveTextBufferPartialSlice(textBufferId, 0, 4096);
    setCommittedTranscript(tracker.committedSegments.join(' '));
    setPartialTranscript(partial.trim());

    if (controller) {
      const metrics = controller.getMetrics();
      setQueueDepth(metrics.queueDepth);
      setTtsSessionState(controller.state);
    }
  }, [appendSegmentEvent]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollingTimerRef.current = setInterval(() => {
      if (pollingInFlightRef.current) {
        return;
      }
      pollingInFlightRef.current = true;
      syncSttSegmentsToTts()
        .catch(() => {
          // ignore polling races during teardown
        })
        .finally(() => {
          pollingInFlightRef.current = false;
        });
    }, POLL_INTERVAL_MS);
  }, [stopPolling, syncSttSegmentsToTts]);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelError(null);

    try {
      const assets = await listAssetModels();
      const [downloadedStt, downloadedTts, padStt, padTts] = await Promise.all([
        listDownloadedModels(ModelCategory.Stt),
        listDownloadedModels(ModelCategory.Tts),
        discoverPadModelsByHint('stt'),
        discoverPadModelsByHint('tts'),
      ]);

      const assetStt = assets
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const assetTts = assets
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);

      const downloadedSttIds = downloadedStt.map((model) => model.id);
      const downloadedTtsIds = downloadedTts.map((model) => model.id);

      const sttModels = [
        ...padStt.modelIds,
        ...assetStt.filter((id) => !padStt.modelIds.includes(id)),
        ...downloadedSttIds.filter(
          (id) => !padStt.modelIds.includes(id) && !assetStt.includes(id)
        ),
      ];

      const ttsModels = [
        ...padTts.modelIds,
        ...assetTts.filter((id) => !padTts.modelIds.includes(id)),
        ...downloadedTtsIds.filter(
          (id) => !padTts.modelIds.includes(id) && !assetTts.includes(id)
        ),
      ];

      setAvailableSttModels(sttModels);
      setAvailableTtsModels(ttsModels);

      setSttPadModelIds(padStt.modelIds);
      setTtsPadModelIds(padTts.modelIds);
      setSttDownloadedModelIds(downloadedSttIds);
      setTtsDownloadedModelIds(downloadedTtsIds);
      setSttPadModelsPath(padStt.padPath);
      setTtsPadModelsPath(padTts.padPath);

      setSelectedSttModel((prev) => {
        if (prev && sttModels.includes(prev)) return prev;
        return sttModels[0] ?? null;
      });
      setSelectedTtsModel((prev) => {
        if (prev && ttsModels.includes(prev)) return prev;
        return ttsModels[0] ?? null;
      });

      if (sttModels.length === 0 || ttsModels.length === 0) {
        setModelError(
          'At least one STT model and one TTS model are required for the showcase.'
        );
      }
    } catch (loadErr) {
      setModelError(normalizeErrorMessage(loadErr));
      setAvailableSttModels([]);
      setAvailableTtsModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadModels().catch(() => {
      // loadModels already sets stateful errors
    });
  }, [loadModels]);

  useEffect(() => {
    refreshAudioDevices().catch(() => {
      // ignore unsupported-platform lookup failures
    });
  }, [refreshAudioDevices]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Stt && category !== ModelCategory.Tts) {
        return;
      }
      loadModels().catch(() => {
        // ignore refresh errors; state already guarded
      });
    });
    return unsubscribe;
  }, [loadModels]);

  useEffect(() => {
    return () => {
      cleanupRuntimeResources().catch(() => {});
      releaseFinalizedOutput().catch(() => {});
    };
  }, [cleanupRuntimeResources, releaseFinalizedOutput]);

  const handlePickAudioFile = useCallback(async () => {
    setError(null);
    setIngestProgress(null);
    setIngestStatusText(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri =
        file?.uri ??
        (file as { fileUri?: string })?.fileUri ??
        (file as { fileCopyUri?: string })?.fileCopyUri ??
        '';
      if (!uri) {
        setError('Could not resolve selected audio file URI.');
        return;
      }
      const name = file?.name ?? uri.split('/').pop() ?? 'audio';
      setPickedFileUri(uri);
      setPickedFileName(name);
    } catch (pickErr) {
      const isCancel = (
        DocumentPicker as { isCancel?: (e: unknown) => boolean }
      ).isCancel?.(pickErr);
      if (!isCancel) {
        setError(normalizeErrorMessage(pickErr));
      }
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (isRunning || isStarting || isStopping) {
      return;
    }

    if (!selectedSttModel || !selectedTtsModel) {
      setError('Please select both an STT and a TTS model.');
      return;
    }

    if (sourceMode === 'file' && !pickedFileUri) {
      setError('Choose an audio file before starting file mode.');
      return;
    }

    setIsStarting(true);
    setError(null);
    setSavedPath(null);
    setStatusText('Initializing realtime showcase pipeline...');

    setCommittedTranscript('');
    setPartialTranscript('');
    setProcessedSegments(0);
    setGeneratedSpeechSeconds(0);
    setQueueDepth(0);
    setTtsSessionState('idle');
    setLastCommittedSegmentIndex(null);
    setSegmentEvents([]);
    setIngestProgress(null);
    setIngestStatusText(
      sourceMode === 'file' ? 'Ready to decode selected audio.' : null
    );
    playbackStartedLoggedRef.current = false;
    clearSegmentTracker();

    try {
      await cleanupRuntimeResources();
      await releaseFinalizedOutput();

      const sttModelPath = resolveSttModelPath(selectedSttModel);
      const ttsModelPath = resolveTtsModelPath(selectedTtsModel);

      const sttDetection = await detectSttModel(
        await toDetectSource(sttModelPath),
        { modelType: 'auto' }
      );
      if (!sttDetection.success) {
        throw new Error(sttDetection.error ?? 'STT model detection failed');
      }
      if (!sttDetection.isStreaming) {
        throw new Error(
          'Selected STT model is offline-only. Please choose a streaming STT model for this showcase.'
        );
      }

      const ttsDetection = await detectTtsModel(
        await toDetectSource(ttsModelPath)
      );
      if (!ttsDetection.success) {
        throw new Error(ttsDetection.error ?? 'TTS model detection failed');
      }

      const sttEngine = await createStreamingSTT({
        modelSource: sttModelPath,
        modelType: 'auto',
        numThreads: 2,
      });
      sttEngineRef.current = sttEngine;

      const streamingTts = await createStreamingSessionEngine({
        modelSource: ttsModelPath,
        modelType: 'auto',
        numThreads: 2,
        debug: false,
      });
      streamingTtsEngineRef.current = streamingTts;

      const ttsSampleRate = await streamingTts.getSampleRate();
      outputSampleRateRef.current = ttsSampleRate;

      const outputAudioPath = `${DocumentDirectoryPath}/showcase_tts_${Date.now()}.wav`;
      const outputLiveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: ttsSampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: { mode: 'path', path: outputAudioPath },
        streamEvents: { framesAppended: { enabled: true, minIntervalMs: 0 } },
        onFramesAppended: (event) => {
          setGeneratedSpeechSeconds(event.totalSamplesWritten / ttsSampleRate);
          if (
            !playbackStartedLoggedRef.current &&
            event.totalSamplesWritten > 0
          ) {
            playbackStartedLoggedRef.current = true;
            appendSegmentEvent('Playback started');
          }
        },
        onError: (event) => {
          setError(event.message);
        },
      });
      outputAudioBufferRef.current = outputLiveAudio;

      const player = await createPcmPlayer(outputLiveAudio, {
        onEnded: () => {
          setStatusText((prev) => {
            if (prev.includes('Finalize complete')) {
              return prev;
            }
            return 'Playback reached end of stream.';
          });
        },
      });
      playbackRef.current = player;

      const sttTextBuffer = await createLiveTextBuffer({
        windowMaxChars: 65536,
        maxSegments: 4096,
      });
      sttTextBufferRef.current = sttTextBuffer;

      const inputLiveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: STT_INPUT_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      inputAudioBufferRef.current = inputLiveAudio;

      const sttPipeline = await sttEngine.transcribe(
        inputLiveAudio,
        sttTextBuffer,
        {
          chunkSize: 3200,
        }
      );
      sttPipelineRef.current = sttPipeline;

      const ttsController = await streamingTts.startSession(outputLiveAudio, {
        sid: 0,
        speed: 1.0,
      });
      ttsControllerRef.current = ttsController;

      startPolling();

      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(inputLiveAudio, {
          emitToJs: false,
        });
        setStatusText(
          'Realtime loop is running. Headset is strongly recommended to avoid acoustic feedback.'
        );
      } else {
        const source = toFileSource(pickedFileUri ?? '');
        setIngestStatusText(
          'Decoding selected audio and ingesting to live pipeline...'
        );
        const ingest = await ingestFileToLiveAudioBuffer(
          inputLiveAudio,
          source,
          {
            targetSampleRateHz: STT_INPUT_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
            onProgress: (event) => {
              const percent = Math.max(0, Math.min(100, event.percent ?? 0));
              setIngestProgress(percent);

              const totalFrames = event.totalFramesEstimate ?? 0;
              if (totalFrames > 0) {
                setIngestStatusText(
                  `Decoding and ingesting... ${Math.round(percent)}% (${
                    event.framesDecoded
                  }/${totalFrames} frames)`
                );
                return;
              }

              setIngestStatusText(
                `Decoding and ingesting... ${Math.round(percent)}%`
              );
            },
          }
        );

        fileIngestRef.current = ingest;
        ingest.done
          .then(() => {
            setIngestProgress(100);
            setIngestStatusText('File ingest complete.');
            setStatusText(
              'File ingest finished. Press Stop to flush/finalize and optionally export WAV.'
            );
          })
          .catch((ingestErr) => {
            const code = (ingestErr as { code?: string })?.code;
            if (code === 'DECODE_CANCELLED') {
              setIngestStatusText('File ingest cancelled.');
              return;
            }
            setIngestStatusText('File ingest failed.');
            setError(normalizeErrorMessage(ingestErr));
          });

        setStatusText('Streaming file into STT -> streaming TTS pipeline...');
      }

      setIsRunning(true);
    } catch (startErr) {
      await cleanupRuntimeResources();
      setError(normalizeErrorMessage(startErr));
      setStatusText('Pipeline start failed.');
      setIsRunning(false);
    } finally {
      setIsStarting(false);
    }
  }, [
    appendSegmentEvent,
    cleanupRuntimeResources,
    clearSegmentTracker,
    isRunning,
    isStarting,
    isStopping,
    pickedFileUri,
    releaseFinalizedOutput,
    resolveSttModelPath,
    resolveTtsModelPath,
    selectedSttModel,
    selectedTtsModel,
    sourceMode,
    startPolling,
  ]);

  const handleStop = useCallback(async () => {
    if (!isRunning || isStopping) {
      return;
    }

    setIsStopping(true);
    setError(null);

    try {
      if (mode === 'realtime') {
        setStatusText('Stopping realtime loop...');
        await cleanupRuntimeResources();
        setStatusText('Realtime loop stopped.');
        setIsRunning(false);
        return;
      }

      setStatusText('Finalize + Save: flushing STT and draining TTS queue...');

      await stopMicToLiveAudioBuffer().catch(() => {});

      const ingest = fileIngestRef.current;
      if (ingest) {
        try {
          const ingestStatus = await ingest.getStatus();
          if (ingestStatus.isRunning) {
            ingest.cancel();
          }
        } catch {
          // ignore status races
        }
      }

      const inputAudio = inputAudioBufferRef.current;
      if (inputAudio) {
        await finalizeLiveAudioBuffer(inputAudio.bufferId).catch(() => {});
      }

      const sttPipeline = sttPipelineRef.current;
      if (sttPipeline) {
        await sttPipeline.flush().catch(() => {});
      }

      await syncSttSegmentsToTts();

      const controller = ttsControllerRef.current;
      if (controller) {
        controller.commit({ force: true });
        await controller.flush();
        const metrics = controller.getMetrics();
        setQueueDepth(metrics.queueDepth);
        setTtsSessionState(controller.state);
      }

      const outputAudio = outputAudioBufferRef.current;
      if (outputAudio) {
        await finalizeLiveAudioBuffer(outputAudio.bufferId).catch(() => {});

        await releaseFinalizedOutput();
        const offlineOutput = await createOfflineAudioBufferFromLive(
          outputAudio.bufferId,
          'fullIfSpooled'
        );
        finalizedOutputBufferRef.current = offlineOutput;

        const info = await getPipelineAudioBufferInfo(offlineOutput.bufferId);
        const numSamples =
          info.kind === 'offlinePcmBuffer' ? info.numSamples : 0;
        const sampleRate = info.sampleRate;

        setSavedOutput({
          bufferId: offlineOutput.bufferId,
          sampleRate,
          numSamples,
        });

        if (sampleRate > 0 && numSamples > 0) {
          setGeneratedSpeechSeconds(numSamples / sampleRate);
        }
      }

      setStatusText('Finalize complete. WAV export is ready.');
      await cleanupRuntimeResources();
      setIsRunning(false);
    } catch (stopErr) {
      setError(normalizeErrorMessage(stopErr));
      setStatusText('Stop/finalize failed.');
      await cleanupRuntimeResources();
      setIsRunning(false);
    } finally {
      setIsStopping(false);
    }
  }, [
    cleanupRuntimeResources,
    isRunning,
    isStopping,
    mode,
    releaseFinalizedOutput,
    syncSttSegmentsToTts,
  ]);

  const canStart =
    !isRunning &&
    !isStarting &&
    !isStopping &&
    !loadingModels &&
    selectedSttModel != null &&
    selectedTtsModel != null &&
    (sourceMode === 'mic' || pickedFileUri != null);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pipeline Showcase</Text>
            <Text style={styles.hint}>
              Mic/File -&gt; Streaming STT -&gt; Streaming TTS -&gt; PCM Player
            </Text>
            <Text style={styles.warningText}>
              Headset recommended: Without a headset, the microphone may pick up
              speaker playback.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Mode</Text>
            <View style={styles.optionRow}>
              <TouchableOpacity
                style={[
                  styles.optionButton,
                  mode === 'realtime' && styles.optionButtonActive,
                ]}
                onPress={() => setMode('realtime')}
                disabled={isRunning || isStarting || isStopping}
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    mode === 'realtime' && styles.optionButtonTextActive,
                  ]}
                >
                  Realtime Loop
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.optionButton,
                  mode === 'finalize' && styles.optionButtonActive,
                ]}
                onPress={() => setMode('finalize')}
                disabled={isRunning || isStarting || isStopping}
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    mode === 'finalize' && styles.optionButtonTextActive,
                  ]}
                >
                  Finalize + Save
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Source</Text>
            <View style={styles.optionRow}>
              <TouchableOpacity
                style={[
                  styles.optionButton,
                  sourceMode === 'mic' && styles.optionButtonActive,
                ]}
                onPress={() => {
                  setSourceMode('mic');
                  setIngestProgress(null);
                  setIngestStatusText(null);
                }}
                disabled={isRunning || isStarting || isStopping}
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    sourceMode === 'mic' && styles.optionButtonTextActive,
                  ]}
                >
                  Microphone
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.optionButton,
                  sourceMode === 'file' && styles.optionButtonActive,
                ]}
                onPress={() => {
                  setSourceMode('file');
                  setIngestProgress(null);
                  setIngestStatusText(null);
                }}
                disabled={isRunning || isStarting || isStopping}
              >
                <Text
                  style={[
                    styles.optionButtonText,
                    sourceMode === 'file' && styles.optionButtonTextActive,
                  ]}
                >
                  Audio File
                </Text>
              </TouchableOpacity>
            </View>

            {sourceMode === 'mic' && (
              <AudioDeviceDropdown
                label="Input device"
                devices={inputDevices}
                selectedDeviceId={selectedInputDeviceId}
                onSelectDeviceId={setSelectedInputDeviceId}
                disabled={isRunning || isStarting || isStopping}
              />
            )}

            <AudioDeviceDropdown
              label="Output device"
              devices={outputDevices}
              selectedDeviceId={selectedOutputDeviceId}
              onSelectDeviceId={setSelectedOutputDeviceId}
              disabled={isRunning || isStarting || isStopping}
            />

            {sourceMode === 'file' && (
              <>
                <TouchableOpacity
                  style={styles.sourceButton}
                  onPress={handlePickAudioFile}
                  disabled={isRunning || isStarting || isStopping}
                >
                  <Text style={styles.sourceButtonText}>
                    {pickedFileName ? 'Change audio file' : 'Pick audio file'}
                  </Text>
                  <Text style={styles.sourceMeta}>
                    {pickedFileName
                      ? `${pickedFileName}${
                          ingestProgress != null
                            ? ` (ingest ${Math.round(ingestProgress)}%)`
                            : ''
                        }`
                      : 'Choose any local audio file or content URI'}
                  </Text>
                </TouchableOpacity>

                {(isStarting ||
                  isRunning ||
                  ingestProgress != null ||
                  ingestStatusText != null) && (
                  <View style={styles.ingestProgressContainer}>
                    <View style={styles.ingestProgressHeaderRow}>
                      <Text style={styles.ingestProgressLabel}>
                        {ingestStatusText ?? 'Preparing file ingest...'}
                      </Text>
                      {ingestProgress != null && (
                        <Text style={styles.ingestProgressPercent}>
                          {Math.round(ingestProgress)}%
                        </Text>
                      )}
                    </View>

                    {ingestProgress != null ? (
                      <View style={styles.ingestProgressTrack}>
                        <View
                          style={[
                            styles.ingestProgressFill,
                            {
                              width: `${Math.max(
                                0,
                                Math.min(100, ingestProgress)
                              )}%`,
                            },
                          ]}
                        />
                      </View>
                    ) : (
                      <View style={styles.ingestProgressWaitingRow}>
                        <ActivityIndicator size="small" color="#007AFF" />
                        <Text style={styles.ingestProgressWaitingText}>
                          Waiting for the first decoded chunk...
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Models</Text>
            {loadingModels ? (
              <View style={styles.optionRow}>
                <ActivityIndicator size="small" color="#007AFF" />
                <Text style={styles.hint}>
                  Scanning available STT/TTS models...
                </Text>
              </View>
            ) : (
              <>
                <Text style={styles.modelGroupTitle}>Streaming STT</Text>
                <View style={styles.modelList}>
                  {availableSttModels.map((modelId) => {
                    const active = selectedSttModel === modelId;
                    return (
                      <TouchableOpacity
                        key={`stt_${modelId}`}
                        style={[
                          styles.modelChip,
                          active && styles.modelChipActive,
                        ]}
                        onPress={() => setSelectedSttModel(modelId)}
                        disabled={isRunning || isStarting || isStopping}
                      >
                        <Text
                          style={[
                            styles.modelChipTitle,
                            active && styles.modelChipTitleActive,
                          ]}
                        >
                          {getModelDisplayName(modelId)}
                        </Text>
                        <Text style={styles.modelChipSub}>{modelId}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={styles.modelGroupTitle}>Streaming TTS</Text>
                <View style={styles.modelList}>
                  {availableTtsModels.map((modelId) => {
                    const active = selectedTtsModel === modelId;
                    return (
                      <TouchableOpacity
                        key={`tts_${modelId}`}
                        style={[
                          styles.modelChip,
                          active && styles.modelChipActive,
                        ]}
                        onPress={() => setSelectedTtsModel(modelId)}
                        disabled={isRunning || isStarting || isStopping}
                      >
                        <Text
                          style={[
                            styles.modelChipTitle,
                            active && styles.modelChipTitleActive,
                          ]}
                        >
                          {getModelDisplayName(modelId)}
                        </Text>
                        <Text style={styles.modelChipSub}>{modelId}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
            {modelError && <Text style={styles.errorText}>{modelError}</Text>}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>4. Controls</Text>
            <View style={styles.controlsRow}>
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.actionButtonPrimary,
                  !canStart && styles.actionButtonDisabled,
                ]}
                disabled={!canStart}
                onPress={handleStart}
              >
                {isStarting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.actionButtonText}>Start</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.actionButton,
                  styles.actionButtonDanger,
                  (!isRunning || isStopping) && styles.actionButtonDisabled,
                ]}
                disabled={!isRunning || isStopping}
                onPress={handleStop}
              >
                {isStopping ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.actionButtonText}>Stop</Text>
                )}
              </TouchableOpacity>
            </View>

            {savedOutput && finalizedOutputBufferRef.current && (
              <AudioSaveDestinationPicker
                audioInput={finalizedOutputBufferRef.current.bufferId}
                filename={`pipeline_showcase_${Date.now()}.wav`}
                format="wav"
                onSaveComplete={(result) => {
                  const location = formatResolvedLocation(result);
                  setSavedPath(location);
                  Alert.alert('Saved', `WAV exported to:\n${location}`);
                }}
                onError={(error) => {
                  Alert.alert('Save failed', error.message);
                }}
              />
            )}

            <Text style={styles.statusText}>{statusText}</Text>
            {error && <Text style={styles.errorText}>{error}</Text>}
            {savedOutput && (
              <Text style={styles.hint}>
                Final output: {savedOutput.numSamples} samples @{' '}
                {savedOutput.sampleRate} Hz
              </Text>
            )}
            {savedPath && (
              <Text style={styles.savedPath}>Saved: {savedPath}</Text>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>5. Transcript (readonly)</Text>
            <Text style={styles.transcriptLabel}>
              Committed + partial preview
            </Text>
            <View style={styles.transcriptBox}>
              {combinedTranscript.length > 0 ? (
                <Text style={styles.transcriptText}>{combinedTranscript}</Text>
              ) : (
                <Text style={styles.transcriptPlaceholder}>
                  Transcript appears here while the pipeline is running.
                </Text>
              )}
              {partialTranscript.length > 0 && (
                <Text style={styles.partialText}>
                  partial: {partialTranscript}
                </Text>
              )}
            </View>
            <Text style={styles.pipelineHintText}>
              Speech starts after committed segments, not for every partial
              word.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>6. Pipeline Flow</Text>
            <View style={styles.stepRow}>
              {pipelineSteps.map((step) => (
                <View
                  key={step.key}
                  style={[
                    styles.stepChip,
                    step.active && styles.stepChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.stepChipText,
                      step.active && styles.stepChipTextActive,
                    ]}
                  >
                    {step.label}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={styles.transcriptLabel}>Recent Segment Events</Text>
            {segmentEvents.length > 0 ? (
              <View style={styles.eventList}>
                {segmentEvents.map((event, idx) => (
                  <Text key={`${event}_${idx}`} style={styles.eventItemText}>
                    {event}
                  </Text>
                ))}
              </View>
            ) : (
              <Text style={styles.hint}>
                No committed segments yet. Events appear here as segments are
                pushed to TTS.
              </Text>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>7. Live Metrics</Text>
            <View style={styles.metricGrid}>
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>processedSegments</Text>
                <Text style={styles.metricValue}>{processedSegments}</Text>
              </View>
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>generatedSpeechSeconds</Text>
                <Text style={styles.metricValue}>
                  {generatedSpeechSeconds.toFixed(2)}s
                </Text>
              </View>
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>queueDepth</Text>
                <Text style={styles.metricValue}>{queueDepth}</Text>
              </View>
              <View style={styles.metricCard}>
                <Text style={styles.metricLabel}>sessionState</Text>
                <Text style={styles.metricValue}>{ttsSessionState}</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </View>

      <ScreenIntroModal screenId="PipelineShowcase" />
    </SafeAreaView>
  );
}
