import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { SttPipelineHandle } from 'react-native-sherpa-onnx/stt';
import {
  appendOfflineToLiveAudioBuffer,
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  releasePipelineTextBuffer,
  type LiveTextBufferRef,
} from 'react-native-sherpa-onnx/textbuffer';
import { getAudioFilesForModel } from '../../audioConfig';
import type { AudioIngressSourceMode } from '../../components/AudioIngressSourceToggle';
import {
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { StreamingAudioInputSection } from '../../components/StreamingAudioInputSection';
import { SttStreamingModelInitPanel } from '../../components/SttStreamingModelInitPanel';
import { useSttStreamingModelInit } from '../../hooks/useSttStreamingModelInit';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const STT_INPUT_SAMPLE_RATE = 16000;

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

type StreamingState = 'idle' | 'starting' | 'running' | 'stopping';

export default function STTStreamingScreen() {
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );

  const stt = useSttStreamingModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const {
    getTranscribeEngine,
    isEngineInitialized,
    engineMode,
    currentModelFolder,
    selectedModelForInit,
  } = stt;

  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [sourceMode, setSourceMode] = useState<AudioIngressSourceMode>('file');
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [status, setStatus] = useState(
    'Initialize a model, choose microphone or file input, then start streaming.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [segmentCount, setSegmentCount] = useState(0);
  const [committedTranscript, setCommittedTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');

  const pipelineRef = useRef<SttPipelineHandle | null>(null);
  const liveAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextBufferRef = useRef<LiveTextBufferRef | null>(null);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupLockRef = useRef(false);

  const audioFiles = useMemo(
    () =>
      currentModelFolder || selectedModelForInit
        ? getAudioFilesForModel(currentModelFolder ?? selectedModelForInit!)
        : [],
    [currentModelFolder, selectedModelForInit]
  );

  useEffect(() => {
    if (engineMode === 'offline') {
      setSegConfig((prev) => {
        if (prev.mode === 'off') {
          return {
            mode: 'auto',
            policy: {
              evaluator: 'speech_energy_silence',
              maxSegmentMs: 10000,
            },
          };
        }
        return prev;
      });
    }
  }, [engineMode]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const syncTranscript = useCallback(async () => {
    const textBuffer = liveTextBufferRef.current;
    if (!textBuffer) return;

    const bufferId = textBuffer.bufferId;
    const segmentCountNow = await getLiveTextBufferSegmentCount(bufferId);
    const segments =
      segmentCountNow > 0
        ? await getLiveTextBufferSegments(bufferId, 0, segmentCountNow)
        : [];
    const partial = await getLiveTextBufferPartialSlice(bufferId, 0, 4096);

    setSegmentCount(segmentCountNow);
    setCommittedTranscript(
      segments
        .map((segment) => segment.text.trim())
        .filter((segment) => segment.length > 0)
        .join(' ')
        .trim()
    );
    setPartialTranscript(partial.trim());
  }, []);

  const releasePipelineResources = useCallback(async () => {
    if (cleanupLockRef.current) {
      return;
    }
    cleanupLockRef.current = true;

    try {
      stopPolling();

      try {
        await stopMicToLiveAudioBuffer();
      } catch {
        // ignore teardown races
      }

      try {
        await pipelineRef.current?.stop();
      } catch {
        // ignore teardown races
      }
      pipelineRef.current = null;

      const textBuffer = liveTextBufferRef.current;
      liveTextBufferRef.current = null;
      if (textBuffer) {
        await releasePipelineTextBuffer(textBuffer.bufferId).catch(() => {});
      }

      const audioBuffer = liveAudioBufferRef.current;
      liveAudioBufferRef.current = null;
      if (audioBuffer) {
        await releasePipelineAudioBuffer(audioBuffer.bufferId).catch(() => {});
      }
    } finally {
      cleanupLockRef.current = false;
    }
  }, [stopPolling]);

  onBeforeInitRef.current = async () => {
    setCommittedTranscript('');
    setPartialTranscript('');
    setSegmentCount(0);
    setError(null);
    setOfflineInputBuffer(null);
    await offlineWidgetRef.current?.clear().catch(() => {});
    await releasePipelineResources();
  };

  useEffect(() => {
    return () => {
      releasePipelineResources().catch(() => {});
    };
  }, [releasePipelineResources]);

  const startStreaming = useCallback(async () => {
    if (streamingState !== 'idle') {
      return;
    }
    const engine = getTranscribeEngine();
    if (!engine) {
      setError('Initialize an STT model first (Use model).');
      return;
    }
    if (sourceMode === 'file' && !offlineInputBuffer) {
      setError('Select and decode an audio file first.');
      return;
    }

    setError(null);
    setSegmentCount(0);
    setCommittedTranscript('');
    setPartialTranscript('');
    setStreamingState('starting');

    try {
      let ringSeconds = 240;
      if (sourceMode === 'file' && offlineInputBuffer) {
        try {
          const bufInfo = await getPipelineAudioBufferInfo(
            offlineInputBuffer.bufferId
          );
          if (bufInfo && bufInfo.durationMs > 0) {
            ringSeconds = Math.max(
              120,
              Math.ceil(bufInfo.durationMs / 1000) + 30
            );
          }
        } catch {
          ringSeconds = 300;
        }
      }

      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: STT_INPUT_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds,
        retention: 'auto',
        streamEvents: { framesAppended: { enabled: false, minIntervalMs: 0 } },
      });
      liveAudioBufferRef.current = liveAudio;

      const liveText = await createLiveTextBuffer({
        streamEvents: { partial: { enabled: false, minIntervalMs: 0 } },
      });
      liveTextBufferRef.current = liveText;

      const segOpt = buildSegmentationOption(segConfig);
      const pipeline = (await engine.transcribe(
        liveAudio.bufferId,
        liveText.bufferId,
        {
          chunkSize: 3200,
          ...(segOpt && segOpt.mode !== 'off' ? { segmentation: segOpt } : {}),
        }
      )) as SttPipelineHandle;
      pipelineRef.current = pipeline;

      if (sourceMode === 'file' && offlineInputBuffer) {
        setStatus(
          `Ingesting offline buffer: ${offlineInputBuffer.sourceLabel}`
        );
        await appendOfflineToLiveAudioBuffer(
          liveAudio.bufferId,
          offlineInputBuffer.bufferId
        );
        await finalizeLiveAudioBuffer(liveAudio.bufferId);
        setStatus(
          'Streaming STT is running. Offline samples appended to the live buffer.'
        );
      } else {
        await startMicToLiveAudioBuffer(liveAudio, { emitToJs: false });
        setStatus(
          'Microphone active. Speak to transcribe; tap Stop when finished.'
        );
      }

      setStreamingState('running');

      stopPolling();
      pollTimerRef.current = setInterval(() => {
        syncTranscript().catch(() => {});
      }, 150);

      (async () => {
        try {
          await pipeline.completed;
          setStatus('Streaming transcription completed.');
        } catch (streamErr) {
          const code = (streamErr as { code?: string })?.code;
          if (code !== 'DECODE_CANCELLED') {
            setError(normalizeErrorMessage(streamErr));
            setStatus('Streaming transcription failed.');
          }
        } finally {
          await syncTranscript().catch(() => {});
          await releasePipelineResources();
          setStreamingState('idle');
        }
      })().catch(() => {});
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStreamingState('idle');
      await releasePipelineResources();
    }
  }, [
    getTranscribeEngine,
    offlineInputBuffer,
    releasePipelineResources,
    segConfig,
    sourceMode,
    stopPolling,
    streamingState,
    syncTranscript,
  ]);

  const stopStreaming = useCallback(async () => {
    if (streamingState === 'idle') {
      return;
    }
    setStreamingState('stopping');
    setStatus('Stopping streaming transcription...');
    try {
      await pipelineRef.current?.stop();
    } catch {
      // ignore stop races
    }
    await releasePipelineResources();
    setStreamingState('idle');
    setStatus('Stopped.');
  }, [releasePipelineResources, streamingState]);

  const pipelineBusy = streamingState !== 'idle';
  const engineReady = isEngineInitialized && getTranscribeEngine() != null;

  const canStart =
    streamingState === 'idle' &&
    engineReady &&
    (sourceMode === 'mic' || !!offlineInputBuffer);

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="chatbubbles-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Speech-to-Text Streaming</Text>
        </View>

        <SttStreamingModelInitPanel stt={stt} disabled={pipelineBusy} />

        {engineMode === 'offline' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Speech Segmentation</Text>
            <Text style={styles.mutedText}>
              Live Overload requires segmentation to commit speech into discrete
              chunks before transcription. The Off option is disabled.
            </Text>
            <SegmentationPolicyControls
              variant="speech-offline"
              value={segConfig}
              onChange={setSegConfig}
              disabled={pipelineBusy}
              disableOff
              offDisabledMessage="Live Overload requires mandatory segmentation to commit speech segments for transcription."
            />
          </View>
        )}

        <StreamingAudioInputSection
          sourceMode={sourceMode}
          onSourceModeChange={setSourceMode}
          audioFiles={audioFiles}
          onBufferReady={setOfflineInputBuffer}
          onBufferReleased={() => setOfflineInputBuffer(null)}
          disabled={pipelineBusy}
          widgetRef={offlineWidgetRef}
          micSampleRateHz={STT_INPUT_SAMPLE_RATE}
          decodeTargetSampleRateHz={STT_INPUT_SAMPLE_RATE}
        />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Run</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.primaryButton,
                (!canStart || pipelineBusy) && styles.buttonDisabled,
              ]}
              onPress={() => {
                startStreaming().catch(() => {});
              }}
              disabled={!canStart || pipelineBusy}
            >
              <Text style={styles.primaryButtonText}>Start streaming</Text>
            </Pressable>
            <Pressable
              style={[
                styles.secondaryButton,
                streamingState === 'idle' && styles.buttonDisabled,
              ]}
              onPress={() => {
                stopStreaming().catch(() => {});
              }}
              disabled={streamingState === 'idle'}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          </View>
          <Text style={styles.mutedText}>{status}</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Live transcript</Text>
          <Text style={styles.metricText}>Segments: {segmentCount}</Text>
          <Text style={styles.sectionLabel}>Committed</Text>
          <Text style={styles.transcriptBox} selectable>
            {committedTranscript || 'Waiting for committed segments...'}
          </Text>
          <Text style={styles.sectionLabel}>Partial</Text>
          <Text style={styles.transcriptBox} selectable>
            {partialTranscript || 'Waiting for partial text...'}
          </Text>
        </View>
      </ScrollView>

      <ScreenIntroModal screenId="STTStreaming" />
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
  mutedText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#6B7280',
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
  metricText: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 10,
  },
  sectionLabel: {
    marginTop: 6,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  transcriptBox: {
    minHeight: 72,
    borderRadius: 14,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 12,
    fontSize: 15,
    lineHeight: 22,
    color: '#111827',
  },
});
