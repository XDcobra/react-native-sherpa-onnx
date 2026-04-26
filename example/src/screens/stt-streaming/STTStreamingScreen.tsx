import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createStreamingSTT,
  detectSttModel,
  type LiveSttEngine,
  type SttPipelineHandle,
} from 'react-native-sherpa-onnx/stt';
import {
  createEmptyLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
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
import { listAssetModels } from 'react-native-sherpa-onnx';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';

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

function toFileSource(input: string): FileSource {
  const value = input.trim();
  if (value.startsWith('content://')) {
    return { kind: 'contentUri', uri: value };
  }
  if (value.startsWith('file://')) {
    return { kind: 'fs', path: decodeURI(value.replace(/^file:\/\//, '')) };
  }
  return { kind: 'fs', path: value };
}

type StreamingState = 'idle' | 'starting' | 'running' | 'stopping';

export default function STTStreamingScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [selectedFileUri, setSelectedFileUri] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [status, setStatus] = useState(
    'Select a model and a long file, then stream it through live buffers.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [committedTranscript, setCommittedTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');

  const engineRef = useRef<LiveSttEngine | null>(null);
  const pipelineRef = useRef<SttPipelineHandle | null>(null);
  const liveAudioBufferRef = useRef<LiveAudioBufferRef | null>(null);
  const liveTextBufferRef = useRef<LiveTextBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupLockRef = useRef(false);

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Stt);
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
        listDownloadedModels(ModelCategory.Stt),
      ]);
      const assetModels = assets
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const downloadedIds = downloaded.map((model) => model.id);

      const candidateModels = Array.from(
        new Set([...assetModels, ...downloadedIds])
      );
      const streamingModelsRaw = await Promise.all(
        candidateModels.map(async (modelFolder) => {
          try {
            const modelPath = downloadedIds.includes(modelFolder)
              ? getFileModelPath(modelFolder, ModelCategory.Stt)
              : getAssetModelPath(modelFolder);
            const detection = await detectSttModel(
              await toDetectSource(modelPath),
              {
                modelType: 'auto',
              }
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
          'No streaming STT models found. Install/download a streaming model to use this screen.'
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
      if (category === ModelCategory.Stt) {
        loadModels().catch(() => {});
      }
    });
    return unsubscribe;
  }, [loadModels]);

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

  const cleanupStream = useCallback(async () => {
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

      try {
        await engineRef.current?.destroy();
      } catch {
        // ignore teardown races
      }
      engineRef.current = null;

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

  const startStreaming = useCallback(async () => {
    if (streamingState !== 'idle') {
      return;
    }
    if (!selectedModelFolder) {
      setError('Select an STT model first.');
      return;
    }
    if (!selectedFileUri) {
      setError('Pick a long audio file first.');
      return;
    }

    setError(null);
    setProgress(null);
    setSegmentCount(0);
    setCommittedTranscript('');
    setPartialTranscript('');
    setStreamingState('starting');

    try {
      const modelPath = resolveModelPath(selectedModelFolder);
      const detectSource = await toDetectSource(modelPath);
      const detection = await detectSttModel(detectSource, {
        modelType: 'auto',
      });
      if (!detection.success) {
        throw new Error(detection.error ?? 'STT model detection failed');
      }
      if (!detection.isStreaming) {
        throw new Error(
          'This STT model is offline-only. Pick a streaming STT model for this screen.'
        );
      }

      const engine = await createStreamingSTT({
        modelPath,
        modelType: 'auto',
        numThreads: 2,
      });
      engineRef.current = engine;

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

      const pipeline = await engine.transcribe(
        liveAudio.bufferId,
        liveText.bufferId,
        {
          chunkSize: 3200,
        }
      );
      pipelineRef.current = pipeline;

      const source = toFileSource(selectedFileUri);
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

      setStreamingState('running');
      setStatus(
        'Streaming STT is running. The live buffer stays lossless while the text buffer tracks committed and partial text.'
      );

      stopPolling();
      pollTimerRef.current = setInterval(() => {
        syncTranscript().catch(() => {
          // ignore polling races during teardown
        });
      }, 150);

      void (async () => {
        try {
          await Promise.all([ingest.done, pipeline.completed]);
          setStatus('Streaming transcription completed.');
        } catch (streamErr) {
          setError(normalizeErrorMessage(streamErr));
          setStatus('Streaming transcription failed.');
        } finally {
          await syncTranscript().catch(() => {});
          await cleanupStream();
          setStreamingState('idle');
        }
      })();
    } catch (startErr) {
      setError(normalizeErrorMessage(startErr));
      setStreamingState('idle');
      await cleanupStream();
    }
  }, [
    cleanupStream,
    resolveModelPath,
    selectedFileUri,
    selectedModelFolder,
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
    await cleanupStream();
    setStreamingState('idle');
    setStatus('Stopped.');
  }, [cleanupStream, streamingState]);

  const pickFile = useCallback(async () => {
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri =
        file.uri ??
        (file as any).fileCopyUri ??
        (file as any).localUri ??
        (file as any).nativeUri;
      if (!uri) {
        throw new Error('Could not resolve a file URI from the picker result.');
      }
      setSelectedFileUri(uri);
      setSelectedFileName(file.name || uri.split('/').pop() || 'audio-file');
    } catch (pickErr: any) {
      const isCancel =
        (DocumentPicker as any)?.isCancel?.(pickErr) ||
        pickErr?.code === 'DOCUMENT_PICKER_CANCELED' ||
        pickErr?.name === 'DocumentPickerCanceled';
      if (!isCancel) {
        Alert.alert('File pick error', normalizeErrorMessage(pickErr));
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

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="chatbubbles-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Speech-to-Text Streaming</Text>
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
          <Text style={styles.cardTitle}>Source</Text>
          {!selectedFileUri ? (
            <>
              <Pressable
                style={styles.primaryButton}
                onPress={() => void pickFile()}
              >
                <Text style={styles.primaryButtonText}>Choose audio file</Text>
              </Pressable>
              <Text style={styles.bodyText}>No file selected yet.</Text>
            </>
          ) : (
            <View style={styles.selectedFileCard}>
              <View style={styles.selectedFileInfo}>
                <Text style={styles.selectedFileLabel}>Selected file</Text>
                <Text style={styles.selectedFileName} numberOfLines={2}>
                  {selectedFileName ?? selectedFileUri}
                </Text>
              </View>
              <Pressable
                style={[
                  styles.removeFileButton,
                  streamingState !== 'idle' && styles.buttonDisabled,
                ]}
                onPress={clearSelectedFile}
                disabled={streamingState !== 'idle'}
                accessibilityLabel="Remove selected audio file"
              >
                <Ionicons name="trash-outline" size={18} color="#B42318" />
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Run</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[
                styles.primaryButton,
                streamingState !== 'idle' && styles.buttonDisabled,
              ]}
              onPress={() => void startStreaming()}
              disabled={streamingState !== 'idle'}
            >
              <Text style={styles.primaryButtonText}>Start streaming</Text>
            </Pressable>
            <Pressable
              style={[
                styles.secondaryButton,
                streamingState === 'idle' && styles.buttonDisabled,
              ]}
              onPress={() => void stopStreaming()}
              disabled={streamingState === 'idle'}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          </View>
          <Text style={styles.mutedText}>{status}</Text>
          {progress != null ? (
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
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
    color: '#374151',
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
