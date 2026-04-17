import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createIncrementalStreamingTTS,
  detectTtsModel,
  type IncrementalStreamController,
  type IncrementalStreamingTtsEngine,
  type TTSModelType,
} from 'react-native-sherpa-onnx/tts';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  type LiveAudioBufferInfo,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { listAssetModels } from 'react-native-sherpa-onnx';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';

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

function splitTextIntoChunks(text: string): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }
  const sentenceChunks = normalized.match(/[^.!?]+[.!?]?(\s+|$)/g);
  const rawChunks =
    sentenceChunks && sentenceChunks.length > 0 ? sentenceChunks : [normalized];
  const chunks: string[] = [];
  for (const chunk of rawChunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 180) {
      chunks.push(trimmed);
      continue;
    }
    let remaining = trimmed;
    while (remaining.length > 180) {
      let splitAt = remaining.lastIndexOf(' ', 180);
      if (splitAt <= 40) {
        splitAt = 180;
      }
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining.length > 0) {
      chunks.push(remaining);
    }
  }
  return chunks;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type StreamingState = 'idle' | 'starting' | 'running' | 'stopping';

export default function TTSStreamingScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [inputText, setInputText] = useState(
    'This example streams text into the incremental TTS pipeline so synthesis can start before the whole script is fully prepared.'
  );
  const [speakerId, setSpeakerId] = useState('0');
  const [speed, setSpeed] = useState('1.0');
  const [status, setStatus] = useState(
    'Select a model and stream the text into the incremental TTS engine.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [generatedSamples, setGeneratedSamples] = useState(0);
  const [resultBuffer, setResultBuffer] = useState<{
    bufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);
  const [isResultPlaying, setIsResultPlaying] = useState(false);

  const engineRef = useRef<IncrementalStreamingTtsEngine | null>(null);
  const controllerRef = useRef<IncrementalStreamController | null>(null);
  const audioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const cleanupLockRef = useRef(false);
  const currentResultBufferRef = useRef<{
    bufferId: string;
    sampleRate: number;
    numSamples: number;
  } | null>(null);
  const isResultPlayingRef = useRef(false);
  const streamedInputLengthRef = useRef(0);

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds]
  );

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const [assets, downloaded] = await Promise.all([
        listAssetModels(),
        listDownloadedModels(ModelCategory.Tts),
      ]);
      const assetModels = assets
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const downloadedIds = downloaded.map((model) => model.id);

      const candidateModels = Array.from(
        new Set([...assetModels, ...downloadedIds])
      );
      const streamingModelsRaw = await Promise.all(
        candidateModels.map(async (modelFolder) => {
          try {
            const modelPath = downloadedIds.includes(modelFolder)
              ? getFileModelPath(modelFolder, ModelCategory.Tts)
              : getAssetModelPath(modelFolder);
            const detection = await detectTtsModel(
              await toDetectSource(modelPath)
            );
            return detection.success && detection.isStreaming
              ? modelFolder
              : null;
          } catch {
            return null;
          }
        })
      );

      const available = streamingModelsRaw.filter(
        (modelFolder): modelFolder is string => modelFolder != null
      );

      setAvailableModels(available);
      setDownloadedModelIds(downloadedIds);
      setSelectedModelFolder((prev) =>
        prev && available.includes(prev) ? prev : available[0] ?? null
      );
      if (available.length === 0) {
        setStatus(
          'No streaming TTS models found. Install/download a streaming model to use this screen.'
        );
      }
    } catch (loadErr) {
      setError(normalizeErrorMessage(loadErr));
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadModels().catch(() => {
      // loadModels already updates state
    });
    const unsubscribe = onModelsListUpdated((category) => {
      if (category === ModelCategory.Tts) {
        loadModels().catch(() => {});
      }
    });
    return unsubscribe;
  }, [loadModels]);

  const releaseResultBuffer = useCallback(async () => {
    if (isResultPlayingRef.current) {
      try {
        await playerRef.current?.destroy();
      } catch {
        // ignore teardown races
      }
      playerRef.current = null;
      isResultPlayingRef.current = false;
      setIsResultPlaying(false);
    }

    const previous = currentResultBufferRef.current;
    if (previous) {
      await releasePipelineAudioBuffer(previous.bufferId).catch(() => {});
      currentResultBufferRef.current = null;
      setResultBuffer(null);
    }
  }, []);

  const cleanupStream = useCallback(
    async (options?: { preserveAudioBuffer?: boolean }) => {
      if (cleanupLockRef.current) {
        return;
      }
      cleanupLockRef.current = true;

      const preserveAudioBuffer = options?.preserveAudioBuffer ?? false;

      try {
        try {
          await controllerRef.current?.cancel({ scope: 'all' });
        } catch {
          // ignore teardown races
        }
        controllerRef.current = null;

        if (!preserveAudioBuffer) {
          try {
            await playerRef.current?.destroy();
          } catch {
            // ignore teardown races
          }
          playerRef.current = null;
          setIsResultPlaying(false);
        }

        try {
          await engineRef.current?.destroy();
        } catch {
          // ignore teardown races
        }
        engineRef.current = null;

        const audioBuffer = audioBufferRef.current;
        audioBufferRef.current = null;
        if (audioBuffer && !preserveAudioBuffer) {
          await releasePipelineAudioBuffer(audioBuffer.bufferId).catch(
            () => {}
          );
        }
      } finally {
        cleanupLockRef.current = false;
      }
    },
    []
  );

  const startStreaming = useCallback(async () => {
    if (streamingState !== 'idle') {
      return;
    }
    if (!selectedModelFolder) {
      setError('Select a TTS model first.');
      return;
    }
    const text = inputText.trim();
    if (!text) {
      setError('Enter text to synthesize.');
      return;
    }

    setError(null);
    setProgress(null);
    setGeneratedSamples(0);
    setStreamingState('starting');
    await releaseResultBuffer();

    try {
      const modelPath = resolveModelPath(selectedModelFolder);
      const detection = await detectTtsModel(await toDetectSource(modelPath));
      if (!detection.success) {
        throw new Error(detection.error ?? 'TTS model detection failed');
      }

      const engine = await createIncrementalStreamingTTS({
        source: {
          engineOptions: {
            modelPath,
            modelType: 'auto' as TTSModelType,
            numThreads: 2,
            debug: false,
          },
        },
        segmentation: {
          // Use library defaults (see resolveSegmentationPolicy in segmenter.ts).
        },
        queue: {
          mode: 'fifo',
          maxSegments: 24,
          maxBufferedChars: 12000,
          overflowStrategy: 'drop-oldest',
        },
      });
      engineRef.current = engine;

      const sampleRate = await engine.getSampleRate();
      const audioBuffer = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        emitAppendedEvents: true,
        onFramesAppended: (event) => {
          setGeneratedSamples(event.totalSamplesWritten);
        },
      });
      audioBufferRef.current = audioBuffer;

      const player = await createPcmPlayer(audioBuffer.bufferId, {
        onEnded: () => {
          setStatus('Playback reached the end of the streamed TTS output.');
        },
      });
      playerRef.current = player;

      const controller = await engine.startSession(audioBuffer.bufferId, {
        sid: Number.parseInt(speakerId, 10) || 0,
        speed: Number.parseFloat(speed) || 1.0,
      });
      controllerRef.current = controller;

      const chunks = splitTextIntoChunks(text);
      setStreamingState('running');
      setStatus(
        'Streaming TTS is running. Incremental segmentation and queueing keep playback moving before the whole prompt finishes.'
      );
      streamedInputLengthRef.current = text.length;

      for (let index = 0; index < chunks.length; index += 1) {
        controller.pushText(chunks[index]! + ' ');
        setProgress(((index + 1) / Math.max(chunks.length, 1)) * 100);
        await delay(90);
      }
      setStatus(
        'Streaming TTS is active. Add more text and press Stop when done.'
      );
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStreamingState('idle');
      await cleanupStream();
    }
  }, [
    cleanupStream,
    inputText,
    releaseResultBuffer,
    resolveModelPath,
    selectedModelFolder,
    speakerId,
    speed,
    streamingState,
  ]);

  const stopStreaming = useCallback(async () => {
    if (streamingState === 'idle') {
      return;
    }
    setStreamingState('stopping');
    setStatus('Stopping streaming TTS...');
    try {
      const controller = controllerRef.current;
      const audioBuffer = audioBufferRef.current;
      if (controller && audioBuffer) {
        await controller.flush();
        await finalizeLiveAudioBuffer(audioBuffer.bufferId);
        await controller.pipeline.completed;

        const info = (await getPipelineAudioBufferInfo(
          audioBuffer.bufferId
        )) as LiveAudioBufferInfo;
        const nextResult = {
          bufferId: audioBuffer.bufferId,
          sampleRate: info.sampleRate,
          numSamples: info.numSamples,
        };
        currentResultBufferRef.current = nextResult;
        setResultBuffer(nextResult);
      }
      setStatus('Streaming TTS stopped. Result is ready for playback.');
    } catch (stopErr) {
      setError(normalizeErrorMessage(stopErr));
      setStatus('Streaming stop encountered an error.');
    } finally {
      setStreamingState('idle');
      await cleanupStream({ preserveAudioBuffer: true });
    }
  }, [cleanupStream, streamingState]);

  useEffect(() => {
    currentResultBufferRef.current = resultBuffer;
  }, [resultBuffer]);

  useEffect(() => {
    isResultPlayingRef.current = isResultPlaying;
  }, [isResultPlaying]);

  useEffect(() => {
    if (streamingState !== 'running') {
      return;
    }
    const controller = controllerRef.current;
    if (!controller) {
      return;
    }
    const nextText = inputText;
    if (nextText.length <= streamedInputLengthRef.current) {
      return;
    }
    const delta = nextText.slice(streamedInputLengthRef.current);
    if (!delta) {
      streamedInputLengthRef.current = nextText.length;
      return;
    }
    const chunks = splitTextIntoChunks(delta);
    for (const chunk of chunks) {
      controller.pushText(`${chunk} `);
    }
    streamedInputLengthRef.current = nextText.length;
    setProgress(null);
  }, [inputText, streamingState]);

  const handleToggleResultPlayback = useCallback(async () => {
    if (!resultBuffer) {
      return;
    }

    if (isResultPlaying) {
      try {
        await playerRef.current?.destroy();
      } catch {
        // ignore playback teardown races
      }
      playerRef.current = null;
      isResultPlayingRef.current = false;
      setIsResultPlaying(false);
      return;
    }

    const player = await createPcmPlayer(resultBuffer.bufferId, {
      onEnded: () => {
        setIsResultPlaying(false);
      },
    });
    playerRef.current = player;
    isResultPlayingRef.current = true;
    setIsResultPlaying(true);
  }, [isResultPlaying, resultBuffer]);

  useEffect(() => {
    return () => {
      void (async () => {
        await cleanupStream();
        await releaseResultBuffer();
      })();
    };
  }, [cleanupStream, releaseResultBuffer]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="volume-high-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Text-to-Speech Streaming</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Model</Text>
          {loadingModels ? (
            <View style={styles.inlineRow}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>Loading models...</Text>
            </View>
          ) : null}
          <View style={styles.modelList}>
            {availableModels.map((modelFolder) => {
              const selected = modelFolder === selectedModelFolder;
              return (
                <Pressable
                  key={modelFolder}
                  onPress={() => setSelectedModelFolder(modelFolder)}
                  style={[
                    styles.modelListItem,
                    selected && styles.modelListItemSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.modelListTitle,
                      selected && styles.modelListTitleSelected,
                    ]}
                  >
                    {getModelDisplayName(modelFolder)}
                  </Text>
                  <Text style={styles.modelListSubtitle}>{modelFolder}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Input</Text>
          <Text style={styles.sectionLabel}>Speaker / speed</Text>
          <View style={styles.inlineInputs}>
            <TextInput
              value={speakerId}
              onChangeText={setSpeakerId}
              keyboardType="number-pad"
              placeholder="0"
              style={styles.smallInput}
            />
            <TextInput
              value={speed}
              onChangeText={setSpeed}
              keyboardType="decimal-pad"
              placeholder="1.0"
              style={styles.smallInput}
            />
          </View>
          <Text style={styles.sectionLabel}>Text</Text>
          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder="Enter a long prompt to stream through incremental TTS..."
            multiline
            style={styles.textInput}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Run</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.primaryButton,
                streamingState === 'starting' || streamingState === 'stopping'
                  ? styles.buttonDisabled
                  : null,
              ]}
              onPress={() => {
                if (streamingState === 'idle') {
                  void startStreaming();
                } else if (streamingState === 'running') {
                  void stopStreaming();
                }
              }}
              disabled={
                streamingState === 'starting' || streamingState === 'stopping'
              }
            >
              <Text style={styles.primaryButtonText}>
                {streamingState === 'running'
                  ? 'Stop streaming'
                  : 'Start streaming'}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.mutedText}>{status}</Text>
          {progress != null ? (
            <Text style={styles.mutedText}>
              Text progress: {progress.toFixed(0)}%
            </Text>
          ) : null}
          <Text style={styles.mutedText}>
            Generated samples: {generatedSamples.toLocaleString()}
          </Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>

        {resultBuffer && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Result playback</Text>
            <Text style={styles.mutedText}>
              {resultBuffer.sampleRate} Hz •{' '}
              {resultBuffer.numSamples.toLocaleString()} samples
            </Text>
            <View style={styles.actionRow}>
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  handleToggleResultPlayback().catch((err) => {
                    setError(normalizeErrorMessage(err));
                  });
                }}
              >
                <Text style={styles.primaryButtonText}>
                  {isResultPlaying ? 'Stop' : 'Play'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>

      <ScreenIntroModal screenId="TTSStreaming" />
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
    gap: 14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mutedText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#6B7280',
  },
  modelList: {
    gap: 8,
  },
  modelListItem: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: '#F2F2F7',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  modelListItemSelected: {
    backgroundColor: '#EBF3FF',
    borderColor: '#0F62FE',
  },
  modelListTitle: {
    color: '#111827',
    fontWeight: '700',
    marginBottom: 2,
  },
  modelListTitleSelected: {
    color: '#0F62FE',
  },
  modelListSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    color: '#6B7280',
  },
  sectionLabel: {
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  inlineInputs: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  smallInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    color: '#111827',
  },
  textInput: {
    minHeight: 180,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    color: '#111827',
    fontSize: 15,
    lineHeight: 22,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#E5E7EB',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  errorText: {
    marginTop: 10,
    color: '#B42318',
    fontWeight: '600',
  },
});
