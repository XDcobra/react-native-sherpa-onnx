import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Alert,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createTTS,
  detectTtsModel,
  saveAudioToFile,
  saveAudioToContentUri,
  saveTextToContentUri,
  copyContentUriToCache,
  shareAudioFile,
  type TTSModelType,
  type TtsGenerationOptions,
} from 'react-native-sherpa-onnx/tts';
import type { TtsEngine } from 'react-native-sherpa-onnx/tts';
import { getTtsCache, setTtsCache, clearTtsCache } from '../../engineCache';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
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
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';
import {
  DocumentDirectoryPath,
  DownloadDirectoryPath,
  mkdir,
  unlink,
  writeFile,
  exists,
} from '@dr.pogodin/react-native-fs';
import Sound from 'react-native-sound';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { styles } from './TTSScreen.styles';

const PAD_PACK_NAME = 'sherpa_models';

export default function TTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
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

  const TTS_NUM_THREADS = 2;

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
  const ttsEngineRef = useRef<TtsEngine | null>(null);
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
  useEffect(() => {
    soundInstanceRef.current = soundInstance;
  }, [soundInstance]);

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    currentModelFolderRef.current = currentModelFolder;
  }, [currentModelFolder]);

  // Restore persisted TTS instance when entering the screen (do not release on unmount)
  useEffect(() => {
    const cached = getTtsCache();
    if (cached.engine != null && cached.modelFolder != null) {
      ttsEngineRef.current = cached.engine;
      setCurrentModelFolder(cached.modelFolder);
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setModelInfo(cached.modelInfo);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          cached.modelFolder
        )}\nDetected models: ${cached.detectedModels
          .map((m) => m.type)
          .join(', ')}`
      );
    }
  }, []);

  // On unmount: release sound and stream only; do NOT destroy the TTS engine (it stays in cache)
  useEffect(() => {
    return () => {
      if (soundInstanceRef.current) {
        soundInstanceRef.current.release();
      }
      if (streamUnsubscribeRef.current) {
        streamUnsubscribeRef.current();
        streamUnsubscribeRef.current = null;
      }
      const engine = ttsEngineRef.current;
      if (engine) {
        engine.stopPcmPlayer().catch((err) => {
          console.warn('Failed to stop PCM player:', err);
        });
      }
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
    const engine = ttsEngineRef.current;
    if (engine) {
      engine.stopPcmPlayer().catch((err) => {
        console.warn('Failed to stop PCM player:', err);
      });
    }
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
    return { sid: 0, speed: 1.0 };
  }, []);

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

    const engine = ttsEngineRef.current;
    if (!engine) {
      streamInFlightRef.current = false;
      return;
    }

    streamInFlightRef.current = true;

    try {
      const unsubscribe = await engine.generateSpeechStream(nextText, options, {
        onChunk: (chunk) => {
          if (streamSampleRateRef.current === null) {
            streamSampleRateRef.current = chunk.sampleRate;
          }
          if (!streamPlaybackStartedRef.current) {
            streamPlaybackStartedRef.current = true;
            engine.startPcmPlayer(chunk.sampleRate, 1).catch((err) => {
              console.warn('Failed to start PCM player:', err);
            });
          }
          engine.writePcmChunk(chunk.samples).catch((err) => {
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
      const assetModels = await listAssetModels();
      const ttsFolders = assetModels
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'tts')
          .map((m) => m.folder);
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

      // Merge: PAD folders, then bundled asset folders (no duplicates)
      const combined = [
        ...padFolders,
        ...ttsFolders.filter((f) => !padFolders.includes(f)),
      ];

      if (ttsFolders.length > 0) {
        console.log('TTSScreen: Found asset models:', ttsFolders);
      }
      setAvailableModels(combined);

      if (combined.length === 0) {
        setError(
          'No TTS models found. Use bundled assets or PAD models. See TTS_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('TTSScreen: Failed to load models:', err);
      setError('Failed to load available models');
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
      const eng = ttsEngineRef.current;
      if (eng) await eng.cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    try {
      const previous = ttsEngineRef.current;
      if (previous) {
        await previous.destroy();
        ttsEngineRef.current = null;
        clearTtsCache();
      }

      const useFilePath = padModelIds.includes(modelFolder);
      const modelPath = useFilePath
        ? padModelIds.includes(modelFolder) && padModelsPath
          ? getFileModelPath(modelFolder, undefined, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Tts)
        : getAssetModelPath(modelFolder);

      let engine: TtsEngine;
      try {
        engine = await new Promise((resolve, reject) => {
          setTimeout(() => {
            createTTS({
              modelPath,
              numThreads: TTS_NUM_THREADS,
              debug: false,
            })
              .then(resolve)
              .catch(reject);
          }, 50);
        });
      } catch (initErr) {
        console.warn(
          'Initial createTTS failed, retrying with fewer threads',
          initErr
        );
        engine = await createTTS({
          modelPath,
          numThreads: 1,
          debug: false,
        });
      }

      const detectResult = await detectTtsModel(modelPath);
      const normalizedDetected =
        detectResult.success && detectResult.detectedModels?.length
          ? detectResult.detectedModels.map((m) => ({
              ...m,
              type: m.type as TTSModelType,
            }))
          : ([
              { type: 'vits' as TTSModelType, modelDir: modelFolder },
            ] as Array<{
              type: TTSModelType;
              modelDir: string;
            }>);
      const firstType =
        (detectResult.modelType as TTSModelType) ??
        normalizedDetected[0]?.type ??
        null;

      let modelInfoValue: { sampleRate: number; numSpeakers: number } | null =
        null;
      try {
        const info = await engine.getModelInfo();
        if (
          info &&
          typeof info.sampleRate === 'number' &&
          typeof info.numSpeakers === 'number'
        ) {
          modelInfoValue = {
            sampleRate: info.sampleRate,
            numSpeakers: info.numSpeakers,
          };
        }
      } catch {
        // leave modelInfoValue null
      }
      ttsEngineRef.current = engine;
      setDetectedModels(normalizedDetected);
      setCurrentModelFolder(modelFolder);
      setSelectedModelType(firstType);
      setModelInfo(modelInfoValue);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )}\nDetected models: ${normalizedDetected
          .map((m) => m.type)
          .join(', ')}`
      );
      setTtsCache(
        engine,
        modelFolder,
        normalizedDetected,
        firstType,
        modelInfoValue
      );

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
      const eng = ttsEngineRef.current;
      if (eng) await eng.cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    const engine = ttsEngineRef.current;
    if (!engine) {
      setError('TTS engine not initialized');
      return;
    }
    try {
      const options = getSynthesisOptions();
      const result = await engine.generateSpeech(inputText, options);

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
      const eng = ttsEngineRef.current;
      if (eng) await eng.cancelSpeechStream();
      resetStreamingState(true);
    }
    if (soundInstance) {
      soundInstance.release();
      setSoundInstance(null);
      setIsPlaying(false);
    }

    const engine = ttsEngineRef.current;
    if (!engine) {
      setError('TTS engine not initialized');
      setGenerating(false);
      return;
    }
    try {
      const options = getSynthesisOptions();
      const result = await engine.generateSpeechWithTimestamps(
        inputText,
        options
      );

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
      const eng = ttsEngineRef.current;
      if (eng) await eng.cancelSpeechStream();
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
    if (Platform.OS === 'android' && DownloadDirectoryPath) {
      return DownloadDirectoryPath;
    }
    return DocumentDirectoryPath;
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
      const ext = 'wav';
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

      await mkdir(targetDirectory);
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
            await unlink(tempWav);
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
      const ext = 'wav';
      const directoryPath = DocumentDirectoryPath;
      await mkdir(directoryPath);

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
            await unlink(tempWav);
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
      const directoryPath = DocumentDirectoryPath;

      await mkdir(directoryPath);
      const filePath = `${directoryPath}/${filename}`;

      const srtContent = buildSrtContent(generatedSubtitles);
      await writeFile(filePath, srtContent, 'utf8');
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

      await mkdir(targetDirectory);
      const filePath = `${targetDirectory}/${filename}`;

      await writeFile(filePath, srtContent, 'utf8');
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
          (await exists(cachedPlaybackPath))
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
      const existsResult = await exists(savedAudioPath);
      if (!existsResult && !savedAudioPath.startsWith('content://')) {
        Alert.alert('Error', 'Saved audio file not found.');
        return;
      }

      const shareUrl = getShareUrl(savedAudioPath);

      // We use WAV for saved files.
      const mimeType = 'audio/wav';

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

  const handleFree = async () => {
    try {
      if (streaming) {
        const eng = ttsEngineRef.current;
        if (eng) await eng.cancelSpeechStream();
        resetStreamingState(true);
      }
      if (soundInstance) {
        soundInstance.release();
        setSoundInstance(null);
        setIsPlaying(false);
      }
      const engine = ttsEngineRef.current;
      if (engine) {
        await engine.destroy();
        ttsEngineRef.current = null;
      }
      clearTtsCache();
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
      Alert.alert('Success', 'TTS model released');
    } catch (err) {
      console.error('Release error:', err);
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
          {currentModelFolder != null && (
            <TouchableOpacity
              style={styles.cleanupButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.cleanupButtonText}>Release model</Text>
            </TouchableOpacity>
          )}
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

          {/* Section 4: Generate Speech - always visible */}
          <>
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
          </>

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
