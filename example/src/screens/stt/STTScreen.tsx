import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Share,
  Platform,
  Pressable,
  ToastAndroid,
  DeviceEventEmitter,
} from 'react-native';
import { styles } from './STTScreen.styles';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  resolveModelPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';
import {
  createSTT,
  createStreamingSTT,
  detectSttModel,
  type STTModelType,
} from 'react-native-sherpa-onnx/stt';
import type {
  SttEngine,
  LiveSttEngine,
  SttPipelineHandle,
} from 'react-native-sherpa-onnx/stt';
import { getSttCache, setSttCache, clearSttCache } from '../../engineCache';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { getAudioFilesForModel, type AudioFileInfo } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import {
  createEmptyOfflineTextBuffer,
  createLiveTextBuffer,
  getPipelineTextBufferInfo,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTokensSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferDurationsSlice,
  getOfflineTextBufferLang,
  getOfflineTextBufferEmotion,
  getOfflineTextBufferEvent,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type { OfflineTextBufferInfo } from 'react-native-sherpa-onnx/textbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  startPcmFilePlayback,
  stopPcmFilePlayback,
  type ActivePcmFilePlayback,
} from '../../utils/audioFilePcmPlayback';
import { AudioDeviceDropdown } from '../../components/AudioDeviceDropdown';
import {
  fetchInputDevices,
  fetchOutputDevices,
  keepValidDeviceSelection,
  type AudioRouteDevice,
} from '../../utils/audioDevices';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

const PAD_PACK_NAME = 'sherpa_models';

type SttOfflineInputBufferState = {
  bufferId: string;
  sourceType: 'example' | 'own';
  sourceLabel: string;
  selectedAudioId: string | null;
  customAudioPath: string | null;
  customAudioName: string | null;
};

type SttTranscriptionResult = {
  text: string;
  tokens: string[];
  timestamps: number[];
  lang: string;
  emotion: string;
  event: string;
  durations: number[];
  bufferId?: string;
};

type SttOfflineTextBufferState = SttTranscriptionResult & {
  bufferId: string;
  createdAt: number;
};

let gSttOfflineInputBuffer: SttOfflineInputBufferState | null = null;
let gSttOfflineTextBuffers: SttOfflineTextBufferState[] = [];

