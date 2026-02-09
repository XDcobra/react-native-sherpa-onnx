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
  generateSpeechStream,
  cancelSpeechStream,
  startTtsPcmPlayer,
  writeTtsPcmChunk,
  stopTtsPcmPlayer,
  unloadTTS,
  getModelInfo,
  saveAudioToFile,
  saveAudioToContentUri,
  copyContentUriToCache,
  shareAudioFile,
} from 'react-native-sherpa-onnx/tts';
import { listAssetModels, resolveModelPath } from 'react-native-sherpa-onnx';
import { getModelDisplayName } from '../../modelConfig';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';
import * as DocumentPicker from '@react-native-documents/picker';

export default function TTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: string; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] = useState<string | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState<string>('Hello, world!');
  const [speakerId, setSpeakerId] = useState<string>('0');
  const [speed, setSpeed] = useState<string>('1.0');
  const [generatedAudio, setGeneratedAudio] = useState<{
    samples: number[];
    sampleRate: number;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState<number | null>(null);
  const [streamSampleCount, setStreamSampleCount] = useState(0);
  const [modelInfo, setModelInfo] = useState<{
    sampleRate: number;
    numSpeakers: number;
  } | null>(null);
  const [savedAudioPath, setSavedAudioPath] = useState<string | null>(null);
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
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setModelInfo(null);
    setGeneratedAudio(null);
    setSavedAudioPath(null);
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

      // Resolve model path
      const modelPath = await resolveModelPath({
        type: 'asset',
        path: `models/${modelFolder}`,
      });

      console.log('TTSScreen: Resolved model path:', modelPath);

      // Initialize new model
      const result = await initializeTTS({
        modelPath,
        numThreads: 2,
        debug: false,
      });

      if (result.success && result.detectedModels.length > 0) {
        setDetectedModels(result.detectedModels);
        setCurrentModelFolder(modelFolder);

        const detectedTypes = result.detectedModels
          .map((m) => m.type)
          .join(', ');
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected models: ${detectedTypes}`
        );

        // Auto-select first detected model
        if (result.detectedModels.length === 1 && result.detectedModels[0]) {
          setSelectedModelType(result.detectedModels[0].type);
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
    setSavedAudioPath(null);
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
    setSavedAudioPath(null);
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

      if (!directoryPath) {
        // Fallback to a user-visible directory when possible
        if (Platform.OS === 'android' && RNFS.DownloadDirectoryPath) {
          directoryPath = RNFS.DownloadDirectoryPath;
        } else {
          directoryPath = RNFS.DocumentDirectoryPath;
        }
        Alert.alert(
          'Notice',
          'The selected storage location cannot be written to directly. The file will be saved in a default directory.'
        );
      }

      await RNFS.mkdir(directoryPath);
      const filePath = `${directoryPath}/${filename}`;

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
      setSavedAudioPath(null);
      setError(null);
      Alert.alert('Success', 'TTS resources released');
    } catch (err) {
      console.error('Cleanup error:', err);
      Alert.alert('Error', 'Failed to release TTS resources');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.icon}>🔊</Text>
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
              {availableModels.map((modelFolder) => (
                <TouchableOpacity
                  key={modelFolder}
                  style={[
                    styles.modelButton,
                    currentModelFolder === modelFolder &&
                      styles.modelButtonActive,
                  ]}
                  onPress={() => handleInitialize(modelFolder)}
                  disabled={loading}
                >
                  <Text
                    style={[
                      styles.modelButtonText,
                      currentModelFolder === modelFolder &&
                        styles.modelButtonTextActive,
                    ]}
                  >
                    {getModelDisplayName(modelFolder)}
                  </Text>
                  <Text style={styles.modelButtonSubtext}>{modelFolder}</Text>
                </TouchableOpacity>
              ))}
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
              <Text style={styles.autoSelectedText}>
                ✓ Auto-selected: {selectedModelType}
              </Text>
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
                  <Text style={styles.audioButtonText}>💾 Save temporary</Text>
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
                  <Text style={styles.audioButtonText}>📁 Save to Folder</Text>
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
                      <Text style={styles.audioButtonText}>
                        {isPlaying ? '⏸️ Pause' : '▶️ Play'}
                      </Text>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.audioButton, styles.stopButton]}
                    onPress={handleStopAudio}
                  >
                    <Text style={styles.audioButtonText}>⏹️ Stop</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.audioButton, styles.shareButton]}
                    onPress={handleShareAudio}
                  >
                    <Text style={styles.audioButtonText}>📤 Share</Text>
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
          <Text style={styles.footerText}>
            💡 Tip: Models must be placed in assets/models/ directory
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
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
    fontSize: 48,
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
  audioButton: {
    flexBasis: '30%',
    maxWidth: '32%',
    flexGrow: 1,
    borderRadius: 8,
    padding: 12,
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
