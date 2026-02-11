import { useState, useEffect, useRef, useCallback } from 'react';
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
} from 'react-native-sherpa-onnx/tts';
import { listAssetModels } from 'react-native-sherpa-onnx';
import { getModelDisplayName } from '../../modelConfig';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';

export default function TTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
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
  const [noiseScale, setNoiseScale] = useState<string>('');
  const [noiseScaleW, setNoiseScaleW] = useState<string>('');
  const [lengthScale, setLengthScale] = useState<string>('');
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

  const getSynthesisOptions = useCallback(() => {
    const sid = parseInt(speakerId, 10);
    const speedValue = parseFloat(speed);

    if (isNaN(sid) || sid < 0) {
      throw new Error('Invalid speaker ID');
    }

    if (isNaN(speedValue) || speedValue <= 0) {
      throw new Error('Invalid speed value');
    }

    return { sid, speed: speedValue };
  }, [speakerId, speed]);

  const processStreamQueue = useCallback(async () => {
    if (!streaming || streamInFlightRef.current) {
      return;
    }

    const nextText = streamQueueRef.current.shift();
    if (!nextText) {
      return;
    }

    let options: { sid: number; speed: number };
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
      const models = await listAssetModels();
      const ttsFolders = models
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const sttFolders = models
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const unknownFolders = models.filter((model) => model.hint === 'unknown');

      console.log('TTSScreen: Found model folders:', models);
      setAvailableModels(ttsFolders);
      if (ttsFolders.length === 0) {
        setError(
          sttFolders.length > 0
            ? 'No TTS models found. Only STT models detected in assets/models/. See TTS_MODEL_SETUP.md'
            : unknownFolders.length > 0
            ? 'No TTS models found. Some models have unknown type hints. See TTS_MODEL_SETUP.md'
            : 'No TTS models found in assets. See TTS_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('TTSScreen: Failed to list models:', err);
      setError('Failed to list available models');
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

      const modelPath = {
        type: 'asset',
        path: `models/${modelFolder}`,
      } as const;

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
                numThreads: 2,
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

        // Get model info
        try {
          const info = await getModelInfo();
          setModelInfo(info);
        } catch (infoErr) {
          console.warn('Failed to get model info:', infoErr);
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
        `Initialization failed: ${errorMessage}\n\nNote: TTS models must be provided separately. See TTS_MODEL_SETUP.md for details.`
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
      const sid = parseInt(speakerId, 10);
      const speedValue = parseFloat(speed);

      if (isNaN(sid) || sid < 0) {
        throw new Error('Invalid speaker ID');
      }

      if (isNaN(speedValue) || speedValue <= 0) {
        throw new Error('Invalid speed value');
      }

      const result = await generateSpeech(inputText, {
        sid,
        speed: speedValue,
      });

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
      const sid = parseInt(speakerId, 10);
      const speedValue = parseFloat(speed);

      if (isNaN(sid) || sid < 0) {
        throw new Error('Invalid speaker ID');
      }

      if (isNaN(speedValue) || speedValue <= 0) {
        throw new Error('Invalid speed value');
      }

      const result = await generateSpeechWithTimestamps(inputText, {
        sid,
        speed: speedValue,
      });

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
      const filename = `tts_${timestamp}.wav`;

      const { directoryPath, directoryUri } = await pickSaveDirectory();

      if (directoryUri) {
        const savedUri = await saveAudioToContentUri(
          audio,
          directoryUri,
          filename
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
      const filePath = `${targetDirectory}/${filename}`;

      // Save audio to file
      const savedPath = await saveAudioToFile(audio, filePath);
      setSavedAudioPath(savedPath);
      setCachedPlaybackPath(null);
      setCachedPlaybackSource(null);

      Alert.alert('Success', `Audio saved to:\n${getDisplayPath(savedPath)}`, [
        {
          text: 'OK',
          onPress: () => console.log('Audio saved:', savedPath),
        },
      ]);
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

  const handleSaveTemporary = async () => {
    if (!generatedAudio) {
      Alert.alert('Error', 'No audio to save. Generate speech first.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const timestamp = Date.now();
      const filename = `tts_${timestamp}.wav`;
      const directoryPath = RNFS.DocumentDirectoryPath;

      await RNFS.mkdir(directoryPath);
      const filePath = `${directoryPath}/${filename}`;

      const savedPath = await saveAudioToFile(generatedAudio, filePath);
      setSavedAudioPath(savedPath);
      setCachedPlaybackPath(null);
      setCachedPlaybackSource(null);

      Alert.alert('Success', `Audio saved to:\n${getDisplayPath(savedPath)}`, [
        {
          text: 'OK',
          onPress: () => console.log('Audio saved:', savedPath),
        },
      ]);
    } catch (err) {
      console.error('Save audio error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save audio: ${errorMessage}`);
      Alert.alert('Error', `Failed to save audio: ${errorMessage}`);
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

      if (Platform.OS === 'android') {
        await shareAudioFile(shareUrl, 'audio/wav');
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
    <SafeAreaView style={styles.container}>
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

            <View style={styles.parameterRow}>
              <View style={styles.parameterColumn}>
                <Text style={styles.inputLabel}>Noise Scale (optional):</Text>
                <TextInput
                  style={styles.parameterInput}
                  value={noiseScale}
                  onChangeText={setNoiseScale}
                  keyboardType="decimal-pad"
                  placeholder="0.667"
                  placeholderTextColor="#8E8E93"
                />
              </View>

              <View style={styles.parameterColumn}>
                <Text style={styles.inputLabel}>Noise Scale W (optional):</Text>
                <TextInput
                  style={styles.parameterInput}
                  value={noiseScaleW}
                  onChangeText={setNoiseScaleW}
                  keyboardType="decimal-pad"
                  placeholder="0.8"
                  placeholderTextColor="#8E8E93"
                />
              </View>
            </View>

            <View style={styles.parameterRow}>
              <View style={styles.parameterColumn}>
                <Text style={styles.inputLabel}>Length Scale (optional):</Text>
                <TextInput
                  style={styles.parameterInput}
                  value={lengthScale}
                  onChangeText={setLengthScale}
                  keyboardType="decimal-pad"
                  placeholder="1.0"
                  placeholderTextColor="#8E8E93"
                />
              </View>
            </View>

            <Text style={styles.hint}>
              Noise/Noise W/Length scale — leave blank to reset to model
              defaults.
            </Text>
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
                  Sample Rate: {modelInfo.sampleRate} Hz
                </Text>
                <Text style={styles.infoText}>
                  Speakers: {modelInfo.numSpeakers}
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

              <View style={styles.parameterRow}>
                <View style={styles.parameterColumn}>
                  <Text style={styles.inputLabel}>Speaker ID:</Text>
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
    backgroundColor: '#F2F2F7',
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