export default function STTScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: STTModelType; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] =
    useState<STTModelType | null>(null);
  const [isStreamingModel, setIsStreamingModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'init' | 'transcribe' | null>(
    null
  );
  const [audioSourceType, setAudioSourceType] = useState<
    'example' | 'own' | 'live' | null
  >(null);
  const [isLiveRecording, setIsLiveRecording] = useState(false);
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(
    null
  );
  const [customAudioPath, setCustomAudioPath] = useState<string | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);
  const [transcriptionResult, setTranscriptionResult] =
    useState<SttTranscriptionResult | null>(null);
  const [offlineTextBuffers, setOfflineTextBuffers] = useState<
    SttOfflineTextBufferState[]
  >(gSttOfflineTextBuffers);
  const [tokensExpanded, setTokensExpanded] = useState(false);
  const [timestampsExpanded, setTimestampsExpanded] = useState(false);
  const [durationsExpanded, setDurationsExpanded] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [preparingAudioBuffer, setPreparingAudioBuffer] = useState(false);
  const [offlineBufferBuildProgress, setOfflineBufferBuildProgress] = useState<
    number | null
  >(null);
  const [offlineBufferBuildStatus, setOfflineBufferBuildStatus] = useState<
    string | null
  >(null);
  const [offlineBufferPlaying, setOfflineBufferPlaying] = useState(false);
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<SttOfflineInputBufferState | null>(gSttOfflineInputBuffer);
  const [inputDevices, setInputDevices] = useState<AudioRouteDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<
    string | null
  >(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);

  const sttEngineRef = useRef<SttEngine | null>(null);
  const pcmPlaybackRef = useRef<ActivePcmFilePlayback | null>(null);
  const offlineBufferPlayerRef = useRef<PcmPlayer | null>(null);
  const streamingEngineRef = useRef<LiveSttEngine | null>(null);
  const livePipelineRef = useRef<{
    liveAudioBufferId: string;
    liveTextBufferId: string;
    pipelineHandle: SttPipelineHandle;
    micErrorSubscription: { remove: () => void };
    audioUnsubscribe: () => void;
    textUnsubscribe: () => void;
  } | null>(null);
  const livePreviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const livePreviewInFlightRef = useRef(false);
  const offlineBufferBuildRequestRef = useRef(0);
  const liveAccumulatorRef = useRef<{
    segmentCount: number;
    segmentTexts: string[];
  }>({ segmentCount: 0, segmentTexts: [] });
  const STT_NUM_THREADS = 2;
  const LIVE_SAMPLE_RATE = 16000;

  const refreshAudioDevices = useCallback(async () => {
    const [nextInputDevices, nextOutputDevices] = await Promise.all([
      fetchInputDevices(),
      fetchOutputDevices(),
    ]);

    setInputDevices(nextInputDevices);
    setOutputDevices(nextOutputDevices);
    setSelectedInputDeviceId((prev) =>
      keepValidDeviceSelection(prev, nextInputDevices)
    );
    setSelectedOutputDeviceId((prev) =>
      keepValidDeviceSelection(prev, nextOutputDevices)
    );
  }, []);

  const isLiveSupported = isStreamingModel;
  const availableAudioFiles = useMemo(
    () => (currentModelFolder ? getAudioFilesForModel(currentModelFolder) : []),
    [currentModelFolder]
  );

  const buildTranscriptionResult = (
    text: string,
    tokens: string[] = [],
    timestamps: number[] = []
  ): SttTranscriptionResult => ({
    text,
    tokens,
    timestamps,
    lang: '',
    emotion: '',
    event: '',
    durations: [],
  });

  const composeLiveText = (segmentTexts: string[], partialText: string) => {
    const parts = segmentTexts
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const trimmedPartial = partialText.trim();
    if (trimmedPartial.length > 0) {
      parts.push(trimmedPartial);
    }
    return parts.join(' ').trim();
  };

  const stopLivePreviewPolling = () => {
    if (livePreviewTimerRef.current != null) {
      clearInterval(livePreviewTimerRef.current);
      livePreviewTimerRef.current = null;
    }
    livePreviewInFlightRef.current = false;
  };

  const syncLivePreview = async (liveTextBufferId: string) => {
    if (livePreviewInFlightRef.current) return;
    livePreviewInFlightRef.current = true;
    try {
      const accumulator = liveAccumulatorRef.current;
      const segmentCount = await getLiveTextBufferSegmentCount(
        liveTextBufferId
      );

      if (segmentCount < accumulator.segmentCount) {
        const fullSegments =
          segmentCount > 0
            ? await getLiveTextBufferSegments(liveTextBufferId, 0, segmentCount)
            : [];
        accumulator.segmentCount = segmentCount;
        accumulator.segmentTexts = fullSegments
          .map((segment) => segment.text)
          .filter((segment) => segment.trim().length > 0);
      } else if (segmentCount > accumulator.segmentCount) {
        const newSegments = await getLiveTextBufferSegments(
          liveTextBufferId,
          accumulator.segmentCount,
          segmentCount - accumulator.segmentCount
        );
        for (const segment of newSegments) {
          if (segment.text.trim().length > 0) {
            accumulator.segmentTexts.push(segment.text);
          }
        }
        accumulator.segmentCount = segmentCount;
      }

      const partialText = await getLiveTextBufferPartialSlice(
        liveTextBufferId,
        0,
        4096
      );
      const previewText = composeLiveText(
        accumulator.segmentTexts,
        partialText
      );

      setTranscriptionResult(buildTranscriptionResult(previewText));
    } catch {
      // Ignore polling race conditions during teardown.
    } finally {
      livePreviewInFlightRef.current = false;
    }
  };

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Stt) return;
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    refreshAudioDevices().catch(() => {
      // ignore missing device-list support on unsupported platforms
    });
  }, [refreshAudioDevices]);

  // Restore persisted instance state when entering the screen (no cleanup on unmount)
  useEffect(() => {
    const cached = getSttCache();
    if (cached.engine != null && cached.modelFolder != null) {
      sttEngineRef.current = cached.engine;
      setCurrentModelFolder(cached.modelFolder);
      setSelectedModelForInit(cached.modelFolder);
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          cached.modelFolder
        )}\nDetected models: ${cached.detectedModels
          .map((m) => m.type)
          .join(', ')}`
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      stopLivePreviewPolling();
    };
  }, []);

  useEffect(() => {
    if (gSttOfflineInputBuffer == null) {
      return;
    }
    setOfflineInputBuffer(gSttOfflineInputBuffer);
    setAudioSourceType(gSttOfflineInputBuffer.sourceType);
    setCustomAudioPath(gSttOfflineInputBuffer.customAudioPath);
    setCustomAudioName(gSttOfflineInputBuffer.customAudioName);
  }, []);

  useEffect(() => {
    if (
      offlineInputBuffer == null ||
      offlineInputBuffer.selectedAudioId == null
    ) {
      return;
    }
    const matched = availableAudioFiles.find(
      (audio) => audio.id === offlineInputBuffer.selectedAudioId
    );
    if (matched) {
      setSelectedAudio(matched);
    }
  }, [availableAudioFiles, offlineInputBuffer]);

  useEffect(() => {
    return () => {
      if (pcmPlaybackRef.current) {
        stopPcmFilePlayback(pcmPlaybackRef.current).catch(() => {});
        pcmPlaybackRef.current = null;
      }
      if (offlineBufferPlayerRef.current) {
        offlineBufferPlayerRef.current.destroy().catch(() => {});
        offlineBufferPlayerRef.current = null;
      }
    };
  }, []);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    setErrorSource(null);
    try {
      const assetModels = await listAssetModels();
      const sttFolders = assetModels
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const downloadedModels = await listDownloadedModels(ModelCategory.Stt);
      const downloadedFolders = downloadedModels.map((model) => model.id);

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'stt')
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
          console.log(
            'STTScreen: Found PAD/filesystem STT models:',
            padFolders,
            'at',
            padPath
          );
        }
      } catch (e) {
        console.warn('STTScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);

      // Merge: PAD folders, then bundled asset folders (no duplicates)
      const combined = [
        ...padFolders,
        ...sttFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !sttFolders.includes(f)
        ),
      ];

      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      if (sttFolders.length > 0) {
        console.log('STTScreen: Found asset models:', sttFolders);
      }
      setAvailableModels(combined);

      if (combined.length === 0) {
        setErrorSource('init');
        setError(
          'No STT models found. Use bundled assets, downloaded models, or PAD models. See STT_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('STTScreen: Failed to load models:', err);
      setErrorSource('init');
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const resolveSttModelPath = (modelFolder: string) => {
    if (padModelIds.includes(modelFolder)) {
      return padModelsPath
        ? getFileModelPath(modelFolder, ModelCategory.Stt, padModelsPath)
        : getFileModelPath(modelFolder, ModelCategory.Stt);
    }
    if (downloadedModelIds.includes(modelFolder)) {
      return getFileModelPath(modelFolder, ModelCategory.Stt);
    }
    return getAssetModelPath(modelFolder);
  };

  const resolveInputSource = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ): Promise<{
    source: FileSource;
    sourceType: 'example' | 'own';
    sourceLabel: string;
    selectedAudioId: string | null;
    customAudioPath: string | null;
    customAudioName: string | null;
  }> => {
    const effectiveCustomAudioPath =
      override?.customAudioPath ?? customAudioPath;
    const effectiveCustomAudioName =
      override?.customAudioName ?? customAudioName;

    if (effectiveCustomAudioPath) {
      const trimmed = effectiveCustomAudioPath.trim();
      if (trimmed.startsWith('content://')) {
        return {
          source: { kind: 'contentUri', uri: trimmed },
          sourceType: 'own',
          sourceLabel: effectiveCustomAudioName ?? 'Local audio',
          selectedAudioId: null,
          customAudioPath: effectiveCustomAudioPath,
          customAudioName: effectiveCustomAudioName,
        };
      }
      if (trimmed.startsWith('file://')) {
        const filePath = decodeURI(trimmed.replace(/^file:\/\//, ''));
        if (filePath.startsWith('/proc/self/fd/')) {
          throw new Error(
            'The selected file points to an ephemeral file descriptor. Please re-pick using a regular file from Files/Documents.'
          );
        }
        return {
          source: { kind: 'fs', path: filePath },
          sourceType: 'own',
          sourceLabel: effectiveCustomAudioName ?? 'Local audio',
          selectedAudioId: null,
          customAudioPath: effectiveCustomAudioPath,
          customAudioName: effectiveCustomAudioName,
        };
      }
      if (trimmed.startsWith('/proc/self/fd/')) {
        throw new Error(
          'The selected file points to an ephemeral file descriptor. Please re-pick using a regular file from Files/Documents.'
        );
      }
      return {
        source: { kind: 'fs', path: trimmed },
        sourceType: 'own',
        sourceLabel: effectiveCustomAudioName ?? 'Local audio',
        selectedAudioId: null,
        customAudioPath: effectiveCustomAudioPath,
        customAudioName: effectiveCustomAudioName,
      };
    }

    const effectiveSelectedAudio = override?.selectedAudio ?? selectedAudio;
    if (!effectiveSelectedAudio) {
      throw new Error('Please select an audio file (example or local WAV)');
    }

    const audioPathConfig = autoModelPath(effectiveSelectedAudio.id);
    const resolvedAudioPath = await resolveModelPath(audioPathConfig);
    return {
      source: { kind: 'fs', path: resolvedAudioPath },
      sourceType: 'example',
      sourceLabel: effectiveSelectedAudio.name,
      selectedAudioId: effectiveSelectedAudio.id,
      customAudioPath: null,
      customAudioName: null,
    };
  };

  const clearOfflineInputBuffer = async (resetSelection: boolean) => {
    offlineBufferBuildRequestRef.current += 1;
    setOfflineBufferBuildProgress(null);
    setOfflineBufferBuildStatus(null);

    if (offlineBufferPlayerRef.current) {
      await offlineBufferPlayerRef.current.destroy().catch(() => {});
      offlineBufferPlayerRef.current = null;
      setOfflineBufferPlaying(false);
    }

    if (pcmPlaybackRef.current) {
      const activePlayback = pcmPlaybackRef.current;
      pcmPlaybackRef.current = null;
      await stopPcmFilePlayback(activePlayback);
    }

    const existing = gSttOfflineInputBuffer;
    gSttOfflineInputBuffer = null;
    setOfflineInputBuffer(null);

    if (existing?.bufferId) {
      await releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
    }

    if (resetSelection) {
      setAudioSourceType(null);
      setSelectedAudio(null);
      setCustomAudioPath(null);
      setCustomAudioName(null);
      setTranscriptionResult(null);
    }
  };

  const appendOfflineTextBuffer = useCallback(
    (result: SttOfflineTextBufferState) => {
      setOfflineTextBuffers((prev) => {
        const next = [
          ...prev.filter((item) => item.bufferId !== result.bufferId),
          result,
        ];
        gSttOfflineTextBuffers = next;
        return next;
      });
    },
    []
  );

  const removeOfflineTextBuffer = useCallback(async (bufferId: string) => {
    await releasePipelineTextBuffer(bufferId).catch(() => {});
    let nextBuffers: SttOfflineTextBufferState[] = [];
    setOfflineTextBuffers((prev) => {
      nextBuffers = prev.filter((item) => item.bufferId !== bufferId);
      gSttOfflineTextBuffers = nextBuffers;
      return nextBuffers;
    });
    setTranscriptionResult((prev) => {
      if (prev?.bufferId !== bufferId) return prev;
      if (nextBuffers.length === 0) return null;
      const latest = nextBuffers[nextBuffers.length - 1];
      return latest ?? null;
    });
  }, []);

  const prepareOfflineInputBuffer = async (
    override?: {
      selectedAudio?: AudioFileInfo | null;
      customAudioPath?: string | null;
      customAudioName?: string | null;
    } | null
  ) => {
    const requestId = ++offlineBufferBuildRequestRef.current;
    setPreparingAudioBuffer(true);
    setOfflineBufferBuildProgress(0);
    setOfflineBufferBuildStatus('Preparing OfflineAudioBuffer...');
    setError(null);
    setErrorSource(null);
    setTranscriptionResult(null);

    try {
      const resolved = await resolveInputSource(override);
      if (requestId !== offlineBufferBuildRequestRef.current) {
        return;
      }

      setOfflineBufferBuildStatus(
        `Decoding \"${resolved.sourceLabel}\" into OfflineAudioBuffer...`
      );

      if (gSttOfflineInputBuffer?.bufferId) {
        await releasePipelineAudioBuffer(gSttOfflineInputBuffer.bufferId).catch(
          () => {}
        );
      }

      const audioRef = await createOfflineAudioBufferFromFile(resolved.source, {
        targetSampleRateHz: LIVE_SAMPLE_RATE,
        forceMono: true,
        onProgress: (event) => {
          if (requestId !== offlineBufferBuildRequestRef.current) {
            return;
          }

          const percent = Math.max(0, Math.min(100, event.percent ?? 0));
          setOfflineBufferBuildProgress(percent);

          const totalFrames = event.totalFramesEstimate ?? 0;
          if (totalFrames > 0) {
            setOfflineBufferBuildStatus(
              `Decoding \"${resolved.sourceLabel}\"... ${Math.round(
                percent
              )}% (${event.framesDecoded}/${totalFrames} frames)`
            );
            return;
          }

          setOfflineBufferBuildStatus(
            `Decoding \"${resolved.sourceLabel}\"... ${Math.round(percent)}%`
          );
        },
      });

      if (requestId !== offlineBufferBuildRequestRef.current) {
        await releasePipelineAudioBuffer(audioRef.bufferId).catch(() => {});
        return;
      }

      const nextBufferState: SttOfflineInputBufferState = {
        bufferId: audioRef.bufferId,
        sourceType: resolved.sourceType,
        sourceLabel: resolved.sourceLabel,
        selectedAudioId: resolved.selectedAudioId,
        customAudioPath: resolved.customAudioPath,
        customAudioName: resolved.customAudioName,
      };
      gSttOfflineInputBuffer = nextBufferState;
      setOfflineInputBuffer(nextBufferState);
      setAudioSourceType(resolved.sourceType);
      setOfflineBufferBuildProgress(null);
      setOfflineBufferBuildStatus(null);
    } catch (err) {
      if (requestId !== offlineBufferBuildRequestRef.current) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setErrorSource('transcribe');
      setError(msg);
      setOfflineBufferBuildProgress(null);
      setOfflineBufferBuildStatus(null);
    } finally {
      if (requestId === offlineBufferBuildRequestRef.current) {
        setPreparingAudioBuffer(false);
      }
    }
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setIsStreamingModel(false);

    try {
      // Release previous engine if switching to another model
      const previous = sttEngineRef.current;
      if (previous) {
        await previous.destroy();
        sttEngineRef.current = null;
        clearSttCache();
      }

      const modelPath = resolveSttModelPath(modelFolder);

      const engine = await createSTT({
        modelPath,
        numThreads: STT_NUM_THREADS,
      });

      const detectResult = await detectSttModel(
        await toDetectSource(modelPath)
      );
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        await engine.destroy();
        setErrorSource('init');
        setError('No models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
        return;
      }

      const normalizedDetected = detectResult.detectedModels.map((model) => ({
        ...model,
        type: model.type as STTModelType,
      }));
      const loadedType =
        (detectResult.modelType as STTModelType) ?? normalizedDetected[0]?.type;

      sttEngineRef.current = engine;
      setDetectedModels(normalizedDetected);
      setCurrentModelFolder(modelFolder);
      setSelectedModelForInit(modelFolder);
      setIsStreamingModel(detectResult.isStreaming);
      if (loadedType) {
        setSelectedModelType(loadedType);
      } else if (normalizedDetected.length === 1 && normalizedDetected[0]) {
        setSelectedModelType(normalizedDetected[0].type);
      }

      const detectedTypes = normalizedDetected.map((m) => m.type).join(', ');
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )}\nDetected models: ${detectedTypes}`
      );

      setSttCache(
        engine,
        modelFolder,
        normalizedDetected,
        loadedType ?? normalizedDetected[0]?.type ?? null
      );

      setAudioSourceType(null);
      setSelectedAudio(null);
      setCustomAudioPath(null);
      setCustomAudioName(null);
      setTranscriptionResult(null);
    } catch (err) {
      // Log full error details for debugging
      console.error('Initialization error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        // Include error code if available (React Native error objects)
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
        // Include stack trace in console
        if (err.stack) {
          console.error('Stack trace:', err.stack);
        }
      } else if (typeof err === 'object' && err !== null) {
        // Handle React Native error objects
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setErrorSource('init');
      setError(errorMessage);
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleTranscribe = async () => {
    if (!currentModelFolder) {
      setErrorSource('transcribe');
      setError('Please select a model first');
      return;
    }

    if (!offlineInputBuffer) {
      setErrorSource('transcribe');
      setError(
        'Please select an audio source and create an OfflineAudioBuffer first'
      );
      return;
    }

    setTranscribing(true);
    setError(null);
    setErrorSource(null);
    setTranscriptionResult(null);

    try {
      const engine = sttEngineRef.current;
      if (!engine) {
        setErrorSource('transcribe');
        setError('STT engine not initialized');
        return;
      }

      const textRef = await createEmptyOfflineTextBuffer();
      const textBufferId = textRef.bufferId;
      let keepTextBuffer = false;
      try {
        await engine.transcribe(offlineInputBuffer.bufferId as any, textRef);

        const rawInfo = await getPipelineTextBufferInfo(textBufferId);
        const info = rawInfo as OfflineTextBufferInfo;
        const [text, tokens, timestamps, durations, lang, emotion, event] =
          await Promise.all([
            info.utf16Length > 0
              ? getOfflineTextBufferTextSlice(textBufferId, 0, info.utf16Length)
              : Promise.resolve(''),
            info.tokenCount > 0
              ? getOfflineTextBufferTokensSlice(
                  textBufferId,
                  0,
                  info.tokenCount
                )
              : Promise.resolve([]),
            info.timestampCount > 0
              ? getOfflineTextBufferTimestampsSlice(
                  textBufferId,
                  0,
                  info.timestampCount
                )
              : Promise.resolve([]),
            info.durationCount > 0
              ? getOfflineTextBufferDurationsSlice(
                  textBufferId,
                  0,
                  info.durationCount
                )
              : Promise.resolve([]),
            info.hasLang
              ? getOfflineTextBufferLang(textBufferId)
              : Promise.resolve(''),
            info.hasEmotion
              ? getOfflineTextBufferEmotion(textBufferId)
              : Promise.resolve(''),
            info.hasEvent
              ? getOfflineTextBufferEvent(textBufferId)
              : Promise.resolve(''),
          ]);

        const nextResult: SttOfflineTextBufferState = {
          text,
          tokens,
          timestamps,
          durations,
          lang,
          emotion,
          event,
          bufferId: textBufferId,
          createdAt: Date.now(),
        };
        setTranscriptionResult(nextResult);
        appendOfflineTextBuffer(nextResult);
        keepTextBuffer = true;
      } finally {
        if (!keepTextBuffer) {
          await releasePipelineTextBuffer(textBufferId).catch(() => {});
        }
      }
    } catch (err) {
      const msg =
        (err instanceof Error ? err.message : (err as any)?.message) ?? '';
      if (msg.includes('cache_last_time')) {
        const friendly =
          'This model appears to be a NeMo streaming transducer (e.g. "streaming fast conformer"). File transcription currently requires a non-streaming NeMo transducer model. Please use a model exported for offline/non-streaming use, or choose another STT model.';
        Alert.alert('Transcription not supported', friendly);
        setErrorSource('transcribe');
        setError(friendly);
        return;
      }

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setErrorSource('transcribe');
      setError(errorMessage);
    } finally {
      setTranscribing(false);
    }
  };

  const handleFree = async () => {
    if (isLiveRecording || livePipelineRef.current) {
      await handleLivePressOut();
    }

    const engine = sttEngineRef.current;
    if (!engine) return;
    try {
      await engine.destroy();
    } catch (err) {
      console.error('STTScreen: Failed to destroy STT:', err);
    }
    sttEngineRef.current = null;
    clearSttCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setInitResult(null);
    await clearOfflineInputBuffer(true);
    setTranscriptionResult(null);
    const textBuffersToRelease = gSttOfflineTextBuffers;
    gSttOfflineTextBuffers = [];
    setOfflineTextBuffers([]);
    for (const item of textBuffersToRelease) {
      await releasePipelineTextBuffer(item.bufferId).catch(() => {});
    }
    setError(null);
    setErrorSource(null);
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setErrorSource(null);
    setTranscriptionResult(null);

    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });

      // res may be an array or single object depending on version/config
      const file = Array.isArray(res) ? res[0] : res;
      const uri =
        file.uri ??
        (file as any).fileCopyUri ??
        (file as any).localUri ??
        (file as any).nativeUri;
      const name = file.name || uri?.split('/')?.pop() || 'local.wav';

      if (!uri) {
        setErrorSource('transcribe');
        setError('Could not get file URI from picker result');
        return;
      }
      const fsPathProbe = uri.startsWith('file://')
        ? decodeURI(uri.replace(/^file:\/\//, ''))
        : uri;
      if (
        uri.startsWith('/proc/self/fd/') ||
        fsPathProbe.startsWith('/proc/self/fd/')
      ) {
        setErrorSource('transcribe');
        setError(
          'The picker returned an ephemeral fd path. Please select a file from Documents/Files so we get a content:// or file:// URI.'
        );
        return;
      }

      setCustomAudioPath(uri);
      setCustomAudioName(name);
      // clear example selection when choosing a local file
      setSelectedAudio(null);
      setAudioSourceType('own');
      await prepareOfflineInputBuffer({
        customAudioPath: uri,
        customAudioName: name,
      });
    } catch (err: any) {
      const isCancel =
        (DocumentPicker &&
          typeof (DocumentPicker as any).isCancel === 'function' &&
          (DocumentPicker as any).isCancel(err)) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled' ||
        (typeof err?.message === 'string' &&
          err.message.toLowerCase().includes('cancel'));
      if (isCancel) {
        // user cancelled, ignore
        return;
      }
      console.error('File pick error:', err);
      setErrorSource('transcribe');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePlayAudio = async () => {
    if (!customAudioPath) return;
    try {
      if (pcmPlaybackRef.current) {
        const activePlayback = pcmPlaybackRef.current;
        pcmPlaybackRef.current = null;
        await stopPcmFilePlayback(activePlayback);
      }

      let nextPlayback: ActivePcmFilePlayback | null = null;
      await setPipelineAudioRoutePreference({
        outputDeviceId: selectedOutputDeviceId ?? null,
      }).catch(() => {});
      nextPlayback = await startPcmFilePlayback(customAudioPath, () => {
        if (pcmPlaybackRef.current === nextPlayback) {
          pcmPlaybackRef.current = null;
        }
      });
      pcmPlaybackRef.current = nextPlayback;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
    }
  };

  const handleToggleOfflineBufferPlayback = async () => {
    const buffer = offlineInputBuffer;
    if (!buffer) return;

    if (offlineBufferPlayerRef.current) {
      const current = offlineBufferPlayerRef.current;
      offlineBufferPlayerRef.current = null;
      setOfflineBufferPlaying(false);
      await current.destroy().catch(() => {});
      return;
    }

    try {
      await setPipelineAudioRoutePreference({
        outputDeviceId: selectedOutputDeviceId ?? null,
      }).catch(() => {});
      const player = await createPcmPlayer(buffer.bufferId as any, {
        onEnded: () => {
          const current = offlineBufferPlayerRef.current;
          offlineBufferPlayerRef.current = null;
          setOfflineBufferPlaying(false);
          if (current) {
            current.destroy().catch(() => {});
          }
        },
      });
      offlineBufferPlayerRef.current = player;
      setOfflineBufferPlaying(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback failed', msg);
      setOfflineBufferPlaying(false);
    }
  };

  const handleLivePressIn = async () => {
    if (!currentModelFolder || !selectedModelType || !isLiveSupported) return;
    if (isLiveRecording) {
      handleLivePressOut();
      return;
    }
    if (livePipelineRef.current) {
      await handleLivePressOut();
    }

    setError(null);
    setErrorSource(null);
    setTranscriptionResult(null);

    let engine: LiveSttEngine | null = null;
    let liveAudioBufferId: string | null = null;
    let liveTextBufferId: string | null = null;
    let pipelineHandle: SttPipelineHandle | null = null;
    let micErrorSubscription: { remove: () => void } | null = null;
    let audioUnsubscribe = () => {};
    let textUnsubscribe = () => {};

    try {
      const modelPathConfig = resolveSttModelPath(currentModelFolder);

      const onlineType: 'auto' = 'auto';

      engine = await createStreamingSTT({
        modelPath: modelPathConfig,
        modelType: onlineType,
        numThreads: STT_NUM_THREADS,
      });
      streamingEngineRef.current = engine;

      const liveAudioBuffer = await createEmptyLiveAudioBuffer({
        sampleRate: LIVE_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 120,
        retention: 'auto',
        emitAppendedEvents: false,
      });
      liveAudioBufferId = liveAudioBuffer.bufferId;
      audioUnsubscribe = liveAudioBuffer.unsubscribeEvents;

      const liveTextBuffer = await createLiveTextBuffer({
        windowMaxChars: 65536,
        maxSegments: 2048,
      });
      liveTextBufferId = liveTextBuffer.bufferId;
      textUnsubscribe = liveTextBuffer.unsubscribeEvents;

      pipelineHandle = await engine.transcribe(
        liveAudioBuffer.bufferId,
        liveTextBuffer.bufferId
      );

      micErrorSubscription = DeviceEventEmitter.addListener(
        'pipelineLiveAudioError',
        (event: { message?: string; liveBufferId?: string }) => {
          if (
            event.liveBufferId != null &&
            event.liveBufferId !== liveAudioBuffer.bufferId
          ) {
            return;
          }
          setErrorSource('transcribe');
          setError(event.message ?? 'Microphone error');
        }
      );

      liveAccumulatorRef.current = {
        segmentCount: 0,
        segmentTexts: [],
      };
      stopLivePreviewPolling();
      livePreviewTimerRef.current = setInterval(() => {
        syncLivePreview(liveTextBuffer.bufferId).catch(() => {});
      }, 150);
      syncLivePreview(liveTextBuffer.bufferId).catch(() => {});

      livePipelineRef.current = {
        liveAudioBufferId: liveAudioBuffer.bufferId,
        liveTextBufferId: liveTextBuffer.bufferId,
        pipelineHandle,
        micErrorSubscription,
        audioUnsubscribe,
        textUnsubscribe,
      };

      try {
        await setPipelineAudioRoutePreference({
          inputDeviceId: selectedInputDeviceId ?? null,
        }).catch(() => {});
        await startMicToLiveAudioBuffer(liveAudioBuffer.bufferId, {
          emitToJs: false,
        });
      } catch (startErr) {
        throw startErr;
      }

      setIsLiveRecording(true);
    } catch (err) {
      stopLivePreviewPolling();
      await stopMicToLiveAudioBuffer().catch(() => {});

      micErrorSubscription?.remove();
      audioUnsubscribe();
      textUnsubscribe();

      if (pipelineHandle) {
        await pipelineHandle.stop().catch(() => {});
      }

      if (engine) {
        await engine.destroy().catch(() => {});
        if (streamingEngineRef.current === engine) {
          streamingEngineRef.current = null;
        }
      }

      if (liveTextBufferId) {
        await releasePipelineTextBuffer(liveTextBufferId).catch(() => {});
      }
      if (liveAudioBufferId) {
        await releasePipelineAudioBuffer(liveAudioBufferId).catch(() => {});
      }

      livePipelineRef.current = null;
      liveAccumulatorRef.current = { segmentCount: 0, segmentTexts: [] };

      const msg = err instanceof Error ? err.message : String(err);
      setErrorSource('transcribe');
      setError(msg);
    }
  };

  const handleLivePressOut = async () => {
    if (!isLiveRecording && !livePipelineRef.current) return;
    setIsLiveRecording(false);

    const pipelineState = livePipelineRef.current;
    livePipelineRef.current = null;

    stopLivePreviewPolling();
    await stopMicToLiveAudioBuffer().catch(() => {});

    if (pipelineState) {
      try {
        await pipelineState.pipelineHandle.flush();
      } catch {
        // ignore flush races during teardown
      }

      try {
        const segmentCount = await getLiveTextBufferSegmentCount(
          pipelineState.liveTextBufferId
        );
        const segments =
          segmentCount > 0
            ? await getLiveTextBufferSegments(
                pipelineState.liveTextBufferId,
                0,
                segmentCount,
                { includeTokens: true, includeTimestamps: true }
              )
            : [];
        const partialText = await getLiveTextBufferPartialSlice(
          pipelineState.liveTextBufferId,
          0,
          4096
        );
        const segmentTexts = segments
          .map((segment) => segment.text)
          .filter((segment) => segment.trim().length > 0);
        const text = composeLiveText(segmentTexts, partialText);
        const tokens = segments.flatMap((segment) => segment.tokens ?? []);
        const timestamps = segments.flatMap(
          (segment) => segment.timestamps ?? []
        );

        setTranscriptionResult(
          buildTranscriptionResult(text, tokens, timestamps)
        );
      } catch {
        // ignore result-read errors during teardown
      }

      await pipelineState.pipelineHandle.stop().catch(() => {});
      pipelineState.micErrorSubscription.remove();
      pipelineState.audioUnsubscribe();
      pipelineState.textUnsubscribe();

      await releasePipelineTextBuffer(pipelineState.liveTextBufferId).catch(
        () => {}
      );
      await releasePipelineAudioBuffer(pipelineState.liveAudioBufferId).catch(
        () => {}
      );
    }

    const engine = streamingEngineRef.current;
    if (engine) {
      await engine.destroy().catch(() => {});
      if (streamingEngineRef.current === engine) {
        streamingEngineRef.current = null;
      }
    }

    liveAccumulatorRef.current = { segmentCount: 0, segmentTexts: [] };
  };

  const showLiveNotSupportedMessage = () => {
    const message =
      'This model does not support live transcription. Use a streaming model (e.g. transducer, paraformer, zipformer2_ctc).';
    if (Platform.OS === 'android') {
      ToastAndroid.show(message, ToastAndroid.LONG);
    } else {
      Alert.alert('Live not supported', message);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
        >
          {currentModelFolder != null && (
            <TouchableOpacity
              style={styles.freeButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.freeButtonText}>Release model</Text>
            </TouchableOpacity>
          )}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize Model</Text>
            <Text style={styles.hint}>
              Select a model, then tap "Use model".
            </Text>

            {(currentModelFolder || selectedModelForInit) && (
              <View style={styles.currentModelContainer}>
                <Text style={styles.currentModelText}>
                  {currentModelFolder
                    ? `Initialized: ${getModelDisplayName(currentModelFolder)}`
                    : `Selected: ${
                        selectedModelForInit
                          ? getModelDisplayName(selectedModelForInit)
                          : ''
                      }`}
                </Text>
              </View>
            )}

            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>
                  Discovering available models...
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No models found. Please add STT models as bundled assets,
                  downloaded models, or PAD models. See STT_MODEL_SETUP.md for
                  details.
                </Text>
              </View>
            ) : (
              <View style={styles.modelButtons}>
                {availableModels.map((modelFolder) => {
                  const isSelected = selectedModelForInit === modelFolder;
                  const isInitialized = currentModelFolder === modelFolder;
                  return (
                    <TouchableOpacity
                      key={modelFolder}
                      style={[
                        styles.modelButton,
                        isSelected && styles.modelButtonActive,
                        isInitialized && styles.modelButtonInitialized,
                        loading && styles.buttonDisabled,
                      ]}
                      onPress={() => setSelectedModelForInit(modelFolder)}
                      disabled={loading}
                    >
                      <Text
                        style={[
                          styles.modelButtonText,
                          isSelected && styles.modelButtonTextActive,
                        ]}
                      >
                        {getModelDisplayName(modelFolder)}
                      </Text>
                      {(() => {
                        const sizeHintInfo = getSizeHint(modelFolder);
                        const qualityHintInfo = getQualityHint(modelFolder);

                        return (
                          <View style={styles.modelHintRow}>
                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={sizeHintInfo.iconName as any}
                                size={12}
                                color={sizeHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {sizeHintInfo.tier}
                              </Text>
                            </View>

                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={qualityHintInfo.iconName as any}
                                size={12}
                                color={qualityHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {qualityHintInfo.text.split(',')[0]}
                              </Text>
                            </View>
                          </View>
                        );
                      })()}
                      <Text style={styles.modelFolderText}>{modelFolder}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <>
              <TouchableOpacity
                style={[
                  styles.button,
                  styles.applyButton,
                  loading && styles.buttonDisabled,
                ]}
                onPress={() =>
                  handleInitialize(
                    selectedModelForInit ?? currentModelFolder ?? ''
                  )
                }
                disabled={
                  loading || (!selectedModelForInit && !currentModelFolder)
                }
              >
                {loading ? (
                  <View style={styles.applyButtonContent}>
                    <ActivityIndicator
                      size="small"
                      color="#FFFFFF"
                      style={styles.applyButtonSpinner}
                    />
                    <Text style={styles.buttonText}>Initializing…</Text>
                  </View>
                ) : (
                  <Text style={styles.buttonText}>Use model</Text>
                )}
              </TouchableOpacity>
            </>

            {initResult && !(error && errorSource === 'init') && (
              <View style={styles.resultContainer}>
                <Text style={styles.resultLabel}>Result:</Text>
                <Text style={styles.resultText}>{initResult}</Text>
              </View>
            )}

            {error && errorSource === 'init' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          {detectedModels.length > 1 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Select Model Type</Text>
              <Text style={styles.hint}>
                Multiple model types were detected. Select which one to use for
                transcription.
              </Text>

              <View style={styles.detectedModelsContainer}>
                {detectedModels.map((model, index) => (
                  <TouchableOpacity
                    key={`${model.type}-${index}`}
                    style={[
                      styles.detectedModelButton,
                      selectedModelType === model.type &&
                        styles.detectedModelButtonActive,
                    ]}
                    onPress={() => setSelectedModelType(model.type)}
                  >
                    <Text
                      style={[
                        styles.detectedModelButtonText,
                        selectedModelType === model.type &&
                          styles.detectedModelButtonTextActive,
                      ]}
                    >
                      {model.type.toUpperCase()}
                    </Text>
                    <Text style={styles.detectedModelPath}>
                      {getModelDisplayName(
                        model.modelDir.replace(/^.*[/\\]/, '') || model.modelDir
                      )}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!selectedModelType && (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    Please select a model type above
                  </Text>
                </View>
              )}
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {detectedModels.length > 1
                ? '3. Transcribe Audio'
                : '2. Transcribe Audio'}
            </Text>
            <Text style={styles.hint}>
              Select an audio source, create an OfflineAudioBuffer once, and
              transcribe it using the selected model.
            </Text>
            <Text style={styles.hint}>
              SDK note: remember to release pipeline buffers when they are no
              longer needed to avoid memory leaks.
            </Text>

            {!selectedModelType && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  {!currentModelFolder
                    ? 'Please initialize a model directory first'
                    : 'Please select a model type first'}
                </Text>
              </View>
            )}

            {selectedModelType &&
              (audioSourceType === 'example' || audioSourceType === 'own') &&
              (preparingAudioBuffer || offlineBufferBuildStatus != null) && (
                <View style={styles.decodeProgressContainer}>
                  <View style={styles.decodeProgressHeaderRow}>
                    <Text style={styles.decodeProgressLabel}>
                      {offlineBufferBuildStatus ??
                        'Preparing OfflineAudioBuffer...'}
                    </Text>
                    {offlineBufferBuildProgress != null && (
                      <Text style={styles.decodeProgressPercent}>
                        {Math.round(offlineBufferBuildProgress)}%
                      </Text>
                    )}
                  </View>
                  <View style={styles.decodeProgressTrack}>
                    <View
                      style={[
                        styles.decodeProgressFill,
                        {
                          width: `${Math.max(
                            0,
                            Math.min(100, offlineBufferBuildProgress ?? 0)
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                  {preparingAudioBuffer && (
                    <Text style={styles.decodeProgressMeta}>
                      Large files can take a while to decode.
                    </Text>
                  )}
                </View>
              )}

            {selectedModelType && !offlineInputBuffer && !audioSourceType && (
              <>
                <Text style={styles.subsectionTitle}>Choose Audio Source:</Text>
                <View style={styles.sourceChoiceRow}>
                  <TouchableOpacity
                    style={[styles.sourceChoiceButton, styles.flex1]}
                    onPress={() => {
                      setAudioSourceType('example');
                      setCustomAudioPath(null);
                      setCustomAudioName(null);
                      setOfflineBufferBuildProgress(null);
                      setOfflineBufferBuildStatus(null);
                    }}
                    disabled={preparingAudioBuffer || transcribing || loading}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="folder-outline"
                        size={18}
                        style={styles.iconInline}
                      />
                      <Text style={styles.sourceChoiceButtonText}>
                        Example Audio
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sourceChoiceButton, styles.flex1]}
                    onPress={() => {
                      setAudioSourceType('own');
                      setOfflineBufferBuildProgress(null);
                      setOfflineBufferBuildStatus(null);
                    }}
                    disabled={preparingAudioBuffer || transcribing || loading}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="musical-notes"
                        size={18}
                        style={styles.iconInline}
                      />
                      <Text style={styles.sourceChoiceButtonText}>
                        Select Your Own Audio
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.sourceChoiceButton,
                      styles.flex1,
                      !isLiveSupported && styles.sourceChoiceButtonDisabled,
                    ]}
                    onPress={() => {
                      if (isLiveSupported) {
                        setAudioSourceType('live');
                        setOfflineBufferBuildProgress(null);
                        setOfflineBufferBuildStatus(null);
                      } else {
                        showLiveNotSupportedMessage();
                      }
                    }}
                    disabled={preparingAudioBuffer || transcribing || loading}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="mic"
                        size={18}
                        style={styles.iconInline}
                      />
                      <Text style={styles.sourceChoiceButtonText}>
                        Live Transcription
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {selectedModelType && offlineInputBuffer && (
              <View style={styles.selectedFileContainer}>
                <View style={styles.bufferHeaderRow}>
                  <View style={styles.bufferHeaderTextWrap}>
                    <Text style={styles.selectedFileLabel}>
                      OfflineAudioBuffer ready:
                    </Text>
                    <Text style={styles.selectedFileName}>
                      {offlineInputBuffer.sourceLabel}
                    </Text>
                    <Text style={styles.bufferIdText} selectable>
                      {offlineInputBuffer.bufferId}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.bufferDeleteButton}
                    onPress={() => {
                      clearOfflineInputBuffer(true).catch(() => {});
                    }}
                    disabled={loading || transcribing || preparingAudioBuffer}
                  >
                    <Ionicons name="trash-outline" size={18} color="#b71c1c" />
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.mt12,
                    (transcribing || loading || preparingAudioBuffer) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={handleTranscribe}
                  disabled={transcribing || loading || preparingAudioBuffer}
                >
                  {transcribing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Transcribe Audio</Text>
                  )}
                </TouchableOpacity>

                <AudioDeviceDropdown
                  label="Output device"
                  devices={outputDevices}
                  selectedDeviceId={selectedOutputDeviceId}
                  onSelectDeviceId={setSelectedOutputDeviceId}
                  disabled={loading || transcribing || preparingAudioBuffer}
                />

                <TouchableOpacity
                  style={[
                    styles.playButton,
                    styles.mt12,
                    (loading || transcribing || preparingAudioBuffer) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={handleToggleOfflineBufferPlayback}
                  disabled={loading || transcribing || preparingAudioBuffer}
                >
                  <View style={styles.rowAlignCenter}>
                    <Ionicons
                      name={offlineBufferPlaying ? 'stop' : 'play'}
                      size={16}
                      style={styles.iconInline}
                    />
                    <Text style={styles.playButtonText}>
                      {offlineBufferPlaying ? 'Stop Buffer' : 'Play Buffer'}
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {selectedModelType &&
              audioSourceType === 'example' &&
              !offlineInputBuffer &&
              availableAudioFiles.length > 0 && (
                <>
                  <Text style={styles.subsectionTitle}>Select Audio File:</Text>
                  <View style={styles.audioFilesContainer}>
                    {availableAudioFiles.map((audioFile) => (
                      <TouchableOpacity
                        key={audioFile.id}
                        style={[
                          styles.audioFileButton,
                          selectedAudio?.id === audioFile.id &&
                            styles.audioFileButtonActive,
                        ]}
                        disabled={
                          preparingAudioBuffer || loading || transcribing
                        }
                        onPress={async () => {
                          setSelectedAudio(audioFile);
                          setCustomAudioPath(null);
                          setCustomAudioName(null);
                          await prepareOfflineInputBuffer({
                            selectedAudio: audioFile,
                          });
                        }}
                      >
                        <Text
                          style={[
                            styles.audioFileButtonText,
                            selectedAudio?.id === audioFile.id &&
                              styles.audioFileButtonTextActive,
                          ]}
                        >
                          {audioFile.name}
                        </Text>
                        <Text style={styles.audioFileDescription}>
                          {audioFile.description}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.mt15]}
                    onPress={() => {
                      clearOfflineInputBuffer(true).catch(() => {});
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>
                      ← Change Audio Source
                    </Text>
                  </TouchableOpacity>
                </>
              )}

            {selectedModelType &&
              audioSourceType === 'own' &&
              !offlineInputBuffer && (
                <>
                  <Text style={styles.subsectionTitle}>
                    Select Local WAV File:
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (loading || preparingAudioBuffer || transcribing) &&
                        styles.buttonDisabled,
                    ]}
                    onPress={handlePickLocalFile}
                    disabled={loading || preparingAudioBuffer || transcribing}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="folder-open-outline"
                        size={16}
                        style={styles.iconInline}
                      />
                      <Text style={styles.buttonText}>Choose Local WAV</Text>
                    </View>
                  </TouchableOpacity>

                  {customAudioName && (
                    <View style={styles.selectedFileContainer}>
                      <Text style={styles.selectedFileLabel}>
                        Selected file:
                      </Text>
                      <Text style={styles.selectedFileName}>
                        {customAudioName}
                      </Text>

                      <AudioDeviceDropdown
                        label="Output device"
                        devices={outputDevices}
                        selectedDeviceId={selectedOutputDeviceId}
                        onSelectDeviceId={setSelectedOutputDeviceId}
                        disabled={loading}
                      />

                      <TouchableOpacity
                        style={[styles.playButton]}
                        onPress={handlePlayAudio}
                      >
                        <View style={styles.rowAlignCenter}>
                          <Ionicons
                            name="play"
                            size={16}
                            style={styles.iconInline}
                          />
                          <Text style={styles.playButtonText}>Play Audio</Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.mt15]}
                    onPress={() => {
                      clearOfflineInputBuffer(true).catch(() => {});
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>
                      ← Change Audio Source
                    </Text>
                  </TouchableOpacity>
                </>
              )}

            {selectedModelType && audioSourceType === 'live' && (
              <>
                <Text style={styles.subsectionTitle}>Live Transcription</Text>
                <AudioDeviceDropdown
                  label="Input device"
                  devices={inputDevices}
                  selectedDeviceId={selectedInputDeviceId}
                  onSelectDeviceId={setSelectedInputDeviceId}
                  disabled={isLiveRecording}
                />
                <View style={styles.rowCenter}>
                  <Pressable
                    style={[
                      styles.liveMicButton,
                      isLiveRecording && styles.liveMicButtonActive,
                    ]}
                    onPressIn={handleLivePressIn}
                    onPressOut={handleLivePressOut}
                  >
                    <Ionicons name="mic" size={48} style={styles.liveMicIcon} />
                  </Pressable>
                </View>
                <Text style={styles.liveHint}>
                  Hold the button and speak. Release to see the final result.
                </Text>
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.mt15]}
                  onPress={() => {
                    if (isLiveRecording) return;
                    setAudioSourceType(null);
                    setTranscriptionResult(null);
                  }}
                  disabled={isLiveRecording}
                >
                  <Text style={styles.secondaryButtonText}>
                    ← Change Audio Source
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {selectedModelType &&
              (audioSourceType === 'example' ||
                audioSourceType === 'own' ||
                audioSourceType === 'live') &&
              (audioSourceType === 'live' ||
                transcriptionResult != null ||
                offlineTextBuffers.length > 0) && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>3. Result</Text>
                  <Text style={styles.hint}>
                    Transcription output is stored in OfflineTextBuffers. Remove
                    buffers you no longer need to release memory.
                  </Text>
                  <View
                    style={[
                      styles.resultSection,
                      audioSourceType === 'live' && styles.liveResultContainer,
                    ]}
                  >
                    {transcriptionResult ? (
                      <>
                        <View style={styles.resultLabelRow}>
                          <Text style={styles.resultLabel}>Transcription:</Text>
                          <View style={styles.resultLabelActions}>
                            <TouchableOpacity
                              style={styles.copyIconButton}
                              onPress={() => {
                                const t = transcriptionResult.text ?? '';
                                if (t) Clipboard.setString(t);
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Ionicons
                                name="copy-outline"
                                size={20}
                                color="#2e7d32"
                              />
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.copyIconButton}
                              onPress={() => {
                                const t = transcriptionResult.text ?? '';
                                if (t) {
                                  Share.share({
                                    message: t,
                                    title: 'Transcription',
                                  });
                                }
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Ionicons
                                name="share-outline"
                                size={20}
                                color="#2e7d32"
                              />
                            </TouchableOpacity>
                            {transcriptionResult.bufferId ? (
                              <TouchableOpacity
                                style={styles.copyIconButton}
                                onPress={() => {
                                  removeOfflineTextBuffer(
                                    transcriptionResult.bufferId as string
                                  ).catch(() => {});
                                }}
                                hitSlop={{
                                  top: 8,
                                  bottom: 8,
                                  left: 8,
                                  right: 8,
                                }}
                              >
                                <Ionicons
                                  name="trash-outline"
                                  size={20}
                                  color="#b71c1c"
                                />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                        <Text style={styles.resultText} selectable>
                          {transcriptionResult.text ?? ''}
                        </Text>
                        {(transcriptionResult.lang ||
                          transcriptionResult.emotion ||
                          transcriptionResult.event) && (
                          <View style={styles.metaRow}>
                            {transcriptionResult.lang ? (
                              <Text style={styles.metaText}>
                                Lang: {transcriptionResult.lang}
                              </Text>
                            ) : null}
                            {transcriptionResult.emotion ? (
                              <Text style={styles.metaText}>
                                Emotion: {transcriptionResult.emotion}
                              </Text>
                            ) : null}
                            {transcriptionResult.event ? (
                              <Text style={styles.metaText}>
                                Event: {transcriptionResult.event}
                              </Text>
                            ) : null}
                          </View>
                        )}
                        <TouchableOpacity
                          style={styles.expandHeader}
                          onPress={() => setTokensExpanded((e) => !e)}
                        >
                          <Ionicons
                            name={
                              tokensExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
                            }
                            size={18}
                            color="#2e7d32"
                          />
                          <Text style={styles.expandHeaderText}>
                            Tokens ({(transcriptionResult.tokens ?? []).length})
                          </Text>
                        </TouchableOpacity>
                        {tokensExpanded && (
                          <View style={styles.expandContent}>
                            <View style={styles.expandActionRow}>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr = transcriptionResult.tokens ?? [];
                                  Clipboard.setString(
                                    Array.isArray(arr)
                                      ? JSON.stringify(arr)
                                      : String(arr)
                                  );
                                }}
                              >
                                <Ionicons
                                  name="copy-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr = transcriptionResult.tokens ?? [];
                                  const str = Array.isArray(arr)
                                    ? JSON.stringify(arr)
                                    : String(arr);
                                  Share.share({
                                    message: str,
                                    title: 'Tokens',
                                  });
                                }}
                              >
                                <Ionicons
                                  name="share-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
                              </TouchableOpacity>
                            </View>
                            <Text style={styles.expandListItem}>
                              {(transcriptionResult.tokens ?? []).join(', ')}
                            </Text>
                          </View>
                        )}
                        <TouchableOpacity
                          style={styles.expandHeader}
                          onPress={() => setTimestampsExpanded((e) => !e)}
                        >
                          <Ionicons
                            name={
                              timestampsExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
                            }
                            size={18}
                            color="#2e7d32"
                          />
                          <Text style={styles.expandHeaderText}>
                            Timestamps (
                            {(transcriptionResult.timestamps ?? []).length})
                          </Text>
                        </TouchableOpacity>
                        {timestampsExpanded && (
                          <View style={styles.expandContent}>
                            <View style={styles.expandActionRow}>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.timestamps ?? [];
                                  Clipboard.setString(
                                    Array.isArray(arr)
                                      ? JSON.stringify(arr)
                                      : String(arr)
                                  );
                                }}
                              >
                                <Ionicons
                                  name="copy-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.timestamps ?? [];
                                  const str = Array.isArray(arr)
                                    ? JSON.stringify(arr)
                                    : String(arr);
                                  Share.share({
                                    message: str,
                                    title: 'Timestamps',
                                  });
                                }}
                              >
                                <Ionicons
                                  name="share-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
                              </TouchableOpacity>
                            </View>
                            {(transcriptionResult.timestamps ?? []).length >
                              0 && (
                              <ScrollView
                                style={styles.expandListWrap}
                                nestedScrollEnabled
                                showsVerticalScrollIndicator
                              >
                                {(transcriptionResult.timestamps ?? []).map(
                                  (item, i) => (
                                    <Text
                                      key={`ts-${i}`}
                                      style={styles.expandListItem}
                                    >
                                      [{String(item)}]
                                    </Text>
                                  )
                                )}
                              </ScrollView>
                            )}
                          </View>
                        )}
                        <TouchableOpacity
                          style={styles.expandHeader}
                          onPress={() => setDurationsExpanded((e) => !e)}
                        >
                          <Ionicons
                            name={
                              durationsExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
                            }
                            size={18}
                            color="#2e7d32"
                          />
                          <Text style={styles.expandHeaderText}>
                            Durations (
                            {(transcriptionResult.durations ?? []).length})
                          </Text>
                        </TouchableOpacity>
                        {durationsExpanded && (
                          <View style={styles.expandContent}>
                            <View style={styles.expandActionRow}>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.durations ?? [];
                                  Clipboard.setString(
                                    Array.isArray(arr)
                                      ? JSON.stringify(arr)
                                      : String(arr)
                                  );
                                }}
                              >
                                <Ionicons
                                  name="copy-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.durations ?? [];
                                  const str = Array.isArray(arr)
                                    ? JSON.stringify(arr)
                                    : String(arr);
                                  Share.share({
                                    message: str,
                                    title: 'Durations',
                                  });
                                }}
                              >
                                <Ionicons
                                  name="share-outline"
                                  size={18}
                                  color="#2e7d32"
                                  style={styles.expandActionIcon}
                                />
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
                              </TouchableOpacity>
                            </View>
                            {(transcriptionResult.durations ?? []).length >
                              0 && (
                              <ScrollView
                                style={styles.expandListWrap}
                                nestedScrollEnabled
                                showsVerticalScrollIndicator
                              >
                                {(transcriptionResult.durations ?? []).map(
                                  (item, i) => (
                                    <Text
                                      key={`d-${i}`}
                                      style={styles.expandListItem}
                                    >
                                      [{String(item)}]
                                    </Text>
                                  )
                                )}
                              </ScrollView>
                            )}
                          </View>
                        )}
                        <View style={styles.resultButtonRow}>
                          <TouchableOpacity
                            style={styles.resultActionButton}
                            onPress={() => {
                              const json = JSON.stringify(
                                transcriptionResult,
                                null,
                                2
                              );
                              Clipboard.setString(json);
                            }}
                          >
                            <Ionicons
                              name="copy-outline"
                              size={18}
                              color="#2e7d32"
                              style={styles.resultActionIcon}
                            />
                            <Text style={styles.resultActionText}>
                              Copy all as JSON
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.resultActionButton}
                            onPress={() => {
                              const json = JSON.stringify(
                                transcriptionResult,
                                null,
                                2
                              );
                              Share.share({
                                message: json,
                                title: 'Export all as JSON',
                              });
                            }}
                          >
                            <Ionicons
                              name="document-text-outline"
                              size={18}
                              color="#2e7d32"
                              style={styles.resultActionIcon}
                            />
                            <Text style={styles.resultActionText}>
                              Export all as JSON
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </>
                    ) : (
                      <Text style={styles.liveResultPlaceholder}>
                        {audioSourceType === 'live'
                          ? 'Transcription will appear here while you speak.'
                          : 'No active transcription selected.'}
                      </Text>
                    )}
                  </View>

                  {offlineTextBuffers.length > 0 && (
                    <View style={styles.textBufferList}>
                      <Text style={styles.textBufferListTitle}>
                        Active OfflineTextBuffer
                      </Text>
                      {offlineTextBuffers.map((item) => (
                        <View key={item.bufferId} style={styles.textBufferItem}>
                          <View style={styles.textBufferItemHeader}>
                            <TouchableOpacity
                              style={styles.flex1}
                              onPress={() => setTranscriptionResult(item)}
                            >
                              <Text style={styles.textBufferItemLabel}>
                                {item.text?.trim()
                                  ? item.text.trim().slice(0, 64)
                                  : 'Empty transcription'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.copyIconButton}
                              onPress={() => {
                                removeOfflineTextBuffer(item.bufferId).catch(
                                  () => {}
                                );
                              }}
                              hitSlop={{
                                top: 8,
                                bottom: 8,
                                left: 8,
                                right: 8,
                              }}
                            >
                              <Ionicons
                                name="trash-outline"
                                size={18}
                                color="#b71c1c"
                              />
                            </TouchableOpacity>
                          </View>
                          <Text style={styles.bufferIdText} selectable>
                            {item.bufferId}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}

            {selectedModelType &&
              audioSourceType === 'example' &&
              availableAudioFiles.length === 0 && (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    No audio files available for this model
                  </Text>
                </View>
              )}

            {error && errorSource === 'transcribe' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
      <ScreenIntroModal screenId="STT" />
    </SafeAreaView>
  );
}
