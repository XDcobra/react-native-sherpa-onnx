import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
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
  createStreamingTTS,
  detectTtsModel,
  type TtsPipelineHandle,
  type TtsPipelineOptions,
  type StreamingTtsEngine,
  type TTSModelType,
} from 'react-native-sherpa-onnx/tts';
import {
  EngineModeModelSelector,
  type EngineMode,
} from '../../components/EngineModeModelSelector';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  type LiveAudioBufferInfo,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  appendLiveTextSegment,
  createLiveTextBuffer,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
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
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  toDetectSource,
} from '../../modelConfig';

const PAD_PACK_NAME = 'sherpa_models';

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

const LIVE_INPUT_PUSH_DEBOUNCE_MS = 400;

function longestCommonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

type StreamingState = 'idle' | 'starting' | 'running' | 'stopping';

type StreamingSessionController = {
  pipeline: TtsPipelineHandle;
  pushText: (text: string) => void;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
};

type StreamingSessionEngine = {
  getSampleRate: () => Promise<number>;
  startSession: (
    audioOut: LiveAudioBufferRef | string,
    options?: TtsPipelineOptions
  ) => Promise<StreamingSessionController>;
  destroy: () => Promise<void>;
};

async function createStreamingSessionEngine(options: {
  modelSource: FileSource;
  modelType: TTSModelType;
  numThreads: number;
  debug: boolean;
  engineMode: EngineMode;
}): Promise<StreamingSessionEngine> {
  const ttsEngine: StreamingTtsEngine =
    options.engineMode === 'streaming'
      ? await createStreamingTTS(options)
      : ((await require('react-native-sherpa-onnx/tts').createTTS(
          options
        )) as unknown as StreamingTtsEngine);
  let activePipeline: TtsPipelineHandle | null = null;
  let activeTextBufferId: string | null = null;

  const releaseTextBufferIfNeeded = async () => {
    if (!activeTextBufferId) return;
    const bufferId = activeTextBufferId;
    activeTextBufferId = null;
    await releasePipelineTextBuffer(bufferId).catch(() => {});
  };

  return {
    getSampleRate: () => ttsEngine.getSampleRate(),
    async startSession(audioOut, pipelineOptions) {
      const textBuffer = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: false, minIntervalMs: 0 } },
      });
      activeTextBufferId = textBuffer.bufferId;
      const audioOutId =
        typeof audioOut === 'string' ? audioOut : audioOut.bufferId;
      const pipeline = await ttsEngine.synthesize(
        textBuffer.bufferId,
        audioOutId,
        pipelineOptions ?? {}
      );
      activePipeline = pipeline;

      return {
        pipeline,
        pushText(text: string) {
          if (!activeTextBufferId || text.length === 0) return;
          appendLiveTextSegment(activeTextBufferId, text).catch(() => {});
        },
        flush: () => pipeline.flush(),
        cancel: async () => {
          if (activePipeline) {
            await activePipeline.stop().catch(() => {});
            activePipeline = null;
          }
          await releaseTextBufferIfNeeded();
        },
      };
    },
    async destroy() {
      if (activePipeline) {
        await activePipeline.stop().catch(() => {});
        activePipeline = null;
      }
      await releaseTextBufferIfNeeded();
      await ttsEngine.destroy();
    },
  };
}

