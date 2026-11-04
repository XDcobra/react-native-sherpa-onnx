import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { SttPipelineHandle } from 'react-native-sherpa-onnx/stt';
import {
  createEmptyLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
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
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { SttStreamingModelInitPanel } from '../../components/SttStreamingModelInitPanel';
import { useSttStreamingModelInit } from '../../hooks/useSttStreamingModelInit';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';
import { styles as lpStyles } from '../live-pipeline-showcase/LivePipelineShowcaseScreen.styles';
import {
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';

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
type SourceMode = 'mic' | 'file';

export default function STTStreamingScreen() {
  const onBeforeInitRef = useRef<(() => void | Promise<void>) | undefined>(
    undefined
  );

  const stt = useSttStreamingModelInit({
    onBeforeInit: () => onBeforeInitRef.current?.(),
  });

  const { getTranscribeEngine, isEngineInitialized, engineMode } = stt;

  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });
  const [sourceMode, setSourceMode] = useState<SourceMode>('file');
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [status, setStatus] = useState(
    'Initialize a model, choose microphone or file input, then start streaming.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [committedTranscript, setCommittedTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');

  const pipelineRef = useRef<SttPipelineHandle | null>(null);
  const liveAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextBufferRef = useRef<LiveTextBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupLockRef = useRef(false);

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
        ingestHandleRef.current?.cancel();
      } catch {
        // ignore teardown races
      }
      ingestHandleRef.current = null;

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
    setProgress(null);
    setError(null);
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
    if (sourceMode === 'file' && !selectedFileUri) {
      setError('Pick an audio file first.');
      return;
    }

    setError(null);
    setProgress(null);
    setSegmentCount(0);
    setCommittedTranscript('');
    setPartialTranscript('');
    setStreamingState('starting');

    try {
      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: STT_INPUT_SAMPLE_RATE,
        channelCount: 1,
        ringSeconds: 240,
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

      let fileIngestDone: Promise<unknown> = Promise.resolve();

      if (sourceMode === 'file') {
        const source = toFileSource(
          selectedFileUri!,
          selectedFileName ?? undefined
        );
        const ingest = await ingestFileToLiveAudioBuffer(
          liveAudio.bufferId,
          source,
          {
            targetSampleRateHz: STT_INPUT_SAMPLE_RATE,
            forceMono: true,
            autoFinalize: true,
            backpressure: 'block',
            onProgress: (event) => {
              setProgress(event.percent);
              setStatus(
                `Streaming decode ${event.percent.toFixed(
                  0
                )}% • ${event.framesDecoded.toLocaleString()} frames decoded`
              );
            },
          }
        );
        ingestHandleRef.current = ingest;
        fileIngestDone = ingest.done;
        setStatus(
          'Streaming STT is running. The live buffer stays lossless while the text buffer tracks committed and partial text.'
        );
      } else {
        ingestHandleRef.current = null;
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
          if (sourceMode === 'file') {
            await Promise.all([fileIngestDone, pipeline.completed]);
          } else {
            await pipeline.completed;
          }
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
    releasePipelineResources,
    segConfig,
    selectedFileName,
    selectedFileUri,
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
    try {
      ingestHandleRef.current?.cancel();
    } catch {
      // ignore stop races
    }
    await releasePipelineResources();
    setStreamingState('idle');
    setStatus('Stopped.');
  }, [releasePipelineResources, streamingState]);

  const pickFile = useCallback(async () => {
    try {
      const [result] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (result) {
        const resolvedName =
          resolveAudioFileDisplayName(result.uri, result.name) ??
          result.name ??
          result.uri;
        setSelectedFileUri(result.uri);
        setSelectedFileName(resolvedName);
      }
    } catch (pickErr) {
      const isPickCancel =
        (DocumentPicker as any)?.isCancel?.(pickErr) ||
        (pickErr as any)?.code === 'DOCUMENT_PICKER_CANCELED' ||
        (pickErr as any)?.name === 'DocumentPickerCanceled';
      if (!isPickCancel) {
        setError(normalizeErrorMessage(pickErr));
      }
    }
  }, []);

  const clearSelectedFile = useCallback(() => {
    if (streamingState !== 'idle') {
      return;
    }
    setSelectedFileUri(null);
    setSelectedFileName(null);
    setProgress(null);
    setStatus('Audio file removed. Choose another file to continue.');
  }, [streamingState]);

  const pipelineBusy = streamingState !== 'idle';
  const engineReady = isEngineInitialized && getTranscribeEngine() != null;

  const canStart =
    streamingState === 'idle' &&
    engineReady &&
    (sourceMode === 'mic' || !!selectedFileUri);

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
            <Text style={styles.bodyText}>
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

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Input Source</Text>
          <View style={lpStyles.sourceToggle}>
            {(['mic', 'file'] as SourceMode[]).map((mode) => (
              <TouchableOpacity
                key={mode}
                style={[
                  lpStyles.sourceToggleBtn,
                  sourceMode === mode && lpStyles.sourceToggleBtnActive,
                ]}
                onPress={() => setSourceMode(mode)}
                disabled={pipelineBusy}
              >
                <Text
                  style={[
                    lpStyles.sourceToggleText,
                    sourceMode === mode && lpStyles.sourceToggleTextActive,
                  ]}
                >
                  {mode === 'mic' ? '🎤 Microphone' : '📁 File'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {sourceMode === 'file' && (
            <>
              {!selectedFileUri ? (
                <>
                  <TouchableOpacity
                    style={[
                      lpStyles.optionButton,
                      lpStyles.optionButtonAlignStart,
                      styles.inputSourcePickButton,
                    ]}
                    onPress={() => {
                      pickFile().catch(() => {});
                    }}
                    disabled={pipelineBusy}
                  >
                    <Text style={lpStyles.optionButtonText}>
                      Pick audio file…
                    </Text>
                  </TouchableOpacity>
                  <Text style={[styles.bodyText, styles.inputSourceFileHint]}>
                    No file selected yet.
                  </Text>
                </>
              ) : (
                <View
                  style={[styles.selectedFileCard, styles.inputSourceFileCard]}
                >
                  <View style={styles.selectedFileInfo}>
                    <Text style={styles.selectedFileLabel}>Selected file</Text>
                    <Text style={styles.selectedFileName} numberOfLines={2}>
                      {selectedFileName ?? selectedFileUri}
                    </Text>
                  </View>
                  <Pressable
                    style={[
                      styles.removeFileButton,
                      pipelineBusy && styles.buttonDisabled,
                    ]}
                    onPress={clearSelectedFile}
                    disabled={pipelineBusy}
                    accessibilityLabel="Remove selected audio file"
                  >
                    <Ionicons name="trash-outline" size={18} color="#B42318" />
                  </Pressable>
                </View>
              )}
            </>
          )}
          {sourceMode === 'mic' ? (
            <Text style={[styles.bodyText, styles.inputSourceMicHint]}>
              Audio is captured from the device microphone at{' '}
              {STT_INPUT_SAMPLE_RATE} Hz mono. Grant mic permission when
              prompted.
            </Text>
          ) : null}
        </View>

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
          {sourceMode === 'file' && progress != null ? (
            <Text style={styles.mutedText}>
              Decode progress: {progress.toFixed(0)}%
            </Text>
          ) : null}
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
  bodyText: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
  },
  inputSourcePickButton: {
    marginTop: 12,
  },
  inputSourceFileHint: {
    marginTop: 10,
  },
  inputSourceFileCard: {
    marginTop: 12,
  },
  inputSourceMicHint: {
    marginTop: 12,
  },
  selectedFileCard: {
    marginTop: 2,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  selectedFileInfo: {
    flex: 1,
  },
  selectedFileLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  selectedFileName: {
    fontSize: 14,
    lineHeight: 20,
    color: '#111827',
    fontWeight: '600',
  },
  removeFileButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#F4C7C3',
    backgroundColor: '#FFF5F4',
    alignItems: 'center',
    justifyContent: 'center',
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
