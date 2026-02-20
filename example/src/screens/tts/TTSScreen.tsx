import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  Share,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  initializeTTS,
  generateSpeech,
  generateSpeechWithTimestamps,
  generateSpeechStream,
  cancelSpeechStream,
  startTtsPcmPlayer,
  writeTtsPcmChunk,
  stopTtsPcmPlayer,
  updateTtsParams,
  unloadTTS,
  getModelInfo,
  saveAudioToFile,
  saveAudioToContentUri,
  saveTextToContentUri,
  copyContentUriToCache,
  shareAudioFile,
  type TTSModelType,
  type TtsGenerationOptions,
} from 'react-native-sherpa-onnx/tts';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';
import {
  listDownloadedModelsByCategory,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../../modelConfig';
import {
  getSizeHint,
  getQualityHint,
  RECOMMENDED_MODEL_IDS,
} from '../../utils/recommendedModels';
import { getCpuCoreCount } from '../../cpuInfo';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';

const PAD_PACK_NAME = 'sherpa_models';

/** Minimal WAV parser: 44-byte header, 16-bit PCM LE → float samples in [-1, 1]. Mono or stereo (takes first channel). Path must be readable by RNFS (file path or cache path). */
async function readWavToFloatSamples(
  path: string
): Promise<{ samples: number[]; sampleRate: number }> {
  const base64 = await RNFS.readFile(path, 'base64');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const view = new DataView(bytes.buffer);
  if (bytes.length < 44) throw new Error('File too short for WAV');
  const sampleRate = view.getUint32(24, true);
  const numChannels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16) throw new Error('Only 16-bit WAV supported');

  const dataOffset = 44;
  const numSamples = Math.floor((bytes.length - dataOffset) / 2);
  const samples: number[] = [];
  for (let i = 0; i < numSamples; i += numChannels) {
    const v = view.getInt16(dataOffset + i * 2, true);
    samples.push(v / 32768);
  }
  return { samples, sampleRate };
}

