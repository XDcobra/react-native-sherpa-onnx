import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { listAssetModels } from 'react-native-sherpa-onnx';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type FileIngestHandle,
  type LiveAudioBufferRef,
  type OfflineAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type LiveSegmentBufferErrorEvent,
  type LiveSegmentBufferRef,
  type LiveSegmentBufferSegmentAppendedEvent,
  type OfflineSegmentBufferRef,
  type SegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import {
  createStreamingVAD,
  detectVadModel,
  type VADEngine,
  type VADPipelineHandle,
  type VADPipelineStatus,
  type VADSummary,
} from 'react-native-sherpa-onnx/vad';
import {
  listDownloadedModels,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';

type Mode = 'live' | 'offline';
type LiveSource = 'file' | 'mic';
type StreamState = 'idle' | 'starting' | 'running' | 'stopping';

type TimelineEntry = {
  id: number;
  at: string;
  type: string;
  detail: string;
};

const TIMELINE_LIMIT = 200;
const SEGMENT_PREVIEW_LIMIT = 200;

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return 'Unknown error';
}

function toFileSource(pathOrUri: string): FileSource {
  const trimmed = pathOrUri.trim();
  if (trimmed.startsWith('content://')) {
    return { kind: 'contentUri', uri: trimmed };
  }
  if (trimmed.startsWith('file://')) {
    return { kind: 'fs', path: decodeURI(trimmed.replace(/^file:\/\//, '')) };
  }
  return { kind: 'fs', path: trimmed };
}

export default function VADScreen() {
  const [mode, setMode] = useState<Mode>('live');
  const [liveSource, setLiveSource] = useState<LiveSource>('file');
  const [status, setStatus] = useState(
    'Load a model, then run VAD in live or offline mode.'
  );
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [busyOffline, setBusyOffline] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [selectedModelFolder, setSelectedModelFolder] = useState<string | null>(
    null
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const [sampleRateInput, setSampleRateInput] = useState('16000');
  const [chunkSizeInput, setChunkSizeInput] = useState('512');
  const [thresholdInput, setThresholdInput] = useState('0.5');
  const [speechEventMinInput, setSpeechEventMinInput] = useState('0');
  const [selectedLiveFileUri, setSelectedLiveFileUri] = useState<string | null>(
    null
  );
  const [selectedLiveFileName, setSelectedLiveFileName] = useState<
    string | null
  >(null);
  const [selectedOfflineFileUri, setSelectedOfflineFileUri] = useState<
    string | null
  >(null);
  const [selectedOfflineFileName, setSelectedOfflineFileName] = useState<
    string | null
  >(null);
  const [ingestProgress, setIngestProgress] = useState<number | null>(null);
  const [engineInstanceId, setEngineInstanceId] = useState<string | null>(null);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [isSpeechDetected, setIsSpeechDetected] = useState(false);
  const [pipelineStatus, setPipelineStatus] =
    useState<VADPipelineStatus | null>(null);
  const [summary, setSummary] = useState<VADSummary | null>(null);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  const liveEngineRef = useRef<VADEngine | null>(null);
  const livePipelineRef = useRef<VADPipelineHandle | null>(null);
  const liveAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegmentRef = useRef<LiveSegmentBufferRef | null>(null);
  const offlineAudioRef = useRef<OfflineAudioBufferRef | null>(null);
  const offlineSegmentRef = useRef<OfflineSegmentBufferRef | null>(null);
  const ingestRef = useRef<FileIngestHandle | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timelineIdRef = useRef(0);
  const liveUsingMicRef = useRef(false);
  const cleanupLockRef = useRef(false);

  const canStartLive =
    streamState === 'idle' &&
    !busyOffline &&
    !!selectedModelFolder &&
    (liveSource === 'mic' || !!selectedLiveFileUri);

  const canStartOffline =
    !busyOffline &&
    streamState === 'idle' &&
    !!selectedModelFolder &&
    !!selectedOfflineFileUri;

  const isBusy = streamState !== 'idle' || busyOffline;

  const pushTimeline = useCallback((type: string, detail: string) => {
    const now = new Date();
    setTimeline((prev) => {
      const next = [
        {
          id: ++timelineIdRef.current,
          at: now.toLocaleTimeString(),
          type,
          detail,
        },
        ...prev,
      ];
      return next.slice(0, TIMELINE_LIMIT);
    });
  }, []);

  const resolveModelPath = useCallback(
    (modelFolder: string) => {
      if (downloadedModelIds.includes(modelFolder)) {
        return getFileModelPath(modelFolder, ModelCategory.Vad);
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
        listDownloadedModels(ModelCategory.Vad),
      ]);
      const assetModels = assets.map((m) => m.folder);
      const downloadedIds = downloaded.map((m) => m.id);
      const candidateModels = Array.from(
        new Set([...assetModels, ...downloadedIds])
      );
      const streamingModels: string[] = [];
      for (const modelFolder of candidateModels) {
        try {
          const modelPath = downloadedIds.includes(modelFolder)
            ? getFileModelPath(modelFolder, ModelCategory.Vad)
            : getAssetModelPath(modelFolder);
          const detection = await detectVadModel(
            await toDetectSource(modelPath),
            {
              modelType: 'auto',
            }
          );
          if (detection.success && detection.isStreaming) {
            streamingModels.push(modelFolder);
          }
        } catch {
          // Ignore candidates that fail detection; keep picker clean.
        }
      }
      setDownloadedModelIds(downloadedIds);
      setAvailableModels(streamingModels);
      setSelectedModelFolder((current) =>
        current && streamingModels.includes(current)
          ? current
          : streamingModels[0] ?? null
      );
    } catch (loadErr) {
      setError(normalizeErrorMessage(loadErr));
      setStatus('Failed to load VAD models.');
    } finally {
      setLoadingModels(false);
    }
  }, []);

  const clearStatusPoll = useCallback(() => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
  }, []);

  const teardownLiveResources = useCallback(
    async (attemptStopPipeline: boolean) => {
      if (cleanupLockRef.current) return;
      cleanupLockRef.current = true;
      clearStatusPoll();
      try {
        const pipeline = livePipelineRef.current;
        if (pipeline) {
          pipeline.onSpeechStateChanged = undefined;
          if (attemptStopPipeline) {
            try {
              await pipeline.stop();
            } catch {
              // Ignore stop races during teardown.
            }
          }
        }
        livePipelineRef.current = null;

        if (ingestRef.current) {
          try {
            ingestRef.current.cancel();
          } catch {
            // Ignore cancel races.
          }
          ingestRef.current = null;
        }

        if (liveUsingMicRef.current) {
          liveUsingMicRef.current = false;
          try {
            await stopMicToLiveAudioBuffer();
          } catch {
            // Ignore stop races.
          }
        }

        const engine = liveEngineRef.current;
        liveEngineRef.current = null;
        if (engine) {
          await engine.destroy().catch(() => {});
        }

        const segment = liveSegmentRef.current;
        liveSegmentRef.current = null;
        if (segment) {
          segment.unsubscribeEvents();
          await releasePipelineSegmentBuffer(segment).catch(() => {});
        }

        const audio = liveAudioRef.current;
        liveAudioRef.current = null;
        if (audio) {
          audio.unsubscribeEvents();
          await releasePipelineAudioBuffer(audio).catch(() => {});
        }
      } finally {
        cleanupLockRef.current = false;
      }
    },
    [clearStatusPoll]
  );

  const clearOfflineBuffers = useCallback(async () => {
    const seg = offlineSegmentRef.current;
    offlineSegmentRef.current = null;
    if (seg) {
      await releasePipelineSegmentBuffer(seg).catch(() => {});
    }
    const audio = offlineAudioRef.current;
    offlineAudioRef.current = null;
    if (audio) {
      await releasePipelineAudioBuffer(audio).catch(() => {});
    }
  }, []);

  const pickLiveFile = useCallback(async () => {
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
      if (!uri) throw new Error('Could not resolve a file URI from picker.');
      setSelectedLiveFileUri(uri);
      setSelectedLiveFileName(
        file.name || uri.split('/').pop() || 'audio-file'
      );
      setStatus('Live input file selected.');
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

  const pickOfflineFile = useCallback(async () => {
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
      if (!uri) throw new Error('Could not resolve a file URI from picker.');
      setSelectedOfflineFileUri(uri);
      setSelectedOfflineFileName(
        file.name || uri.split('/').pop() || 'audio-file'
      );
      setStatus('Offline input file selected.');
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

  const startLive = useCallback(async () => {
    if (!selectedModelFolder) return;
    if (liveSource === 'file' && !selectedLiveFileUri) {
      setError('Select an audio file for live file-ingest mode.');
      return;
    }

    setError(null);
    setSummary(null);
    setSegments([]);
    setTimeline([]);
    setPipelineStatus(null);
    setIngestProgress(null);
    setIsSpeechDetected(false);
    setStreamState('starting');
    setStatus('Starting VAD live pipeline...');
    pushTimeline('run.started', 'Preparing live buffers and VAD engine.');

    try {
      const sampleRate = Math.max(
        8000,
        Number.parseInt(sampleRateInput, 10) || 16000
      );
      const chunkSize = Math.max(1, Number.parseInt(chunkSizeInput, 10) || 512);
      const threshold = Number.parseFloat(thresholdInput);
      const speechStateEventMinIntervalMs = Math.max(
        0,
        Number.parseInt(speechEventMinInput, 10) || 0
      );

      const modelPath = resolveModelPath(selectedModelFolder);
      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate,
        channelCount: 1,
      });
      liveAudioRef.current = liveAudio;

      const liveSegment = await createLiveSegmentBuffer({
        sourceAudioBufferId: liveAudio.bufferId,
        maxSegments: 2048,
        spooling: { mode: 'on' },
        streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
        onSegmentAppended: (event: LiveSegmentBufferSegmentAppendedEvent) => {
          pushTimeline(
            'segment.appended',
            `#${event.segmentIndex} ${event.startSample}-${event.endSample} (${event.durationMs}ms)`
          );
          setSegments((prev) => {
            const next: SegmentMeta = {
              id: event.segmentId,
              kind: 'speech',
              sourceAudioBufferId: event.sourceAudioBufferId,
              startSample: event.startSample,
              endSample: event.endSample,
              sampleRate: event.sampleRate,
              durationMs: event.durationMs,
              ...(typeof event.confidence === 'number'
                ? { confidence: event.confidence }
                : {}),
              ...(event.payload ? { payload: event.payload } : {}),
            };
            const merged = [...prev, next];
            return merged.slice(-SEGMENT_PREVIEW_LIMIT);
          });
        },
        onError: (event: LiveSegmentBufferErrorEvent) => {
          pushTimeline('segment.error', event.message);
          setError(event.message);
        },
      });
      liveSegmentRef.current = liveSegment;

      const engine = await createStreamingVAD({
        modelPath,
        modelType: 'auto',
        sampleRate,
        threshold: Number.isFinite(threshold) ? threshold : undefined,
      });
      liveEngineRef.current = engine;
      setEngineInstanceId(engine.instanceId);

      const run = await engine.process({
        audioIn: liveAudio,
        segmentOut: liveSegment,
        options: {
          chunkSize,
          autoFlushOnInputEnded: false,
          speechStateEventMinIntervalMs,
        },
      });
      if (!('pipelineId' in run)) {
        throw new Error(
          'Expected live pipeline handle but got offline result.'
        );
      }
      livePipelineRef.current = run;
      setPipelineId(run.pipelineId);
      pushTimeline('pipeline.ready', run.pipelineId);

      run.onSpeechStateChanged = (event) => {
        setIsSpeechDetected(event.isSpeechDetected);
        pushTimeline(
          'speech.stateChanged',
          `detected=${String(event.isSpeechDetected)}`
        );
      };

      statusPollRef.current = setInterval(() => {
        const pipeline = livePipelineRef.current;
        if (!pipeline) return;
        pipeline
          .getStatus()
          .then((s) => {
            setPipelineStatus(s);
          })
          .catch(() => {});
      }, 600);

      if (liveSource === 'file' && selectedLiveFileUri) {
        const ingest = await ingestFileToLiveAudioBuffer(
          liveAudio,
          toFileSource(selectedLiveFileUri),
          {
            autoFinalize: true,
            onProgress: (event) => {
              setIngestProgress(event.percent);
            },
          }
        );
        ingestRef.current = ingest;
        ingest.done
          .then(() => {
            pushTimeline('ingest.completed', 'Live input file fully appended.');
            setStatus(
              'File ingest finished. Use "Finish" to flush and complete.'
            );
          })
          .catch((ingestErr) => {
            setError(normalizeErrorMessage(ingestErr));
            pushTimeline('ingest.error', normalizeErrorMessage(ingestErr));
          });
      } else {
        await startMicToLiveAudioBuffer(liveAudio);
        liveUsingMicRef.current = true;
        setStatus(
          'Microphone capture active. Speak, then press Finish or Stop.'
        );
        pushTimeline('mic.started', 'Live mic capture started.');
      }

      setStreamState('running');
      setStatus((prev) =>
        prev.startsWith('Microphone')
          ? prev
          : 'Live VAD running. Watch speech and segment events.'
      );
    } catch (startErr) {
      const message = normalizeErrorMessage(startErr);
      setError(message);
      setStatus('Live VAD failed to start.');
      pushTimeline('run.error', message);
      await teardownLiveResources(true);
      setStreamState('idle');
      setEngineInstanceId(null);
      setPipelineId(null);
    }
  }, [
    chunkSizeInput,
    liveSource,
    pushTimeline,
    resolveModelPath,
    sampleRateInput,
    selectedLiveFileUri,
    selectedModelFolder,
    speechEventMinInput,
    teardownLiveResources,
    thresholdInput,
  ]);

  const finishLive = useCallback(async () => {
    const pipeline = livePipelineRef.current;
    if (!pipeline || streamState !== 'running') return;
    setError(null);
    setStatus('Flushing live pipeline...');
    pushTimeline('run.flush.requested', 'Calling pipeline.flush()');
    try {
      await pipeline.flush();
      const result = await pipeline.completed;
      setSummary(result);
      pushTimeline(
        'run.completed',
        `segments=${result.segmentCount}, speechMs=${result.speechDurationMs}`
      );

      const segBuffer = liveSegmentRef.current;
      if (segBuffer) {
        const count = await getLiveSegmentBufferSegmentCount(segBuffer);
        const all =
          count > 0
            ? await getLiveSegmentBufferSegments(segBuffer, 0, count)
            : [];
        setSegments(all.slice(-SEGMENT_PREVIEW_LIMIT));
      }

      setStatus('Live run completed successfully.');
      await teardownLiveResources(false);
      setStreamState('idle');
      setPipelineStatus(null);
      setEngineInstanceId(null);
      setPipelineId(null);
    } catch (finishErr) {
      const message = normalizeErrorMessage(finishErr);
      setError(message);
      setStatus('Live run completion failed.');
      pushTimeline('run.error', message);
      await teardownLiveResources(true);
      setStreamState('idle');
      setPipelineStatus(null);
      setEngineInstanceId(null);
      setPipelineId(null);
    }
  }, [pushTimeline, streamState, teardownLiveResources]);

  const stopLive = useCallback(async () => {
    if (streamState === 'idle') return;
    setStreamState('stopping');
    setStatus('Stopping live pipeline...');
    pushTimeline('run.stop.requested', 'Stopping active live pipeline.');
    await teardownLiveResources(true);
    setStreamState('idle');
    setPipelineStatus(null);
    setEngineInstanceId(null);
    setPipelineId(null);
    setStatus('Live run stopped.');
  }, [pushTimeline, streamState, teardownLiveResources]);

  const runOffline = useCallback(async () => {
    if (!selectedModelFolder || !selectedOfflineFileUri) return;
    setBusyOffline(true);
    setError(null);
    setSummary(null);
    setSegments([]);
    setTimeline([]);
    setPipelineStatus(null);
    setIsSpeechDetected(false);
    setStatus('Running offline VAD...');
    pushTimeline('run.started', 'Preparing offline buffers and VAD engine.');
    try {
      const sampleRate = Math.max(
        8000,
        Number.parseInt(sampleRateInput, 10) || 16000
      );
      const chunkSize = Math.max(1, Number.parseInt(chunkSizeInput, 10) || 512);
      const threshold = Number.parseFloat(thresholdInput);
      const modelPath = resolveModelPath(selectedModelFolder);
      const audio = await createOfflineAudioBufferFromFile(
        toFileSource(selectedOfflineFileUri)
      );
      offlineAudioRef.current = audio;
      const segment = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: audio.bufferId,
      });
      offlineSegmentRef.current = segment;

      const engine = await createStreamingVAD({
        modelPath,
        modelType: 'auto',
        sampleRate,
        threshold: Number.isFinite(threshold) ? threshold : undefined,
      });
      const run = await engine.process({
        audioIn: audio,
        segmentOut: segment,
        options: { chunkSize },
      });
      if (!('summary' in run)) {
        throw new Error('Expected offline VAD result but got live handle.');
      }
      setSummary(run.summary);
      pushTimeline(
        'run.completed',
        `segments=${run.summary.segmentCount}, speechMs=${run.summary.speechDurationMs}`
      );
      const all =
        run.summary.segmentCount > 0
          ? await getOfflineSegmentBufferSegments(
              segment,
              0,
              run.summary.segmentCount
            )
          : [];
      setSegments(all.slice(-SEGMENT_PREVIEW_LIMIT));

      await engine.destroy();
      await clearOfflineBuffers();
      setStatus('Offline run completed successfully.');
    } catch (offlineErr) {
      const message = normalizeErrorMessage(offlineErr);
      setError(message);
      setStatus('Offline run failed.');
      pushTimeline('run.error', message);
      await clearOfflineBuffers();
    } finally {
      setBusyOffline(false);
    }
  }, [
    chunkSizeInput,
    clearOfflineBuffers,
    pushTimeline,
    resolveModelPath,
    sampleRateInput,
    selectedModelFolder,
    selectedOfflineFileUri,
    thresholdInput,
  ]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const snippet = useMemo(
    () => `const vad = await createStreamingVAD({ modelPath, modelType: 'auto', sampleRate: 16000 });
const segmentOut = await createLiveSegmentBuffer({
  streamEvents: { segmentAppended: { enabled: true, minIntervalMs: 0 } },
  onSegmentAppended: (e) => console.log(e.segmentIndex, e.durationMs),
});
const pipeline = await vad.process({
  audioIn,
  segmentOut,
  options: { chunkSize: 512, speechStateEventMinIntervalMs: 0 },
});
pipeline.onSpeechStateChanged = (e) => console.log(e.isSpeechDetected);
await pipeline.flush();
const summary = await pipeline.completed;`,
    []
  );

  useEffect(() => {
    loadModels().catch(() => {});
  }, [loadModels]);

  useEffect(() => {
    return () => {
      (async () => {
        await teardownLiveResources(true);
        await clearOfflineBuffers();
      })().catch(() => {});
    };
  }, [clearOfflineBuffers, teardownLiveResources]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <Ionicons name="pulse-outline" size={20} color="#0F62FE" />
          </View>
          <Text style={styles.headerTitle}>Voice Activity Detection</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Intro</Text>
          <Text style={styles.description}>
            Standalone VAD showcase with live pipeline and deterministic offline
            run. SegmentBuffer is the primary output contract.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Mode</Text>
          <View style={styles.toggleRow}>
            <Pressable
              style={[
                styles.toggleChip,
                mode === 'live' && styles.toggleChipActive,
              ]}
              onPress={() => setMode('live')}
              disabled={isBusy}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  mode === 'live' && styles.toggleChipTextActive,
                ]}
              >
                Live
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.toggleChip,
                mode === 'offline' && styles.toggleChipActive,
              ]}
              onPress={() => setMode('offline')}
              disabled={isBusy}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  mode === 'offline' && styles.toggleChipTextActive,
                ]}
              >
                Offline
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Engine config</Text>
          {loadingModels ? (
            <View style={styles.inlineRow}>
              <ActivityIndicator />
              <Text style={styles.mutedText}>
                Detecting available VAD models...
              </Text>
            </View>
          ) : availableModels.length === 0 ? (
            <Text style={styles.warningText}>
              No streaming VAD model found. Download one from Downloadmanager
              first.
            </Text>
          ) : (
            <View style={styles.modelList}>
              {availableModels.map((model) => {
                const selected = selectedModelFolder === model;
                return (
                  <Pressable
                    key={model}
                    style={[
                      styles.modelChip,
                      selected && styles.modelChipActive,
                    ]}
                    onPress={() => setSelectedModelFolder(model)}
                    disabled={isBusy}
                  >
                    <Text
                      style={[
                        styles.modelChipText,
                        selected && styles.modelChipTextActive,
                      ]}
                    >
                      {getModelDisplayName(model)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>sampleRate: {sampleRateInput}</Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setSampleRateInput((prev) =>
                  prev === '16000' ? '8000' : '16000'
                )
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>chunkSize: {chunkSizeInput}</Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setChunkSizeInput((prev) => (prev === '512' ? '320' : '512'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>threshold: {thresholdInput}</Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setThresholdInput((prev) => (prev === '0.5' ? '0.35' : '0.5'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <View style={styles.inlineRowWrap}>
            <Text style={styles.inputLabel}>
              speechStateEventMinIntervalMs: {speechEventMinInput}
            </Text>
            <Pressable
              style={styles.smallButton}
              onPress={() =>
                setSpeechEventMinInput((prev) => (prev === '0' ? '120' : '0'))
              }
              disabled={isBusy}
            >
              <Text style={styles.smallButtonText}>Toggle</Text>
            </Pressable>
          </View>
          <Pressable
            style={[styles.secondaryButton, isBusy && styles.buttonDisabled]}
            disabled={isBusy}
            onPress={() => {
              loadModels().catch(() => {});
            }}
          >
            <Text style={styles.secondaryButtonText}>Reload model list</Text>
          </Pressable>
        </View>

        {mode === 'live' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input / output setup (Live)</Text>
            <View style={styles.toggleRow}>
              <Pressable
                style={[
                  styles.toggleChip,
                  liveSource === 'file' && styles.toggleChipActive,
                ]}
                onPress={() => setLiveSource('file')}
                disabled={streamState !== 'idle'}
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    liveSource === 'file' && styles.toggleChipTextActive,
                  ]}
                >
                  File ingest
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.toggleChip,
                  liveSource === 'mic' && styles.toggleChipActive,
                ]}
                onPress={() => setLiveSource('mic')}
                disabled={streamState !== 'idle'}
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    liveSource === 'mic' && styles.toggleChipTextActive,
                  ]}
                >
                  Microphone
                </Text>
              </Pressable>
            </View>

            {liveSource === 'file' ? (
              <>
                <Pressable
                  style={[
                    styles.secondaryButton,
                    streamState !== 'idle' && styles.buttonDisabled,
                  ]}
                  onPress={() => {
                    pickLiveFile().catch(() => {});
                  }}
                  disabled={streamState !== 'idle'}
                >
                  <Text style={styles.secondaryButtonText}>
                    Pick live input file
                  </Text>
                </Pressable>
                <Text style={styles.mutedText}>
                  {selectedLiveFileName ?? 'No file selected'}
                </Text>
                {typeof ingestProgress === 'number' ? (
                  <Text style={styles.mutedText}>
                    Ingest progress: {ingestProgress}%
                  </Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.mutedText}>
                Mic mode captures directly into LiveAudioBuffer when starting.
              </Text>
            )}

            <View style={styles.actionRow}>
              <Pressable
                style={[
                  styles.primaryButton,
                  !canStartLive && styles.buttonDisabled,
                ]}
                onPress={() => {
                  startLive().catch(() => {});
                }}
                disabled={!canStartLive}
              >
                <Text style={styles.primaryButtonText}>Start Live</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.primaryButton,
                  streamState !== 'running' && styles.buttonDisabled,
                ]}
                onPress={() => {
                  finishLive().catch(() => {});
                }}
                disabled={streamState !== 'running'}
              >
                <Text style={styles.primaryButtonText}>Finish</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.dangerButton,
                  streamState === 'idle' && styles.buttonDisabled,
                ]}
                onPress={() => {
                  stopLive().catch(() => {});
                }}
                disabled={streamState === 'idle'}
              >
                <Text style={styles.primaryButtonText}>Stop</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Input / output setup (Offline)</Text>
            <Pressable
              style={[
                styles.secondaryButton,
                busyOffline && styles.buttonDisabled,
              ]}
              onPress={() => {
                pickOfflineFile().catch(() => {});
              }}
              disabled={busyOffline}
            >
              <Text style={styles.secondaryButtonText}>
                Pick offline input file
              </Text>
            </Pressable>
            <Text style={styles.mutedText}>
              {selectedOfflineFileName ?? 'No file selected'}
            </Text>
            <Pressable
              style={[
                styles.primaryButton,
                !canStartOffline && styles.buttonDisabled,
              ]}
              onPress={() => {
                runOffline().catch(() => {});
              }}
              disabled={!canStartOffline}
            >
              <Text style={styles.primaryButtonText}>Run Offline VAD</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Runtime status</Text>
          <Text style={styles.monoText}>state: {streamState}</Text>
          <Text style={styles.monoText}>engine: {engineInstanceId ?? '-'}</Text>
          <Text style={styles.monoText}>pipeline: {pipelineId ?? '-'}</Text>
          <Text style={styles.monoText}>
            speechDetected: {isSpeechDetected ? 'true' : 'false'}
          </Text>
          <Text style={styles.monoText}>
            isRunning: {String(pipelineStatus?.isRunning)}
          </Text>
          <Text style={styles.monoText}>
            isFlushing: {String(pipelineStatus?.isFlushing)}
          </Text>
          <Text style={styles.monoText}>
            queueDepth: {pipelineStatus?.queueDepth ?? 0}
          </Text>
          <Text style={styles.monoText}>
            chunksProcessed:{' '}
            {pipelineStatus?.chunksProcessed ?? summary?.chunksProcessed ?? 0}
          </Text>
          <Text style={styles.monoText}>
            unitsRead: {pipelineStatus?.unitsRead ?? summary?.unitsRead ?? 0}
          </Text>
          <Text style={styles.monoText}>
            unitsWritten:{' '}
            {pipelineStatus?.unitsWritten ?? summary?.unitsWritten ?? 0}
          </Text>
          {summary ? (
            <Text style={styles.monoText}>
              summary: segments={summary.segmentCount}, speechMs=
              {summary.speechDurationMs}
            </Text>
          ) : null}
          <Text style={styles.statusText}>{status}</Text>
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable style={styles.smallButton} onPress={clearError}>
                <Text style={styles.smallButtonText}>Clear Error</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Event timeline</Text>
          {timeline.length === 0 ? (
            <Text style={styles.mutedText}>No events yet.</Text>
          ) : (
            timeline.map((item) => (
              <View key={item.id} style={styles.timelineRow}>
                <Text style={styles.timelineTime}>{item.at}</Text>
                <View style={styles.timelineBody}>
                  <Text style={styles.timelineType}>{item.type}</Text>
                  <Text style={styles.timelineDetail}>{item.detail}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Segment results ({segments.length})
          </Text>
          {segments.length === 0 ? (
            <Text style={styles.mutedText}>No segments yet.</Text>
          ) : (
            segments.map((segment, idx) => (
              <View key={`${segment.id}_${idx}`} style={styles.segmentRow}>
                <Text style={styles.segmentTitle}>
                  #{idx} {segment.id}
                </Text>
                <Text style={styles.segmentMeta}>
                  {segment.startSample}-{segment.endSample} (
                  {segment.durationMs}ms)
                </Text>
                <Text style={styles.segmentMeta}>
                  sampleRate={segment.sampleRate}
                </Text>
                {typeof segment.confidence === 'number' ? (
                  <Text style={styles.segmentMeta}>
                    confidence={segment.confidence.toFixed(3)}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Minimal integration snippet</Text>
          <Text style={styles.snippetText}>{snippet}</Text>
        </View>
      </ScrollView>
      <ScreenIntroModal screenId="VAD" />
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
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#EAF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#111827',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 10,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  description: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  toggleChipActive: {
    backgroundColor: '#0F62FE',
    borderColor: '#0F62FE',
  },
  toggleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1F2937',
  },
  toggleChipTextActive: {
    color: '#FFFFFF',
  },
  modelList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modelChip: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#FFFFFF',
  },
  modelChipActive: {
    backgroundColor: '#EAF2FF',
    borderColor: '#0F62FE',
  },
  modelChipText: {
    fontSize: 13,
    color: '#1F2937',
  },
  modelChipTextActive: {
    color: '#0F62FE',
    fontWeight: '600',
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inlineRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inputLabel: {
    flex: 1,
    fontSize: 13,
    color: '#374151',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: '#0F62FE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    backgroundColor: '#D92D20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  smallButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  monoText: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#111827',
  },
  statusText: {
    fontSize: 13,
    color: '#374151',
    marginTop: 4,
  },
  mutedText: {
    fontSize: 13,
    color: '#6B7280',
  },
  warningText: {
    fontSize: 13,
    color: '#92400E',
  },
  errorBox: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    padding: 10,
    gap: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#991B1B',
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E7EB',
  },
  timelineTime: {
    width: 74,
    fontSize: 11,
    color: '#6B7280',
  },
  timelineBody: {
    flex: 1,
    gap: 2,
  },
  timelineType: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1F2937',
  },
  timelineDetail: {
    fontSize: 12,
    color: '#4B5563',
  },
  segmentRow: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    padding: 10,
    gap: 2,
  },
  segmentTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  segmentMeta: {
    fontSize: 12,
    color: '#4B5563',
  },
  snippetText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
    color: '#111827',
  },
});