export default function StreamingTTSScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [engineMode, setEngineMode] = useState<EngineMode>('streaming');
  const [streamingModelIds, setStreamingModelIds] = useState<Set<string>>(
    new Set()
  );
  const [inputText, setInputText] = useState(
    'This example streams text into the TTS pipeline so synthesis can start before the whole script is fully prepared.'
  );
  const [speakerId, setSpeakerId] = useState('0');
  const [speed, setSpeed] = useState('1.0');
  const [status, setStatus] = useState(
    'Select a model and stream the text into the TTS engine.'
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
  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'auto',
    policy: {
      evaluator: 'text_synthetic_auto',
      maxLengthChars: 320,
      sentenceBoundary: true,
    },
  });

  const engineRef = useRef<StreamingSessionEngine | null>(null);
  const controllerRef = useRef<StreamingSessionController | null>(null);
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
  const lastInputSnapshotRef = useRef('');
  const pendingDeltaRef = useRef('');
  const deltaDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (padModelIds.includes(modelFolder)) {
        return padModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Tts, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Tts);
      }
      return getAssetModelPath(modelFolder);
    },
    [downloadedModelIds, padModelIds, padModelsPath]
  );

  /** Same folder merge as OfflineTTSScreen (PAD + bundled assets + downloads). No detect filter. */
  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setError(null);
    try {
      // ── Load PAD models ───────────────────────────────────────────────────
      const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
      const fallbackPath = `${DocumentDirectoryPath}/models`;
      const padPath = padPathFromNative ?? fallbackPath;
      const padResults = await listModelsAtPath(padPath).catch(() => []);
      const padFolders = padResults
        .filter((m) => m.hint === 'tts')
        .map((m) => m.folder);
      const resolvedPadPath = padFolders.length > 0 ? padPath : null;

      // ── Load asset models ─────────────────────────────────────────────────
      const assetModels = await listAssetModels();
      const ttsFolders = assetModels
        .filter((m) => m.hint === 'tts')
        .map((m) => m.folder);

      // ── Load downloaded / fs models ───────────────────────────────────────
      const downloadedModels = await listDownloadedModels(ModelCategory.Tts);
      const downloadedIds = downloadedModels.map((m) => m.id);
      const ttsFilePath = `${DocumentDirectoryPath}/sherpa-onnx/models/${ModelCategory.Tts}`;
      const ttsFs = await listModelsAtPath(ttsFilePath).catch(() => []);
      const ttsFsIds = ttsFs.map((m) => m.folder);
      const allDownloadedIds = [...new Set([...downloadedIds, ...ttsFsIds])];

      const candidateModels = [
        ...padFolders,
        ...ttsFolders.filter((f) => !padFolders.includes(f)),
        ...allDownloadedIds.filter(
          (f) => !padFolders.includes(f) && !ttsFolders.includes(f)
        ),
      ];

      const detectionResults = await Promise.all(
        candidateModels.map(async (folder) => {
          try {
            const source = padFolders.includes(folder)
              ? getFileModelPath(
                  folder,
                  ModelCategory.Tts,
                  resolvedPadPath ?? padPath
                )
              : ttsFolders.includes(folder)
              ? getAssetModelPath(folder)
              : getFileModelPath(folder, ModelCategory.Tts);
            const detected = await detectTtsModel(
              await toDetectSource(source),
              {
                modelType: 'auto',
              }
            );
            return { folder, isStreaming: !!detected.isStreaming };
          } catch {
            return null;
          }
        })
      );

      const available = candidateModels.filter(
        (_, i) => detectionResults[i] != null || true
      );
      const streamingIds = new Set(
        detectionResults
          .filter((r) => r != null && r.isStreaming)
          .map((r) => r!.folder)
      );

      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);
      setAvailableModels(available);
      setStreamingModelIds(streamingIds);
      setDownloadedModelIds(allDownloadedIds);

      const initialModel =
        engineMode === 'streaming'
          ? available.find((m) => streamingIds.has(m))
          : available[0];

      setSelectedModelFolder((prev) =>
        prev && available.includes(prev) ? prev : initialModel ?? null
      );
      if (available.length === 0) {
        setStatus(
          'No TTS models found. Add one under assets, PAD, or downloads (category: tts).'
        );
      }
    } catch (loadErr) {
      setError(normalizeErrorMessage(loadErr));
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, [engineMode]);

  // Auto-enforce segmentation when switching to Live Overload mode
  useEffect(() => {
    if (engineMode === 'offline') {
      setSegConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: {
              evaluator: 'text_synthetic_auto',
              maxLengthChars: 320,
              sentenceBoundary: true,
            },
          };
        }
        return prev;
      });
    }
  }, [engineMode]);

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
          // cancel() → pipeline.stop(); settles `pipeline.completed` (see StreamingPipelineHandle).
          await controllerRef.current?.cancel();
        } catch {
          // ignore teardown races
        }
        controllerRef.current = null;

        // Always tear down the live-stream PCM player so after Stop the finalized
        // buffer can be played back with a fresh player in the result section.
        try {
          await playerRef.current?.destroy();
        } catch {
          // ignore teardown races
        }
        playerRef.current = null;
        setIsResultPlaying(false);

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

      if (engineMode === 'streaming' && !detection.isStreaming) {
        throw new Error(
          'This TTS model is offline-only. Switch to "Live Overload" mode to use it.'
        );
      }

      const engine = await createStreamingSessionEngine({
        modelSource: modelPath,
        modelType: 'auto' as TTSModelType,
        numThreads: 2,
        debug: false,
        engineMode,
      });
      engineRef.current = engine;

      const sampleRate = await engine.getSampleRate();
      const audioBuffer = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
        ringSeconds: 240,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: true, minIntervalMs: 0 } },
        onFramesAppended: (event) => {
          setGeneratedSamples(event.totalSamplesWritten);
        },
      });
      audioBufferRef.current = audioBuffer;

      const seg = buildSegmentationOption(segConfig);
      const controller = await engine.startSession(audioBuffer.bufferId, {
        sid: Number.parseInt(speakerId, 10) || 0,
        speed: Number.parseFloat(speed) || 1.0,
        ...(seg ? { segmentation: seg } : {}),
      });
      controllerRef.current = controller;

      setStreamingState('running');
      setStatus(
        'Streaming TTS is running. Segmentation and queueing keep playback moving before the whole prompt finishes.'
      );
      streamedInputLengthRef.current = text.length;
      lastInputSnapshotRef.current = text;
      pendingDeltaRef.current = '';
      setProgress(100);
      controller.pushText(text);
      setStatus(
        'Streaming TTS is active. Add more text and press Stop when done.'
      );

      const liveBufferId = audioBuffer.bufferId;
      try {
        const livePlayer = await createPcmPlayer(liveBufferId);
        if (
          audioBufferRef.current?.bufferId === liveBufferId &&
          controllerRef.current === controller
        ) {
          playerRef.current = livePlayer;
        } else {
          await livePlayer.destroy().catch(() => {});
        }
      } catch {
        // Live preview is optional; synthesis continues if PCM player fails.
      }
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStreamingState('idle');
      await cleanupStream();
    }
  }, [
    cleanupStream,
    engineMode,
    inputText,
    releaseResultBuffer,
    resolveModelPath,
    segConfig,
    selectedModelFolder,
    speakerId,
    speed,
    streamingState,
  ]);

  const stopStreaming = useCallback(async () => {
    if (streamingState !== 'running') {
      return;
    }
    setStreamingState('stopping');
    setStatus('Stopping streaming TTS...');

    const controller = controllerRef.current;
    const audioBuffer = audioBufferRef.current;

    try {
      if (!audioBuffer) {
        throw new Error('No live audio buffer (internal error).');
      }

      if (deltaDebounceTimerRef.current) {
        clearTimeout(deltaDebounceTimerRef.current);
        deltaDebounceTimerRef.current = null;
      }
      if (controller && pendingDeltaRef.current.length > 0) {
        controller.pushText(pendingDeltaRef.current);
        pendingDeltaRef.current = '';
      }
      if (controller) {
        await controller.flush();
      }

      await finalizeLiveAudioBuffer(audioBuffer.bufferId);

      const info = (await getPipelineAudioBufferInfo(
        audioBuffer.bufferId
      )) as LiveAudioBufferInfo;
      const nextResult = {
        bufferId: audioBuffer.bufferId,
        sampleRate: info.sampleRate,
        numSamples: info.numSamples ?? 0,
      };
      currentResultBufferRef.current = nextResult;
      setResultBuffer(nextResult);

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
      if (deltaDebounceTimerRef.current) {
        clearTimeout(deltaDebounceTimerRef.current);
        deltaDebounceTimerRef.current = null;
      }
      return;
    }
    if (!controllerRef.current) {
      return;
    }

    const nextText = inputText;
    const previousText = lastInputSnapshotRef.current;
    if (nextText === previousText) {
      return;
    }

    let delta = '';
    if (nextText.startsWith(previousText)) {
      delta = nextText.slice(previousText.length);
    } else {
      // Some keyboards/autocorrect produce non-append updates. To avoid dropping
      // user text, resync from the common prefix instead of clearing pending data.
      const lcp = longestCommonPrefixLength(previousText, nextText);
      delta = nextText.slice(lcp);
    }

    lastInputSnapshotRef.current = nextText;
    streamedInputLengthRef.current = nextText.length;
    if (delta.length > 0) {
      pendingDeltaRef.current += delta;
    }
    if (deltaDebounceTimerRef.current) {
      clearTimeout(deltaDebounceTimerRef.current);
    }
    deltaDebounceTimerRef.current = setTimeout(() => {
      deltaDebounceTimerRef.current = null;
      const activeController = controllerRef.current;
      if (!activeController || streamingState !== 'running') {
        return;
      }
      const pending = pendingDeltaRef.current;
      if (!pending) return;
      pendingDeltaRef.current = '';
      activeController.pushText(pending);
    }, LIVE_INPUT_PUSH_DEBOUNCE_MS);
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
        if (deltaDebounceTimerRef.current) {
          clearTimeout(deltaDebounceTimerRef.current);
          deltaDebounceTimerRef.current = null;
        }
        await cleanupStream();
        await releaseResultBuffer();
      })();
    };
  }, [cleanupStream, releaseResultBuffer]);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="volume-high-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Text-to-Speech Streaming</Text>
        </View>

        <EngineModeModelSelector
          label="TTS Engine"
          engineMode={engineMode}
          onEngineModeChange={setEngineMode}
          models={availableModels}
          selectedModel={selectedModelFolder}
          onModelSelect={setSelectedModelFolder}
          isModelStreamingCapable={(m) => streamingModelIds.has(m)}
          loading={loadingModels}
          disabled={streamingState !== 'idle'}
        />

        {engineMode === 'streaming' && (
          <View style={styles.card}>
            <View style={[styles.inlineRow, { gap: 10, marginBottom: 8 }]}>
              <Ionicons name="information-circle" size={20} color="#007AFF" />
              <Text
                style={[
                  styles.cardTitle,
                  { marginBottom: 0, color: '#007AFF', flex: 1 },
                ]}
              >
                No real streaming TTS model
              </Text>
            </View>
            <Text style={styles.bodyText}>
              TTS synthesis cannot generate audio incrementally frame-by-frame
              like streaming STT. There are no "streaming" TTS models in the
              sherpa-onnx sense.
            </Text>
            <Text style={[styles.bodyText, { marginTop: 8 }]}>
              Switch to <Text style={{ fontWeight: '700' }}>Live Overload</Text>{' '}
              mode to use offline TTS models with mandatory text segmentation.
              The SDK will chunk your input text at sentence/length boundaries
              and synthesize each chunk without pre-buffering the whole script.
            </Text>
          </View>
        )}

        {engineMode === 'offline' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Text Segmentation</Text>
            <Text style={[styles.mutedText, { marginBottom: 10 }]}>
              Live Overload requires segmentation to chunk text before
              synthesis. The 'Off' option is disabled.
            </Text>
            <SegmentationPolicyControls
              variant="text-offline"
              value={segConfig}
              onChange={setSegConfig}
              disabled={streamingState !== 'idle'}
              disableOff
              offDisabledMessage="Live Overload requires mandatory text segmentation to split input into processable chunks."
            />
          </View>
        )}

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
            placeholder="Enter a long prompt to stream through TTS..."
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
          <View style={[styles.card, styles.resultCard]}>
            <View style={styles.resultCardHeader}>
              <Ionicons name="musical-notes" size={22} color="#0F62FE" />
              <Text style={styles.resultTitle}>Stream result</Text>
            </View>
            <Text style={styles.mutedText}>
              Finalized audio buffer after Stop — same pipeline buffer, ready
              for PCM playback.
            </Text>
            <View style={styles.resultStats}>
              <Text style={styles.resultStatLine}>
                {resultBuffer.sampleRate} Hz ·{' '}
                {resultBuffer.numSamples.toLocaleString()} samples
              </Text>
              <Text style={styles.resultStatLine}>
                Duration:{' '}
                {resultBuffer.sampleRate > 0
                  ? (resultBuffer.numSamples / resultBuffer.sampleRate).toFixed(
                      2
                    )
                  : '—'}{' '}
                s
              </Text>
              <Text style={styles.resultBufferId} numberOfLines={2} selectable>
                Buffer: {resultBuffer.bufferId}
              </Text>
            </View>
            <View style={styles.resultActions}>
              <Pressable
                style={[
                  styles.primaryButton,
                  styles.resultPlayButton,
                  isResultPlaying && styles.buttonDisabled,
                ]}
                onPress={() => {
                  if (isResultPlaying) {
                    return;
                  }
                  handleToggleResultPlayback().catch((err) => {
                    setError(normalizeErrorMessage(err));
                  });
                }}
                disabled={isResultPlaying}
              >
                <Ionicons name="play" size={18} color="#FFFFFF" />
                <Text style={styles.primaryButtonText}>Play</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.secondaryButton,
                  styles.resultStopButton,
                  !isResultPlaying && styles.buttonDisabled,
                ]}
                onPress={() => {
                  if (!isResultPlaying) {
                    return;
                  }
                  handleToggleResultPlayback().catch((err) => {
                    setError(normalizeErrorMessage(err));
                  });
                }}
                disabled={!isResultPlaying}
              >
                <Ionicons name="stop" size={18} color="#111827" />
                <Text style={styles.secondaryButtonText}>Stop playback</Text>
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
  bodyText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
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
    flexDirection: 'row',
    gap: 8,
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
  resultCard: {
    borderWidth: 2,
    borderColor: '#BFDBFE',
    backgroundColor: '#F8FAFF',
  },
  resultCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  resultTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  resultStats: {
    marginBottom: 14,
    gap: 4,
  },
  resultStatLine: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  resultBufferId: {
    fontSize: 11,
    lineHeight: 15,
    color: '#6B7280',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  resultActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'stretch',
  },
  resultPlayButton: {
    flex: 1,
    minWidth: 130,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  resultStopButton: {
    flex: 1,
    minWidth: 130,
  },
});