export default function TTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: TTSModelType; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] =
    useState<TTSModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [initializingModel, setInitializingModel] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState<string>('Hello, world!');
  const [speakerId, setSpeakerId] = useState<string>('0');
  const [speed, setSpeed] = useState<string>('1.0');
  const [silenceScale, setSilenceScale] = useState<string>('');
  const [numSteps, setNumSteps] = useState<string>('');
  const [referenceText, setReferenceText] = useState<string>('');
  const [referenceAudio, setReferenceAudio] = useState<{
    samples: number[];
    sampleRate: number;
  } | null>(null);
  const [referenceAudioFileName, setReferenceAudioFileName] = useState<
    string | null
  >(null);
  const [extraOptions, setExtraOptions] = useState<string>('');
  const [noiseScale, setNoiseScale] = useState<string>('');
  const [noiseScaleW, setNoiseScaleW] = useState<string>('');
  const [lengthScale, setLengthScale] = useState<string>('');
  const [outputFormat, setOutputFormat] = useState<'wav' | 'mp3' | 'flac'>(
    'wav'
  );
  const [showOutputFormatPicker, setShowOutputFormatPicker] = useState(false);
  const [voiceCloningExpanded, setVoiceCloningExpanded] = useState(false);
  const [generatedAudio, setGeneratedAudio] = useState<{
    samples: number[];
    sampleRate: number;
  } | null>(null);
  const [generatedSubtitles, setGeneratedSubtitles] = useState<Array<{
    text: string;
    start: number;
    end: number;
  }> | null>(null);
  const [subtitleEstimated, setSubtitleEstimated] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState<number | null>(null);
  const [streamSampleCount, setStreamSampleCount] = useState(0);
  const [modelInfo, setModelInfo] = useState<{
    sampleRate: number;
    numSpeakers: number;
  } | null>(null);
  const [savedAudioPath, setSavedAudioPath] = useState<string | null>(null);
  const [savedSubtitlePath, setSavedSubtitlePath] = useState<string | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [soundInstance, setSoundInstance] = useState<Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadingSound, setLoadingSound] = useState(false);
  const [cachedPlaybackPath, setCachedPlaybackPath] = useState<string | null>(
    null
  );
  const [cachedPlaybackSource, setCachedPlaybackSource] = useState<
    string | null
  >(null);
  const [cpuCoreCount, setCpuCoreCount] = useState<number>(2);
  const [ttsThreadOption, setTtsThreadOption] = useState<
    'saver' | 'standard' | 'balanced' | 'maximum'
  >('standard');
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);

  const getDisplayPath = (path: string) => {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  };

  const getShareUrl = (path: string) => {
    const decoded = getDisplayPath(path);
    if (decoded.startsWith('content://') || decoded.startsWith('file://')) {
      return decoded;
    }
    if (path.startsWith('content://') || path.startsWith('file://')) {
      return path;
    }
    return Platform.OS === 'android' ? `file://${path}` : path;
  };
  const currentModelFolderRef = useRef<string | null>(null);
  const soundInstanceRef = useRef<Sound | null>(null);
  const streamChunksRef = useRef<number[][]>([]);
  const streamSampleRateRef = useRef<number | null>(null);
  const streamUnsubscribeRef = useRef<(() => void) | null>(null);
  const streamPlaybackStartedRef = useRef(false);
  const streamQueueRef = useRef<string[]>([]);
  const streamInFlightRef = useRef(false);
  const streamLastTextRef = useRef('');
  const streamDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paramsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    soundInstanceRef.current = soundInstance;
  }, [soundInstance]);

  useEffect(() => {
    getCpuCoreCount().then(setCpuCoreCount);
  }, []);

  const ttsThreadOptions = useMemo(() => {
    const max = Math.max(1, cpuCoreCount);
    const options: Array<{
      id: 'saver' | 'standard' | 'balanced' | 'maximum';
      label: string;
      threads: number;
    }> = [{ id: 'saver', label: 'Saver (1 thread)', threads: 1 }];
    if (max >= 2) {
      options.push({
        id: 'standard',
        label: 'Standard (2 threads)',
        threads: 2,
      });
    }
    options.push({
      id: 'balanced',
      label: `Balanced (${Math.max(1, Math.floor(max / 2))} threads)`,
      threads: Math.max(1, Math.floor(max / 2)),
    });
    options.push({
      id: 'maximum',
      label: `Maximum (${Math.max(1, max - 1)} threads)`,
      threads: Math.max(1, max - 1),
    });
    return options;
  }, [cpuCoreCount]);

  const ttsNumThreads = useMemo(() => {
    const option = ttsThreadOptions.find((o) => o.id === ttsThreadOption);
    return option?.threads ?? (cpuCoreCount >= 2 ? 2 : 1);
  }, [ttsThreadOptions, ttsThreadOption, cpuCoreCount]);

  // Model-specific options: only show when the loaded model type supports them.
  // After init we use selectedModelType; options are hidden until a model is initialized.
  const effectiveModelTypeForOptions = selectedModelType;

  const showNoiseScale = useMemo(
    () =>
      effectiveModelTypeForOptions === 'vits' ||
      effectiveModelTypeForOptions === 'matcha',
    [effectiveModelTypeForOptions]
  );
  const showNoiseScaleW = useMemo(
    () => effectiveModelTypeForOptions === 'vits',
    [effectiveModelTypeForOptions]
  );
  const showLengthScale = useMemo(
    () =>
      effectiveModelTypeForOptions === 'vits' ||
      effectiveModelTypeForOptions === 'matcha' ||
      effectiveModelTypeForOptions === 'kokoro' ||
      effectiveModelTypeForOptions === 'kitten',
    [effectiveModelTypeForOptions]
  );

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    currentModelFolderRef.current = currentModelFolder;
  }, [currentModelFolder]);

  useEffect(() => {
    if (!currentModelFolder || streaming) {
      return;
    }

    if (paramsDebounceRef.current) {
      clearTimeout(paramsDebounceRef.current);
    }

    paramsDebounceRef.current = setTimeout(() => {
      const noiseValue = noiseScale.trim();
      const noiseWValue = noiseScaleW.trim();
      const lengthValue = lengthScale.trim();

      const nextNoise = noiseValue.length > 0 ? parseFloat(noiseValue) : null;
      if (
        noiseValue.length > 0 &&
        (isNaN(nextNoise as number) || (nextNoise as number) <= 0)
      ) {
        setError('Invalid noise scale value');
        return;
      }

      const nextNoiseW =
        noiseWValue.length > 0 ? parseFloat(noiseWValue) : null;
      if (
        noiseWValue.length > 0 &&
        (isNaN(nextNoiseW as number) || (nextNoiseW as number) <= 0)
      ) {
        setError('Invalid noise scale W value');
        return;
      }

      const nextLength =
        lengthValue.length > 0 ? parseFloat(lengthValue) : null;
      if (
        lengthValue.length > 0 &&
        (isNaN(nextLength as number) || (nextLength as number) <= 0)
      ) {
        setError('Invalid length scale value');
        return;
      }

      if (nextNoise === null && nextNoiseW === null && nextLength === null) {
        return;
      }

      updateTtsParams({
        noiseScale: nextNoise,
        noiseScaleW: nextNoiseW,
        lengthScale: nextLength,
      }).catch((err) => {
        const message =
          err instanceof Error ? err.message : 'Failed to update TTS params';
        setError(message);
      });
    }, 500);

    return () => {
      if (paramsDebounceRef.current) {
        clearTimeout(paramsDebounceRef.current);
        paramsDebounceRef.current = null;
      }
    };
  }, [currentModelFolder, lengthScale, noiseScale, noiseScaleW, streaming]);

  // Cleanup: Release TTS resources when leaving the screen
  useEffect(() => {
    return () => {
      if (currentModelFolderRef.current !== null) {
        console.log('TTSScreen: Cleaning up TTS resources');
        unloadTTS().catch((err) => {
          console.error('TTSScreen: Failed to unload TTS:', err);
        });
      }
      if (soundInstanceRef.current) {
        soundInstanceRef.current.release();
      }
      if (streamUnsubscribeRef.current) {
        streamUnsubscribeRef.current();
        streamUnsubscribeRef.current = null;
      }
      stopTtsPcmPlayer().catch((err) => {
        console.warn('Failed to stop PCM player:', err);
      });
    };
  }, []);

  const resetStreamingState = useCallback((clearBuffer = true) => {
    if (streamUnsubscribeRef.current) {
      streamUnsubscribeRef.current();
      streamUnsubscribeRef.current = null;
    }
    if (clearBuffer) {
      streamChunksRef.current = [];
      streamSampleRateRef.current = null;
      setStreamSampleCount(0);
    }
    streamQueueRef.current = [];
    streamInFlightRef.current = false;
    streamLastTextRef.current = '';
    streamPlaybackStartedRef.current = false;
    stopTtsPcmPlayer().catch((err) => {
      console.warn('Failed to stop PCM player:', err);
    });
    setStreamProgress(null);
    setStreaming(false);
  }, []);

  const buildStreamedAudio = () => {
    const chunks = streamChunksRef.current;
    if (chunks.length === 0) {
      return null;
    }
    const total = chunks.reduce((sum, part) => sum + part.length, 0);
    const combined = new Array<number>(total);
    let offset = 0;
    for (const part of chunks) {
      for (let i = 0; i < part.length; i += 1) {
        combined[offset + i] = part[i] as number;
      }
      offset += part.length;
    }
    const sampleRate =
      streamSampleRateRef.current ?? modelInfo?.sampleRate ?? 16000;
    return { samples: combined, sampleRate };
  };

  const getSynthesisOptions = useCallback((): TtsGenerationOptions => {
    const sid = parseInt(speakerId, 10);
    const speedValue = parseFloat(speed);

    if (isNaN(sid) || sid < 0) {
      throw new Error('Invalid speaker ID (must be ≥ 0)');
    }

    const numSpeakers = modelInfo?.numSpeakers ?? 0;
    if (numSpeakers > 0 && sid >= numSpeakers) {
      throw new Error(
        `Speaker ID must be between 0 and ${
          numSpeakers - 1
        } (model has ${numSpeakers} speaker${numSpeakers === 1 ? '' : 's'})`
      );
    }

    if (isNaN(speedValue) || speedValue <= 0) {
      throw new Error('Invalid speed value');
    }

    const options: TtsGenerationOptions = { sid, speed: speedValue };

    const silenceScaleVal = silenceScale.trim();
    if (silenceScaleVal.length > 0) {
      const v = parseFloat(silenceScaleVal);
      if (!isNaN(v) && v > 0) options.silenceScale = v;
    }

    const numStepsVal = numSteps.trim();
    if (numStepsVal.length > 0) {
      const v = parseInt(numStepsVal, 10);
      if (!isNaN(v) && v > 0) options.numSteps = v;
    }

    if (referenceText.trim().length > 0)
      options.referenceText = referenceText.trim();
    if (referenceAudio != null) options.referenceAudio = referenceAudio;

    if (extraOptions.trim().length > 0) {
      const extra: Record<string, string> = {};
      extraOptions
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((pair) => {
          const idx = pair.indexOf(':');
          if (idx > 0) {
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            if (k && v) extra[k] = v;
          }
        });
      if (Object.keys(extra).length > 0) options.extra = extra;
    }

    return options;
  }, [
    speakerId,
    speed,
    silenceScale,
    numSteps,
    referenceText,
    referenceAudio,
    extraOptions,
    modelInfo?.numSpeakers,
  ]);

  const processStreamQueue = useCallback(async () => {
    if (!streaming || streamInFlightRef.current) {
      return;
    }

    const nextText = streamQueueRef.current.shift();
    if (!nextText) {
      return;
    }

    let options: TtsGenerationOptions;
    try {
      options = getSynthesisOptions();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      resetStreamingState(false);
      return;
    }

    streamInFlightRef.current = true;

    try {
      const unsubscribe = await generateSpeechStream(nextText, options, {
        onChunk: (chunk) => {
          if (streamSampleRateRef.current === null) {
            streamSampleRateRef.current = chunk.sampleRate;
          }
          if (!streamPlaybackStartedRef.current) {
            streamPlaybackStartedRef.current = true;
            startTtsPcmPlayer(chunk.sampleRate, 1).catch((err) => {
              console.warn('Failed to start PCM player:', err);
            });
          }
          writeTtsPcmChunk(chunk.samples).catch((err) => {
            console.warn('Failed to write PCM chunk:', err);
          });
          streamChunksRef.current.push(chunk.samples);
          setStreamSampleCount((prev) => prev + chunk.samples.length);
          setStreamProgress(chunk.progress);
        },
        onEnd: () => {
          streamInFlightRef.current = false;
          if (streamUnsubscribeRef.current) {
            streamUnsubscribeRef.current();
            streamUnsubscribeRef.current = null;
          }
          setStreamProgress(null);
          processStreamQueue().catch((err) => {
            console.warn('Failed to process stream queue:', err);
          });
        },
        onError: ({ message }) => {
          setError(message);
          streamInFlightRef.current = false;
          if (streamUnsubscribeRef.current) {
            streamUnsubscribeRef.current();
            streamUnsubscribeRef.current = null;
          }
          resetStreamingState(false);
        },
      });

      streamUnsubscribeRef.current = unsubscribe;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      streamInFlightRef.current = false;
      resetStreamingState(false);
    }
  }, [getSynthesisOptions, resetStreamingState, streaming]);

  const enqueueStreamingText = useCallback(
    (text: string) => {
      if (!text.trim()) {
        return;
      }

      const lastText = streamLastTextRef.current;
      let delta = text;

      if (text.startsWith(lastText)) {
        delta = text.slice(lastText.length);
      }

      if (!delta.trim()) {
        streamLastTextRef.current = text;
        return;
      }

      streamLastTextRef.current = text;
      streamQueueRef.current.push(delta);
      processStreamQueue().catch((err) => {
        console.warn('Failed to process stream queue:', err);
      });
    },
    [processStreamQueue]
  );

  useEffect(() => {
    if (!streaming) {
      if (streamDebounceRef.current) {
        clearTimeout(streamDebounceRef.current);
        streamDebounceRef.current = null;
      }
      return;
    }

    if (streamDebounceRef.current) {
      clearTimeout(streamDebounceRef.current);
    }

    streamDebounceRef.current = setTimeout(() => {
      enqueueStreamingText(inputText);
    }, 400);

    return () => {
      if (streamDebounceRef.current) {
        clearTimeout(streamDebounceRef.current);
        streamDebounceRef.current = null;
      }
    };
  }, [enqueueStreamingText, inputText, streaming]);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const downloadedModels = await listDownloadedModelsByCategory(
        ModelCategory.Tts
      );
      const downloadedIds = downloadedModels
        .map((model) => model.id)
        .filter(Boolean);

      const assetModels = await listAssetModels();
      const ttsFolders = assetModels
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      console.log(
        '[TTSScreen PAD debug] listAssetModels: total=',
        assetModels.length,
        'tts=',
        ttsFolders.length,
        'folders=',
        ttsFolders
      );

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        console.log(
          '[TTSScreen PAD debug] getAssetPackPath("' +
            PAD_PACK_NAME +
            '") returned:',
          padPathFromNative ?? 'null'
        );
        const fallbackPath = `${RNFS.DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        console.log(
          '[TTSScreen PAD debug] using path for listModelsAtPath:',
          padPath,
          padPathFromNative
            ? '(PAD)'
            : '(fallback DocumentDirectoryPath/models)'
        );
        const padResults = await listModelsAtPath(padPath);
        console.log(
          '[TTSScreen PAD debug] listModelsAtPath raw result count:',
          padResults?.length ?? 0,
          'entries:',
          JSON.stringify(padResults ?? [])
        );
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'tts')
          .map((m) => m.folder);
        console.log(
          '[TTSScreen PAD debug] after filter hint===tts:',
          padFolders.length,
          'folders:',
          padFolders
        );
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
          console.log(
            'TTSScreen: Found PAD/filesystem TTS models:',
            padFolders,
            'at',
            padPath
          );
        }
      } catch (e) {
        console.warn('TTSScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);

      // Merge: downloaded, then PAD/filesystem, then bundled assets (no duplicates)
      const combined = [
        ...downloadedIds,
        ...padFolders.filter((f) => !downloadedIds.includes(f)),
        ...ttsFolders.filter(
          (f) => !downloadedIds.includes(f) && !padFolders.includes(f)
        ),
      ];

      if (downloadedIds.length > 0) {
        console.log('TTSScreen: Found downloaded models:', downloadedIds);
      }
      if (padFolders.length > 0) {
        console.log('TTSScreen: Found PAD/filesystem models:', padFolders);
      }
      if (ttsFolders.length > 0) {
        console.log('TTSScreen: Found asset models:', ttsFolders);
      }

      setDownloadedModelIds(downloadedIds);
      setAvailableModels(combined);

      if (combined.length === 0) {
        const hasRecommendedModels =
          (RECOMMENDED_MODEL_IDS[ModelCategory.Tts] || []).length > 0;

        if (hasRecommendedModels) {
          setError(
            'No TTS models found. Consider downloading one of the recommended models in the Model Management screen.'
          );
          console.log(
            'TTSScreen: No models available. Recommended models available for download.'
          );
        } else {
          setError('No TTS models found. See TTS_MODEL_SETUP.md');
        }
      }
    } catch (err) {
      console.error('TTSScreen: Failed to load models:', err);
      setError('Failed to load available models');
      setDownloadedModelIds([]);
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setInitializingModel(modelFolder);
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setModelInfo(null);
    setGeneratedAudio(null);
    setGeneratedSubtitles(null);
    setSubtitleEstimated(true);
    setSavedAudioPath(null);
    setSavedSubtitlePath(null);
    setCachedPlaybackPath(null);
    setCachedPlaybackSource(null);
    if (streaming) {
      await cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    try {
      // Unload previous model if any
      if (currentModelFolder) {
        await unloadTTS();
      }

      const useFilePath =
        downloadedModelIds.includes(modelFolder) ||
        padModelIds.includes(modelFolder);
      const modelPath = useFilePath
        ? padModelIds.includes(modelFolder) && padModelsPath
          ? getFileModelPath(modelFolder, undefined, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Tts)
        : getAssetModelPath(modelFolder);

      const noiseScaleValue = noiseScale.trim();
      const noiseScaleWValue = noiseScaleW.trim();
      const lengthScaleValue = lengthScale.trim();
      let noiseScaleNumber: number | undefined;
      let noiseScaleWNumber: number | undefined;
      let lengthScaleNumber: number | undefined;

      if (noiseScaleValue.length > 0) {
        const parsed = parseFloat(noiseScaleValue);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error('Invalid noise scale value');
        }
        noiseScaleNumber = parsed;
      }

      if (noiseScaleWValue.length > 0) {
        const parsed = parseFloat(noiseScaleWValue);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error('Invalid noise scale W value');
        }
        noiseScaleWNumber = parsed;
      }

      if (lengthScaleValue.length > 0) {
        const parsed = parseFloat(lengthScaleValue);
        if (isNaN(parsed) || parsed <= 0) {
          throw new Error('Invalid length scale value');
        }
        lengthScaleNumber = parsed;
      }

      // Initialize new model (defer to event loop to avoid blocking UI)
      let result: any;
      try {
        result = await new Promise((resolve, reject) => {
          setTimeout(async () => {
            try {
              const r = await initializeTTS({
                modelPath,
                numThreads: ttsNumThreads,
                debug: false,
                noiseScale: noiseScaleNumber,
                noiseScaleW: noiseScaleWNumber,
                lengthScale: lengthScaleNumber,
              });
              resolve(r);
            } catch (e) {
              reject(e);
            }
          }, 50);
        });
      } catch (initErr) {
        console.warn(
          'Initial initializeTTS failed, retrying with fewer threads',
          initErr
        );
        // Retry with reduced resource usage
        result = await initializeTTS({
          modelPath,
          numThreads: 1,
          debug: false,
          noiseScale: noiseScaleNumber,
          noiseScaleW: noiseScaleWNumber,
          lengthScale: lengthScaleNumber,
        });
      }

      if (result.success && result.detectedModels.length > 0) {
        const normalizedDetected = result.detectedModels.map(
          (model: { type: string; modelDir: string }) => ({
            ...model,
            type: model.type as TTSModelType,
          })
        );
        setDetectedModels(normalizedDetected);
        setCurrentModelFolder(modelFolder);

        const detectedTypes = normalizedDetected
          .map((m: { type: TTSModelType }) => m.type)
          .join(', ');
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected models: ${detectedTypes}`
        );

        // Auto-select first detected model
        if (normalizedDetected.length === 1 && normalizedDetected[0]) {
          setSelectedModelType(normalizedDetected[0].type);
        }

        // Try to get model info (sample rate, num speakers) for all models.
        // For some file-path models this may fail; we catch and leave modelInfo null.
        try {
          const info = await getModelInfo();
          if (
            info &&
            typeof info.sampleRate === 'number' &&
            typeof info.numSpeakers === 'number'
          ) {
            setModelInfo(info);
          } else {
            setModelInfo(null);
          }
        } catch (infoErr) {
          console.warn('getModelInfo not available for this model:', infoErr);
          setModelInfo(null);
        }
      } else {
        setError('No models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
      }

      setGeneratedAudio(null);
      setGeneratedSubtitles(null);
      setSubtitleEstimated(true);
    } catch (err) {
      console.error('TTS Initialization error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
        if (err.stack) {
          console.error('Stack trace:', err.stack);
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

      setError(errorMessage);
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`
      );
    } finally {
      setLoading(false);
      setInitializingModel(null);
    }
  };

  const handleGenerate = async () => {
    if (!currentModelFolder) {
      setError('Please initialize a model first');
      return;
    }

    if (!selectedModelType) {
      setError('Please select a model type first');
      return;
    }

    if (!inputText.trim()) {
      setError('Please enter text to synthesize');
      return;
    }

    setGenerating(true);
    setError(null);
    setGeneratedAudio(null);
    setGeneratedSubtitles(null);
    setSubtitleEstimated(true);
    setSavedAudioPath(null);
    setSavedSubtitlePath(null);
    setCachedPlaybackPath(null);
    setCachedPlaybackSource(null);
    if (streaming) {
      await cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    try {
      const options = getSynthesisOptions();
      const result = await generateSpeech(inputText, options);

      setGeneratedAudio(result);
      Alert.alert(
        'Success',
        `Generated ${result.samples.length} samples at ${result.sampleRate} Hz`
      );
    } catch (err) {
      console.error('TTS Generation error:', err);

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

      setError(errorMessage);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateWithTimestamps = async () => {
    if (!currentModelFolder) {
      setError('Please initialize a model first');
      return;
    }

    if (!selectedModelType) {
      setError('Please select a model type first');
      return;
    }

    if (!inputText.trim()) {
      setError('Please enter text to synthesize');
      return;
    }

    setGenerating(true);
    setError(null);
    setGeneratedAudio(null);
    setGeneratedSubtitles(null);
    setSubtitleEstimated(true);
    setSavedAudioPath(null);
    setSavedSubtitlePath(null);
    setCachedPlaybackPath(null);
    setCachedPlaybackSource(null);
    if (streaming) {
      await cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    try {
      const options = getSynthesisOptions();
      const result = await generateSpeechWithTimestamps(inputText, options);

      setGeneratedAudio({
        samples: result.samples,
        sampleRate: result.sampleRate,
      });
      setGeneratedSubtitles(result.subtitles);
      setSubtitleEstimated(result.estimated);
      Alert.alert(
        'Success',
        `Generated ${result.samples.length} samples at ${result.sampleRate} Hz`
      );
    } catch (err) {
      console.error('TTS Generation error:', err);

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

      setError(errorMessage);
    } finally {
      setGenerating(false);
    }
  };

  const handleStartStreaming = async () => {
    if (!currentModelFolder) {
      setError('Please initialize a model first');
      return;
    }

    if (!selectedModelType) {
      setError('Please select a model type first');
      return;
    }

    if (streaming) {
      return;
    }

    setError(null);
    setGeneratedAudio(null);
    setGeneratedSubtitles(null);
    setSubtitleEstimated(true);
    setSavedAudioPath(null);
    setSavedSubtitlePath(null);
    setCachedPlaybackPath(null);
    setCachedPlaybackSource(null);
    resetStreamingState(true);
    setStreaming(true);
    setStreamProgress(0);
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    try {
      streamLastTextRef.current = '';
      enqueueStreamingText(inputText);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      resetStreamingState(true);
    }
  };

  const handleCancelStreaming = async () => {
    if (!streaming) {
      return;
    }
    try {
      await cancelSpeechStream();
    } catch (err) {
      console.warn('Failed to cancel streaming:', err);
    } finally {
      const streamedAudio = buildStreamedAudio();
      if (streamedAudio) {
        setGeneratedAudio(streamedAudio);
      }
      resetStreamingState(false);
    }
  };

  const handlePickReferenceAudio = async () => {
    setError(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as any)?.fileUri ?? file?.name ?? '';
      const name = file?.name ?? uri?.split('/')?.pop() ?? 'reference.wav';
      if (!uri) {
        setError('Could not get file URI from picker');
        return;
      }
      let path = uri.replace(/^file:\/\//, '');
      if (uri.startsWith('content://')) {
        path = await copyContentUriToCache(uri, `tts_ref_${Date.now()}.wav`);
      }
      const { samples, sampleRate } = await readWavToFloatSamples(path);
      setReferenceAudio({ samples, sampleRate });
      setReferenceAudioFileName(name);
    } catch (err: any) {
      if ((DocumentPicker as any).isCancel?.(err)) return;
      console.warn('Pick reference audio failed', err);
      setError(err?.message ?? 'Failed to load reference WAV (use 16-bit PCM)');
    }
  };

  const pickSaveDirectory = async () => {
    let directoryPath: string | null = null;
    let directoryUri: string | null = null;

    try {
      const picked = await DocumentPicker.pickDirectory();
      if (picked?.uri) {
        if (picked.uri.startsWith('file://')) {
          directoryPath = decodeURI(picked.uri.replace('file://', ''));
        } else if (picked.uri.startsWith('content://')) {
          directoryUri = picked.uri;
        }
      }
    } catch (pickerErr) {
      const isCancel = (DocumentPicker as any).isCancel?.(pickerErr);
      if (!isCancel) {
        console.warn('Directory picker error:', pickerErr);
      }
    }

    return { directoryPath, directoryUri };
  };

  const getFallbackDirectory = () => {
    if (Platform.OS === 'android' && RNFS.DownloadDirectoryPath) {
      return RNFS.DownloadDirectoryPath;
    }
    return RNFS.DocumentDirectoryPath;
  };

  const showFallbackNotice = () => {
    Alert.alert(
      'Notice',
      'The selected storage location cannot be written to directly. The file will be saved in a default directory.'
    );
  };

  const saveAudioWithData = async (audio: {
    samples: number[];
    sampleRate: number;
  }) => {
    if (!audio.samples.length) {
      Alert.alert('Error', 'No audio to save.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const ext = outputFormat;
      const filename = `tts_${timestamp}.${ext}`;

      const { directoryPath, directoryUri } = await pickSaveDirectory();

      if (directoryUri) {
        if (ext !== 'wav') {
          Alert.alert(
            'Format not supported for content URI',
            'Saving non-WAV formats to a content URI is not supported. Saving WAV instead.'
          );
        }
        const savedUri = await saveAudioToContentUri(
          audio,
          directoryUri,
          `tts_${timestamp}.wav`
        );
        setSavedAudioPath(savedUri);
        setCachedPlaybackPath(null);
        setCachedPlaybackSource(null);

        Alert.alert('Success', `Audio saved to:\n${getDisplayPath(savedUri)}`, [
          {
            text: 'OK',
            onPress: () => console.log('Audio saved:', savedUri),
          },
        ]);
        return;
      }

      const targetDirectory = directoryPath ?? getFallbackDirectory();
      if (!directoryPath) {
        showFallbackNotice();
      }

      await RNFS.mkdir(targetDirectory);
      if (ext === 'wav') {
        const filePath = `${targetDirectory}/${filename}`;
        // Save audio to file (WAV)
        const savedPath = await saveAudioToFile(audio, filePath);
        setSavedAudioPath(savedPath);
        setCachedPlaybackPath(null);
        setCachedPlaybackSource(null);

        Alert.alert(
          'Success',
          `Audio saved to:\n${getDisplayPath(savedPath)}`,
          [
            {
              text: 'OK',
              onPress: () => console.log('Audio saved:', savedPath),
            },
          ]
        );
      } else {
        // Save as WAV first, then convert to requested format
        const tempWav = `${targetDirectory}/tts_${timestamp}.wav`;
        await saveAudioToFile(audio, tempWav);
        const targetPath = `${targetDirectory}/tts_${timestamp}.${ext}`;
        try {
          await convertAudioToFormat(tempWav, targetPath, ext);
          setSavedAudioPath(targetPath);
          setCachedPlaybackPath(null);
          setCachedPlaybackSource(null);
          // Remove temporary WAV
          try {
            await RNFS.unlink(tempWav);
          } catch {}
          Alert.alert(
            'Success',
            `Audio saved to:\n${getDisplayPath(targetPath)}`,
            [
              {
                text: 'OK',
                onPress: () => console.log('Audio saved:', targetPath),
              },
            ]
          );
        } catch (convErr) {
          // Conversion failed: fall back to WAV
          console.warn('Conversion failed, saved WAV at', tempWav, convErr);
          setSavedAudioPath(tempWav);
          setCachedPlaybackPath(null);
          setCachedPlaybackSource(null);
          Alert.alert(
            'Partial success',
            `Conversion failed; WAV saved to:\n${getDisplayPath(tempWav)}`
          );
        }
      }
    } catch (err) {
      console.error('Save audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save audio: ${errorMessage}`);
      Alert.alert('Error', `Failed to save audio: ${errorMessage}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAudio = async () => {
    if (!generatedAudio) {
      Alert.alert('Error', 'No audio to save. Generate speech first.');
      return;
    }
    await saveAudioWithData(generatedAudio);
  };

  // Temporary save helper used by quick-save UI
  const handleSaveTemporary = async () => {
    if (!generatedAudio) {
      Alert.alert('Error', 'No audio to save. Generate speech first.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const ext = outputFormat;
      const directoryPath = RNFS.DocumentDirectoryPath;
      await RNFS.mkdir(directoryPath);

      if (ext === 'wav') {
        const filename = `tts_${timestamp}.wav`;
        const filePath = `${directoryPath}/${filename}`;
        const savedPath = await saveAudioToFile(generatedAudio, filePath);
        setSavedAudioPath(savedPath);
        setCachedPlaybackPath(null);
        setCachedPlaybackSource(null);

        Alert.alert(
          'Success',
          `Audio saved to:\n${getDisplayPath(savedPath)}`,
          [
            {
              text: 'OK',
              onPress: () => console.log('Audio saved:', savedPath),
            },
          ]
        );
      } else {
        // Save WAV first then convert
        const tempWav = `${directoryPath}/tts_${timestamp}.wav`;
        await saveAudioToFile(generatedAudio, tempWav);
        const targetPath = `${directoryPath}/tts_${timestamp}.${ext}`;
        try {
          await convertAudioToFormat(tempWav, targetPath, ext);
          setSavedAudioPath(targetPath);
          setCachedPlaybackPath(null);
          setCachedPlaybackSource(null);
          try {
            await RNFS.unlink(tempWav);
          } catch {}
          Alert.alert(
            'Success',
            `Audio saved to:\n${getDisplayPath(targetPath)}`,
            [
              {
                text: 'OK',
                onPress: () => console.log('Audio saved:', targetPath),
              },
            ]
          );
        } catch (convErr) {
          console.warn('Conversion failed, WAV saved at', tempWav, convErr);
          setSavedAudioPath(tempWav);
          setCachedPlaybackPath(null);
          setCachedPlaybackSource(null);
          Alert.alert(
            'Partial success',
            `Conversion failed; WAV saved to:\n${getDisplayPath(tempWav)}`
          );
        }
      }
    } catch (err) {
      console.error('Save audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save audio: ${errorMessage}`);
      Alert.alert('Error', `Failed to save audio: ${errorMessage}`);
    } finally {
      setSaving(false);
    }
  };

  const formatSrtTimestamp = (seconds: number) => {
    const safeSeconds = Math.max(0, seconds);
    const totalMs = Math.round(safeSeconds * 1000);
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);

    const pad = (value: number, size = 2) => `${value}`.padStart(size, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  };

  const buildSrtContent = (
    subtitles: Array<{ text: string; start: number; end: number }>
  ) => {
    return subtitles
      .map((item, index) => {
        const start = formatSrtTimestamp(item.start);
        const end = formatSrtTimestamp(item.end);
        const text = item.text.trim() || '...';
        return `${index + 1}\n${start} --> ${end}\n${text}`;
      })
      .join('\n\n');
  };

  const handleShareSrt = async () => {
    if (!generatedSubtitles || generatedSubtitles.length === 0) {
      Alert.alert(
        'Error',
        'No subtitles available. Generate with timestamps first.'
      );
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const filename = `tts_${timestamp}.srt`;
      const directoryPath = RNFS.DocumentDirectoryPath;

      await RNFS.mkdir(directoryPath);
      const filePath = `${directoryPath}/${filename}`;

      const srtContent = buildSrtContent(generatedSubtitles);
      await RNFS.writeFile(filePath, srtContent, 'utf8');
      setSavedSubtitlePath(filePath);

      const shareUrl = getShareUrl(filePath);
      if (Platform.OS === 'android') {
        await shareAudioFile(shareUrl, 'application/x-subrip');
      } else {
        await Share.share({
          title: 'Share TTS Subtitles',
          message: 'TTS subtitles file',
          url: shareUrl,
        });
      }
    } catch (err) {
      console.error('Export SRT error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to export SRT: ${errorMessage}`);
      Alert.alert('Error', `Failed to export SRT: ${errorMessage}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSrtToFolder = async () => {
    if (!generatedSubtitles || generatedSubtitles.length === 0) {
      Alert.alert(
        'Error',
        'No subtitles available. Generate with timestamps first.'
      );
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const filename = `tts_${timestamp}.srt`;

      const { directoryPath, directoryUri } = await pickSaveDirectory();

      const srtContent = buildSrtContent(generatedSubtitles);

      if (directoryUri) {
        const savedUri = await saveTextToContentUri(
          srtContent,
          directoryUri,
          filename,
          'application/x-subrip'
        );
        setSavedSubtitlePath(savedUri);
        Alert.alert(
          'Success',
          `Subtitles saved to:\n${getDisplayPath(savedUri)}`
        );
        return;
      }

      const targetDirectory = directoryPath ?? getFallbackDirectory();
      if (!directoryPath) {
        showFallbackNotice();
      }

      await RNFS.mkdir(targetDirectory);
      const filePath = `${targetDirectory}/${filename}`;

      await RNFS.writeFile(filePath, srtContent, 'utf8');
      setSavedSubtitlePath(filePath);

      Alert.alert(
        'Success',
        `Subtitles saved to:\n${getDisplayPath(filePath)}`
      );
    } catch (err) {
      console.error('Save SRT error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save SRT: ${errorMessage}`);
      Alert.alert('Error', `Failed to save SRT: ${errorMessage}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePlayAudio = async () => {
    if (!savedAudioPath) {
      Alert.alert('Error', 'No audio file saved. Save audio first.');
      return;
    }

    try {
      if (soundInstance && isPlaying) {
        soundInstance.pause(() => setIsPlaying(false));
        return;
      }

      if (soundInstance && !isPlaying) {
        soundInstance.play((success) => {
          setIsPlaying(false);
          if (!success) {
            Alert.alert('Error', 'Playback failed');
          }
        });
        setIsPlaying(true);
        return;
      }

      setLoadingSound(true);
      Sound.setCategory('Playback');

      let playbackPath = savedAudioPath;
      if (savedAudioPath.startsWith('content://')) {
        const cacheName = `tts_playback_${Date.now()}.wav`;
        if (
          cachedPlaybackPath &&
          cachedPlaybackSource === savedAudioPath &&
          (await RNFS.exists(cachedPlaybackPath))
        ) {
          playbackPath = cachedPlaybackPath;
        } else {
          const cachedPath = await copyContentUriToCache(
            savedAudioPath,
            cacheName
          );
          setCachedPlaybackPath(cachedPath);
          setCachedPlaybackSource(savedAudioPath);
          playbackPath = cachedPath;
        }
      }

      const sound = new Sound(playbackPath, '', (loadError) => {
        setLoadingSound(false);
        if (loadError) {
          console.error('Failed to load sound:', loadError);
          Alert.alert('Error', 'Failed to load audio file');
          return;
        }

        setSoundInstance(sound);
        sound.play((success) => {
          setIsPlaying(false);
          if (!success) {
            Alert.alert('Error', 'Playback failed');
          }
          sound.release();
          setSoundInstance(null);
        });
        setIsPlaying(true);
      });
    } catch (err) {
      console.error('Play audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', `Failed to play audio: ${errorMessage}`);
    }
  };

  const handleStopAudio = async () => {
    try {
      if (soundInstance) {
        soundInstance.stop(() => {
          setIsPlaying(false);
        });
      }
    } catch (err) {
      console.error('Stop audio error:', err);
    }
  };

  const handleShareAudio = async () => {
    if (!savedAudioPath) {
      Alert.alert('Error', 'No audio file saved. Save audio first.');
      return;
    }

    try {
      const exists = await RNFS.exists(savedAudioPath);
      if (!exists && !savedAudioPath.startsWith('content://')) {
        Alert.alert('Error', 'Saved audio file not found.');
        return;
      }

      const shareUrl = getShareUrl(savedAudioPath);

      // Map selected output format to MIME type. Note: currently we save WAV files only.
      let mimeType = 'audio/wav';
      if (outputFormat === 'mp3') mimeType = 'audio/mpeg';
      if (outputFormat === 'flac') mimeType = 'audio/flac';

      if (Platform.OS === 'android') {
        await shareAudioFile(shareUrl, mimeType);
        return;
      }

      await Share.share({
        title: 'Share TTS Audio',
        message: 'TTS audio file',
        url: shareUrl,
      });
    } catch (err) {
      console.error('Share audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', `Failed to share audio: ${errorMessage}`);
    }
  };

  const handleCleanup = async () => {
    try {
      if (streaming) {
        await cancelSpeechStream();
        resetStreamingState(true);
      }
      if (soundInstance) {
        soundInstance.release();
        setSoundInstance(null);
        setIsPlaying(false);
      }
      await unloadTTS();
      setCurrentModelFolder(null);
      setInitResult(null);
      setDetectedModels([]);
      setSelectedModelType(null);
      setModelInfo(null);
      setGeneratedAudio(null);
      setGeneratedSubtitles(null);
      setSubtitleEstimated(true);
      setSavedAudioPath(null);
      setSavedSubtitlePath(null);
      setError(null);
      Alert.alert('Success', 'TTS resources released');
    } catch (err) {
      console.error('Cleanup error:', err);
      Alert.alert('Error', 'Failed to release TTS resources');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="volume-high" size={48} style={styles.icon} />
            <Text style={styles.title}>Text-to-Speech Demo</Text>
            <Text style={styles.subtitle}>
              Generate speech from text using offline TTS models
            </Text>
          </View>

          {/* Section 1: Initialize Model */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize TTS Model</Text>
            <Text style={styles.sectionDescription}>
              Select a TTS model to load:
            </Text>
            <Text style={styles.inputLabel}>Threads</Text>
            <TouchableOpacity
              style={styles.dropdownTrigger}
              onPress={() => setShowThreadPicker(true)}
            >
              <View style={styles.dropdownTriggerLeft}>
                <Ionicons
                  name="hardware-chip-outline"
                  size={22}
                  color="#8E8E93"
                  style={styles.iconInline}
                />
                <Text style={styles.dropdownTriggerText}>
                  {ttsThreadOptions.find((o) => o.id === ttsThreadOption)
                    ?.label ?? 'Standard (2 threads)'}
                </Text>
              </View>
              <Ionicons name="chevron-down" size={20} color="#8E8E93" />
            </TouchableOpacity>
            <Modal
              visible={showThreadPicker}
              transparent
              animationType="fade"
              onRequestClose={() => setShowThreadPicker(false)}
            >
              <Pressable
                style={styles.dropdownBackdrop}
                onPress={() => setShowThreadPicker(false)}
              >
                <View style={styles.dropdownMenu}>
                  {ttsThreadOptions.map((opt) => (
                    <TouchableOpacity
                      key={opt.id}
                      style={[
                        styles.dropdownItem,
                        ttsThreadOption === opt.id && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setTtsThreadOption(opt.id);
                        setShowThreadPicker(false);
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          ttsThreadOption === opt.id &&
                            styles.dropdownItemTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                      {ttsThreadOption === opt.id && (
                        <Ionicons name="checkmark" size={20} color="#007AFF" />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </Pressable>
            </Modal>
            <View style={styles.separator} />
            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color="#007AFF" />
                <Text style={styles.loadingText}>Loading models...</Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.resultContainer}>
                <Text style={styles.errorText}>
                  No TTS models found. See TTS_MODEL_SETUP.md
                </Text>
              </View>
            ) : (
              <View style={styles.buttonGroup}>
                {availableModels.map((modelFolder) => {
                  const isInitializingOther =
                    initializingModel !== null &&
                    initializingModel !== modelFolder;
                  const isDisabled =
                    isInitializingOther ||
                    (loading && initializingModel !== modelFolder);
                  return (
                    <TouchableOpacity
                      key={modelFolder}
                      style={[
                        styles.modelButton,
                        currentModelFolder === modelFolder &&
                          styles.modelButtonActive,
                        isDisabled && styles.modelButtonDisabled,
                      ]}
                      onPress={() => {
                        if (isDisabled) return;
                        handleInitialize(modelFolder);
                      }}
                      disabled={isDisabled}
                    >
                      <Text
                        style={[
                          styles.modelButtonText,
                          currentModelFolder === modelFolder &&
                            styles.modelButtonTextActive,
                          isDisabled && styles.modelButtonTextDisabled,
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
                      <Text style={styles.modelButtonSubtext}>
                        {modelFolder}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {loading && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>Initializing model...</Text>
              </View>
            )}

            {initResult && (
              <View style={styles.resultContainer}>
                <Text style={styles.resultText}>{initResult}</Text>
              </View>
            )}
          </View>

          {/* Section 2: Select Model Type */}
          {detectedModels.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Select Model Type</Text>
              {detectedModels.length > 1 ? (
                <>
                  <Text style={styles.sectionDescription}>
                    Multiple model types detected. Select one:
                  </Text>
                  <View style={styles.detectedModelsContainer}>
                    {detectedModels.map((model) => (
                      <TouchableOpacity
                        key={model.type}
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
                          {model.type}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : (
                <View style={styles.rowAlignCenter}>
                  <Ionicons
                    name="checkmark-circle"
                    size={16}
                    color="#34C759"
                    style={styles.iconInline}
                  />
                  <Text style={styles.autoSelectedText}>
                    Auto-selected: {selectedModelType}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Section 3: Model Info */}
          {modelInfo && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Model Information</Text>
              <View style={styles.infoContainer}>
                <Text style={styles.infoText}>
                  Sample Rate: {modelInfo?.sampleRate ?? 0} Hz
                </Text>
                <Text style={styles.infoText}>
                  Speakers: {modelInfo?.numSpeakers ?? 0}
                </Text>
              </View>
            </View>
          )}

          {/* Section 4: Generate Speech */}
          {selectedModelType && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>3. Generate Speech</Text>

              <Text style={styles.inputLabel}>Text to Synthesize:</Text>
              <TextInput
                style={styles.textInput}
                value={inputText}
                onChangeText={setInputText}
                placeholder="Enter text to synthesize..."
                multiline
                numberOfLines={3}
              />

              <View style={styles.voiceCloningSection}>
                <TouchableOpacity
                  style={styles.voiceCloningHeader}
                  onPress={() => setOptionsExpanded((prev) => !prev)}
                  activeOpacity={0.7}
                >
                  <View style={styles.voiceCloningHeaderLeft}>
                    <Ionicons
                      name="options-outline"
                      size={22}
                      color="#8E8E93"
                      style={styles.iconInline}
                    />
                    <Text style={styles.voiceCloningHeaderTitle}>Options</Text>
                  </View>
                  <Ionicons
                    name={optionsExpanded ? 'chevron-up' : 'chevron-down'}
                    size={24}
                    color="#8E8E93"
                  />
                </TouchableOpacity>
                {optionsExpanded && (
                  <View style={styles.voiceCloningContent}>
                    <Text style={styles.inputLabel}>
                      Output format (for save)
                    </Text>
                    <TouchableOpacity
                      style={styles.dropdownTrigger}
                      onPress={() => setShowOutputFormatPicker(true)}
                    >
                      <Text style={styles.dropdownTriggerText}>
                        {outputFormat.toUpperCase()}
                      </Text>
                      <Ionicons name="chevron-down" size={20} color="#8E8E93" />
                    </TouchableOpacity>
                    <Modal
                      visible={showOutputFormatPicker}
                      transparent
                      animationType="fade"
                      onRequestClose={() => setShowOutputFormatPicker(false)}
                    >
                      <Pressable
                        style={styles.dropdownBackdrop}
                        onPress={() => setShowOutputFormatPicker(false)}
                      >
                        <View style={styles.dropdownMenu}>
                          {(['wav', 'mp3', 'flac'] as const).map((fmt) => (
                            <TouchableOpacity
                              key={fmt}
                              style={[
                                styles.dropdownItem,
                                outputFormat === fmt &&
                                  styles.dropdownItemActive,
                              ]}
                              onPress={() => {
                                setOutputFormat(fmt);
                                setShowOutputFormatPicker(false);
                              }}
                            >
                              <Text
                                style={[
                                  styles.dropdownItemText,
                                  outputFormat === fmt &&
                                    styles.dropdownItemTextActive,
                                ]}
                              >
                                {fmt.toUpperCase()}
                              </Text>
                              {outputFormat === fmt && (
                                <Ionicons
                                  name="checkmark"
                                  size={20}
                                  color="#007AFF"
                                />
                              )}
                            </TouchableOpacity>
                          ))}
                        </View>
                      </Pressable>
                    </Modal>

                    {/* Model-specific init params: only shown for types that support them */}
                    {(showNoiseScale || showNoiseScaleW) && (
                      <View style={styles.parameterRow}>
                        {showNoiseScale && (
                          <View style={styles.parameterColumn}>
                            <Text style={styles.inputLabel}>
                              Noise scale (optional):
                            </Text>
                            <TextInput
                              style={styles.parameterInput}
                              value={noiseScale}
                              onChangeText={setNoiseScale}
                              keyboardType="decimal-pad"
                              placeholder="0.667"
                              placeholderTextColor="#8E8E93"
                            />
                          </View>
                        )}
                        {showNoiseScaleW && (
                          <View style={styles.parameterColumn}>
                            <Text style={styles.inputLabel}>
                              Noise scale W (optional):
                            </Text>
                            <TextInput
                              style={styles.parameterInput}
                              value={noiseScaleW}
                              onChangeText={setNoiseScaleW}
                              keyboardType="decimal-pad"
                              placeholder="0.8"
                              placeholderTextColor="#8E8E93"
                            />
                          </View>
                        )}
                      </View>
                    )}

                    {showLengthScale && (
                      <View style={styles.parameterRow}>
                        <View style={styles.parameterColumn}>
                          <Text style={styles.inputLabel}>
                            Length scale (optional):
                          </Text>
                          <TextInput
                            style={styles.parameterInput}
                            value={lengthScale}
                            onChangeText={setLengthScale}
                            keyboardType="decimal-pad"
                            placeholder="1.0"
                            placeholderTextColor="#8E8E93"
                          />
                        </View>
                        <View style={styles.parameterColumn} />
                      </View>
                    )}

                    {modelInfo != null && (
                      <Text style={styles.speakerCountHint}>
                        Model has {modelInfo.numSpeakers} speaker
                        {modelInfo.numSpeakers === 1 ? '' : 's'} (use ID 0
                        {modelInfo.numSpeakers > 1
                          ? `–${modelInfo.numSpeakers - 1}`
                          : ''}
                        )
                      </Text>
                    )}
                    <View style={styles.parameterRow}>
                      <View style={styles.parameterColumn}>
                        <Text style={styles.inputLabel}>
                          Speaker ID
                          {modelInfo?.numSpeakers != null &&
                          modelInfo.numSpeakers > 0
                            ? ` (0–${modelInfo.numSpeakers - 1})`
                            : ' (0 … ?)'}
                          :
                        </Text>
                        <TextInput
                          style={styles.parameterInput}
                          value={speakerId}
                          onChangeText={setSpeakerId}
                          keyboardType="numeric"
                          placeholder="0"
                          placeholderTextColor="#8E8E93"
                        />
                      </View>
                      <View style={styles.parameterColumn}>
                        <Text style={styles.inputLabel}>Speed:</Text>
                        <TextInput
                          style={styles.parameterInput}
                          value={speed}
                          onChangeText={setSpeed}
                          keyboardType="decimal-pad"
                          placeholder="1.0"
                          placeholderTextColor="#8E8E93"
                        />
                      </View>
                    </View>

                    <View style={styles.parameterRow}>
                      <View style={styles.parameterColumn}>
                        <Text style={styles.inputLabel}>
                          Silence scale (optional):
                        </Text>
                        <TextInput
                          style={styles.parameterInput}
                          value={silenceScale}
                          onChangeText={setSilenceScale}
                          keyboardType="decimal-pad"
                          placeholder="—"
                          placeholderTextColor="#8E8E93"
                        />
                      </View>
                      <View style={styles.parameterColumn}>
                        <Text style={styles.inputLabel}>
                          Num steps (optional):
                        </Text>
                        <TextInput
                          style={styles.parameterInput}
                          value={numSteps}
                          onChangeText={setNumSteps}
                          keyboardType="numeric"
                          placeholder="—"
                          placeholderTextColor="#8E8E93"
                        />
                      </View>
                    </View>

                    <View style={styles.voiceCloningSection}>
                      <TouchableOpacity
                        style={styles.voiceCloningHeader}
                        onPress={() => setVoiceCloningExpanded((prev) => !prev)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.voiceCloningHeaderLeft}>
                          <Ionicons
                            name="person-circle-outline"
                            size={22}
                            color="#8E8E93"
                            style={styles.iconInline}
                          />
                          <Text style={styles.voiceCloningHeaderTitle}>
                            Voice cloning (optional)
                          </Text>
                          {(referenceAudio != null ||
                            referenceText.trim() !== '') && (
                            <View style={styles.voiceCloningBadge}>
                              <Text style={styles.voiceCloningBadgeText}>
                                {referenceAudio != null ? '1 file' : 'text'}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Ionicons
                          name={
                            voiceCloningExpanded ? 'chevron-up' : 'chevron-down'
                          }
                          size={24}
                          color="#8E8E93"
                        />
                      </TouchableOpacity>
                      {voiceCloningExpanded && (
                        <View style={styles.voiceCloningContent}>
                          <Text style={styles.inputLabel}>
                            Reference text (transcript of reference audio):
                          </Text>
                          <TextInput
                            style={[
                              styles.parameterInput,
                              styles.referenceTextInput,
                            ]}
                            value={referenceText}
                            onChangeText={setReferenceText}
                            placeholder="Transcript of reference audio…"
                            placeholderTextColor="#8E8E93"
                          />
                          <Text style={styles.inputLabel}>
                            Reference audio (WAV):
                          </Text>
                          {referenceAudio == null ? (
                            <TouchableOpacity
                              style={styles.pickRefButtonPrimary}
                              onPress={handlePickReferenceAudio}
                            >
                              <Ionicons
                                name="add-circle-outline"
                                size={20}
                                color="#FFFFFF"
                                style={styles.iconInline}
                              />
                              <Text style={styles.pickRefButtonPrimaryText}>
                                Tap to select WAV file
                              </Text>
                            </TouchableOpacity>
                          ) : (
                            <View style={styles.referenceAudioSelectedRow}>
                              <View style={styles.referenceAudioSelectedInfo}>
                                <Ionicons
                                  name="musical-notes"
                                  size={18}
                                  color="#34C759"
                                  style={styles.iconInline}
                                />
                                <Text
                                  style={styles.referenceAudioFileName}
                                  numberOfLines={1}
                                >
                                  {referenceAudioFileName}
                                </Text>
                              </View>
                              <View style={styles.referenceAudioActions}>
                                <TouchableOpacity
                                  style={styles.changeRefButton}
                                  onPress={handlePickReferenceAudio}
                                >
                                  <Text style={styles.changeRefButtonText}>
                                    Change
                                  </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  style={styles.clearRefButton}
                                  onPress={() => {
                                    setReferenceAudio(null);
                                    setReferenceAudioFileName(null);
                                  }}
                                >
                                  <Text style={styles.clearRefButtonText}>
                                    Clear
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          )}
                        </View>
                      )}
                    </View>

                    <Text style={styles.inputLabel}>
                      Extra options (optional, key:value, …):
                    </Text>
                    <TextInput
                      style={styles.parameterInput}
                      value={extraOptions}
                      onChangeText={setExtraOptions}
                      placeholder="e.g. temperature:0.7, chunk_size:15"
                      placeholderTextColor="#8E8E93"
                    />
                  </View>
                )}
              </View>

              <View style={styles.generateActionsSpacer} />
              <TouchableOpacity
                style={[
                  styles.generateButton,
                  generating && styles.buttonDisabled,
                ]}
                onPress={handleGenerate}
                disabled={generating}
              >
                {generating ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.generateButtonText}>Generate Speech</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.generateButtonSecondary,
                  generating && styles.buttonDisabled,
                ]}
                onPress={handleGenerateWithTimestamps}
                disabled={generating}
              >
                {generating ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.generateButtonText}>
                    Generate + Timestamps
                  </Text>
                )}
              </TouchableOpacity>

              <View style={styles.streamControls}>
                <TouchableOpacity
                  style={[
                    styles.streamButton,
                    streaming && styles.buttonDisabled,
                  ]}
                  onPress={handleStartStreaming}
                  disabled={streaming}
                >
                  <Text style={styles.generateButtonText}>Start Streaming</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.cancelStreamButton,
                    !streaming && styles.buttonDisabled,
                  ]}
                  onPress={handleCancelStreaming}
                  disabled={!streaming}
                >
                  <Text style={styles.generateButtonText}>Cancel</Text>
                </TouchableOpacity>
              </View>

              {streaming && (
                <Text style={styles.streamInfoText}>
                  Streaming... {Math.round((streamProgress ?? 0) * 100)}% (
                  {streamSampleCount} samples)
                </Text>
              )}
            </View>
          )}

          {/* Section 5: Results */}
          {generatedAudio && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Generated Audio</Text>
              <View style={styles.resultContainer}>
                <Text style={styles.resultText}>
                  Samples: {generatedAudio.samples.length.toLocaleString()}
                </Text>
                <Text style={styles.resultText}>
                  Sample Rate: {generatedAudio.sampleRate} Hz
                </Text>
                <Text style={styles.resultText}>
                  Duration:{' '}
                  {(
                    generatedAudio.samples.length / generatedAudio.sampleRate
                  ).toFixed(2)}{' '}
                  seconds
                </Text>
              </View>

              {/* Audio Controls */}
              <View style={styles.audioControls}>
                <TouchableOpacity
                  style={[
                    styles.audioButton,
                    styles.saveButton,
                    saving && styles.buttonDisabled,
                  ]}
                  onPress={handleSaveTemporary}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <View style={styles.rowAlignCenter}>
                      <Ionicons
                        name="save-outline"
                        size={16}
                        color="#fff"
                        style={styles.iconInline}
                      />
                      <Text style={styles.audioButtonText}>Save temporary</Text>
                    </View>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.audioButton,
                    styles.saveButton,
                    saving && styles.buttonDisabled,
                  ]}
                  onPress={handleSaveAudio}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <View style={styles.rowAlignCenter}>
                      <Ionicons
                        name="folder-outline"
                        size={16}
                        color="#fff"
                        style={styles.iconInline}
                      />
                      <Text style={styles.audioButtonText}>Save to Folder</Text>
                    </View>
                  )}
                </TouchableOpacity>

                {savedAudioPath && (
                  <>
                    <TouchableOpacity
                      style={[styles.audioButton, styles.playButton]}
                      onPress={handlePlayAudio}
                      disabled={loadingSound}
                    >
                      {loadingSound ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <View style={styles.rowAlignCenter}>
                          <Ionicons
                            name={isPlaying ? 'pause' : 'play'}
                            size={16}
                            color="#fff"
                            style={styles.iconInline}
                          />
                          <Text style={styles.audioButtonText}>
                            {isPlaying ? 'Pause' : 'Play'}
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.audioButton, styles.stopButton]}
                      onPress={handleStopAudio}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name="stop"
                          size={16}
                          color="#fff"
                          style={styles.iconInline}
                        />
                        <Text style={styles.audioButtonText}>Stop</Text>
                      </View>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.audioButton, styles.shareButton]}
                      onPress={handleShareAudio}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name="share-social"
                          size={16}
                          color="#fff"
                          style={styles.iconInline}
                        />
                        <Text style={styles.audioButtonText}>Share</Text>
                      </View>
                    </TouchableOpacity>
                  </>
                )}
              </View>

              {savedAudioPath && (
                <Text style={styles.savedPathText}>
                  Saved: {getDisplayPath(savedAudioPath).split('/').pop()}
                  {'\n'}
                  {getDisplayPath(savedAudioPath)}
                </Text>
              )}
            </View>
          )}

          {generatedSubtitles && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Subtitles / Timestamps</Text>
              <Text style={styles.sectionDescription}>
                {subtitleEstimated
                  ? 'Estimated word timings based on output duration.'
                  : 'Model-provided timings.'}
              </Text>
              <View style={styles.resultContainer}>
                {generatedSubtitles.map((item, index) => (
                  <Text key={`${item.text}-${index}`} style={styles.resultText}>
                    {item.text} {item.start.toFixed(2)}s - {item.end.toFixed(2)}
                    s
                  </Text>
                ))}
              </View>
              <View style={styles.subtitleActions}>
                <TouchableOpacity
                  style={[styles.audioButton, styles.exportButton]}
                  onPress={handleShareSrt}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.audioButtonText}>Share SRT</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.audioButton, styles.saveSubtitleButton]}
                  onPress={handleSaveSrtToFolder}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.audioButtonText}>Save SRT</Text>
                  )}
                </TouchableOpacity>
              </View>
              {savedSubtitlePath && (
                <Text style={styles.savedPathText}>
                  Subtitles:{' '}
                  {getDisplayPath(savedSubtitlePath).split('/').pop()}
                  {'\n'}
                  {getDisplayPath(savedSubtitlePath)}
                </Text>
              )}
            </View>
          )}

          {/* Error Display */}
          {error && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Cleanup Button */}
          {currentModelFolder && (
            <TouchableOpacity
              style={styles.cleanupButton}
              onPress={handleCleanup}
            >
              <Text style={styles.cleanupButtonText}>Release Resources</Text>
            </TouchableOpacity>
          )}

          {/* Footer */}
          <View style={styles.footer}>
            <View style={styles.rowAlignCenter}>
              <Ionicons name="bulb" size={16} style={styles.iconInline} />
              <Text style={styles.footerText}>
                Tip: Models must be placed in assets/models/ directory
              </Text>
            </View>
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  body: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  icon: {
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  labelText: {
    fontSize: 14,
    color: '#8E8E93',
    marginRight: 8,
  },
  buttonGroup: {
    gap: 12,
  },
  modelButton: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  modelButtonActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  modelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  modelButtonTextActive: {
    color: '#007AFF',
  },
  modelButtonDisabled: {
    opacity: 0.5,
  },
  modelButtonTextDisabled: {
    color: '#C7C7CC',
  },
  modelButtonSubtext: {
    fontSize: 12,
    color: '#8E8E93',
  },
  loadingContainer: {
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#8E8E93',
  },
  resultContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  resultText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 4,
  },
  detectedModelsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  detectedModelButton: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  detectedModelButtonActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  detectedModelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000000',
  },
  detectedModelButtonTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  autoSelectedText: {
    fontSize: 14,
    color: '#34C759',
    fontWeight: '500',
  },
  infoContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
  },
  infoText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 4,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000000',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#000000',
    marginBottom: 16,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  parameterRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  parameterColumn: {
    flex: 1,
  },
  parameterInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#000000',
  },
  referenceTextInput: {
    minHeight: 48,
    marginBottom: 12,
  },
  optionsBlock: {
    marginBottom: 8,
  },
  subsectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 12,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  dropdownTriggerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  dropdownTriggerText: {
    fontSize: 16,
    color: '#000000',
    fontWeight: '500',
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdownMenu: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    minWidth: 200,
    paddingVertical: 8,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  dropdownItemActive: {
    backgroundColor: '#E3F2FD',
  },
  dropdownItemText: {
    fontSize: 16,
    color: '#000000',
  },
  dropdownItemTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  voiceCloningSection: {
    marginTop: 8,
    marginBottom: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    overflow: 'hidden',
  },
  voiceCloningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#F2F2F7',
  },
  voiceCloningHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  voiceCloningHeaderTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginLeft: 4,
  },
  voiceCloningBadge: {
    marginLeft: 10,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: '#E3F2FD',
  },
  voiceCloningBadgeText: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '500',
  },
  voiceCloningContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E5EA',
  },
  referenceAudioRow: {
    marginBottom: 16,
  },
  referenceAudioButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  pickRefButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#E3F2FD',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  pickRefButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  pickRefButtonPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 16,
  },
  pickRefButtonPrimaryText: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  referenceAudioSelectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
    gap: 12,
  },
  referenceAudioSelectedInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  referenceAudioFileName: {
    fontSize: 14,
    color: '#1B5E20',
    fontWeight: '500',
    flex: 1,
  },
  referenceAudioActions: {
    flexDirection: 'row',
    gap: 8,
  },
  changeRefButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#E3F2FD',
  },
  changeRefButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  clearRefButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#FFEBEE',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  clearRefButtonText: {
    fontSize: 14,
    color: '#FF3B30',
    fontWeight: '500',
  },
  generateActionsSpacer: {
    height: 24,
  },
  generateButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  generateButtonSecondary: {
    backgroundColor: '#5856D6',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  generateButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  streamControls: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  streamButton: {
    flex: 1,
    backgroundColor: '#34C759',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  cancelStreamButton: {
    flex: 1,
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  streamInfoText: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 8,
    fontStyle: 'italic',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  audioControls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  subtitleActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  audioButton: {
    flexBasis: '30%',
    maxWidth: '32%',
    flexGrow: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    backgroundColor: '#34C759',
  },
  playButton: {
    backgroundColor: '#007AFF',
  },
  stopButton: {
    backgroundColor: '#FF9500',
  },
  shareButton: {
    backgroundColor: '#5856D6',
  },
  exportButton: {
    backgroundColor: '#6E56CF',
  },
  saveSubtitleButton: {
    backgroundColor: '#34C759',
  },
  audioButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  savedPathText: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 8,
    fontStyle: 'italic',
  },
  noteText: {
    fontSize: 12,
    color: '#8E8E93',
    fontStyle: 'italic',
    marginTop: 8,
  },
  hint: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 4,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  speakerCountHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 12,
  },
  iconInline: {
    marginRight: 12,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAlignCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modelHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    gap: 8,
  },
  modelHintGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 12,
  },
  modelHintText: {
    fontSize: 11,
    color: '#666',
    marginTop: 0,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  outputFormatContainer: {
    marginTop: 8,
    marginBottom: 8,
  },
  outputFormatRow: {
    flexDirection: 'row',
  },
  outputFormatButtonSpacing: {
    marginLeft: 8,
  },
  separator: {
    height: 1,
    backgroundColor: '#E5E5EA',
    marginTop: 8,
    marginBottom: 12,
    borderRadius: 1,
  },
  errorContainer: {
    backgroundColor: '#FFE5E5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 14,
    color: '#D32F2F',
  },
  cleanupButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  cleanupButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  footer: {
    alignItems: 'center',
    padding: 16,
  },
  footerText: {
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
  },
});
