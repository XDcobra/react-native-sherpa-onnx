import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import Clipboard from '@react-native-clipboard/clipboard';
import * as DocumentPicker from '@react-native-documents/picker';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../../utils/decodableAudioPickerTypes';
import {
  createStreamingDiarization,
  detectDiarizationModel,
  type DiarizationPipelineHandle,
  type StreamingDiarizationEngine,
} from 'react-native-sherpa-onnx/diarization';
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
  createLiveSegmentBuffer,
  releasePipelineSegmentBuffer,
  type LiveSegmentBufferRef,
  type LiveSegmentBufferSegmentAppendedEvent,
} from 'react-native-sherpa-onnx/segmentbuffer';
import type { StreamingPipelineStatus } from 'react-native-sherpa-onnx/audiobuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  InitModeSelector,
  ModelFolderGrid,
  type ModelInitMode,
} from '../../components/modelInit';
import {
  DiarizationStreamingCustomInitForm,
  type DiarizationStreamingCustomInitFormState,
} from '../../components/modelInit/DiarizationStreamingCustomInitForm';
import {
  loadDiarizationStreamingModelCatalog,
  getDiarizationStreamingModelPathConfig,
  type DiarizationStreamingCatalogSnapshot,
} from '../../utils/diarizationStreamingModelCatalog';
import { fillDiarizationStreamingCustomConfigFromModelFolder } from '../../utils/diarizationCustomInitFill';
import { DIARIZATION_AUDIO_FILES } from '../../audioConfig';
import {
  fileSourceFromBundledPath,
  toFileSource,
} from '../../utils/fileSourceFromUri';
import {
  SPEAKER_BG_COLORS,
  SPEAKER_COLORS,
  styles,
} from './DiarizationStreamingScreen.styles';

const DEFAULT_SORTFORMER_MODEL = 'diar_streaming_sortformer_4spk-v2.1';
const CHUNK_SIZE_OPTIONS = [1024, 2048, 4096, 8192] as const;

export type SpeakerTurn = {
  id: string;
  speaker: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  startSample: number;
  endSample: number;
};

export type EventLogItem = {
  id: string;
  time: string;
  message: string;
};

function formatTime(sec: number): string {
  if (isNaN(sec) || sec < 0) return '00:00.00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toFixed(2).padStart(5, '0');
  return `${mStr}:${sStr}`;
}

function formatDuration(sec: number): string {
  if (isNaN(sec) || sec < 0) return '0.00s';
  return `${sec.toFixed(2)}s`;
}

export default function DiarizationStreamingScreen() {
  // Model catalog & selection
  const [catalog, setCatalog] =
    useState<DiarizationStreamingCatalogSnapshot | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string>(
    DEFAULT_SORTFORMER_MODEL
  );
  const [initMode, setInitMode] = useState<ModelInitMode>('auto');
  const [customFormState, setCustomFormState] =
    useState<DiarizationStreamingCustomInitFormState>({ fileSources: {} });
  const [customFillLoading, setCustomFillLoading] = useState(false);
  const [customFillHint, setCustomFillHint] = useState<string | null>(null);

  // Parameter tuning controls
  const [tuningExpanded, setTuningExpanded] = useState(false);
  const [onset, setOnset] = useState(0.5);
  const [offset, setOffset] = useState(0.5);
  const [minDurationOff, setMinDurationOff] = useState(0.5);
  const [minDurationOn, setMinDurationOn] = useState(0.0);
  const [chunkSize, setChunkSize] = useState<number>(4096);

  // Engine lifecycle
  const engineRef = useRef<StreamingDiarizationEngine | null>(null);
  const [engineInfo, setEngineInfo] = useState<{
    instanceId: string;
    sampleRate: number;
    maxSpeakers: number;
    feedSamples: number;
    strideSamples: number;
    latencySeconds: number;
  } | null>(null);
  const [engineInitBusy, setEngineInitBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio ingress selection
  const [sourceMode, setSourceMode] = useState<'preset' | 'file' | 'mic'>(
    'preset'
  );
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0);
  const [customFileUri, setCustomFileUri] = useState<string | null>(null);
  const [customFileName, setCustomFileName] = useState<string | null>(null);
  const [ingestProgress, setIngestProgress] = useState<number | null>(null);

  // Streaming pipeline lifecycle
  const [streamState, setStreamState] = useState<
    'idle' | 'starting' | 'running' | 'stopping'
  >('idle');
  const pipelineRef = useRef<DiarizationPipelineHandle | null>(null);
  const liveAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegRef = useRef<LiveSegmentBufferRef | null>(null);
  const ingestHandleRef = useRef<FileIngestHandle | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active Speaker HUD & Aliases
  const [activeSpeaker, setActiveSpeaker] = useState<number | null>(null);
  const activeSpeakerResetTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [speakerAliases, setSpeakerAliases] = useState<Record<number, string>>({
    0: 'Speaker 0',
    1: 'Speaker 1',
    2: 'Speaker 2',
    3: 'Speaker 3',
  });

  // Timeline & Analytics
  const [turns, setTurns] = useState<SpeakerTurn[]>([]);
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [pipelineStatus, setPipelineStatus] =
    useState<StreamingPipelineStatus | null>(null);
  const [events, setEvents] = useState<EventLogItem[]>([]);

  const appendEvent = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [
      { id: `${Date.now()}_${Math.random()}`, time, message },
      ...prev.slice(0, 49),
    ]);
  }, []);

  // Load model catalog
  const reloadCatalog = useCallback(async () => {
    try {
      const snap = await loadDiarizationStreamingModelCatalog();
      setCatalog(snap);
      if (
        snap.entries.length > 0 &&
        !snap.entries.some((e) => e.id === selectedCatalogId)
      ) {
        setSelectedCatalogId(snap.entries[0]?.id ?? DEFAULT_SORTFORMER_MODEL);
      }
    } catch (e) {
      appendEvent(
        `Catalog load error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [appendEvent, selectedCatalogId]);

  useEffect(() => {
    reloadCatalog().catch(() => {});
  }, [reloadCatalog]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (activeSpeakerResetTimer.current)
        clearTimeout(activeSpeakerResetTimer.current);
      const pipe = pipelineRef.current;
      pipelineRef.current = null;
      pipe?.stop().catch(() => {});
      const eng = engineRef.current;
      engineRef.current = null;
      eng?.release().catch(() => {});
    };
  }, []);

  // Fill custom config from selected catalog folder
  const handleFillCustomConfig = useCallback(async () => {
    if (!catalog) return;
    setCustomFillLoading(true);
    setCustomFillHint(null);
    try {
      const source = getDiarizationStreamingModelPathConfig(selectedCatalogId, {
        padModelIds: catalog.padModelIds,
        padModelsPath: catalog.padModelsPath,
        bundledFolders: catalog.bundledFolders,
        downloadedIds: new Set(catalog.downloadedIds),
      });
      const res = await fillDiarizationStreamingCustomConfigFromModelFolder(
        source
      );
      setCustomFormState({ fileSources: res.customConfig });
      setCustomFillHint(`Filled paths from ${selectedCatalogId}`);
      appendEvent(`Filled custom paths from ${selectedCatalogId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCustomFillHint(`Fill failed: ${msg}`);
      appendEvent(`Custom fill failed: ${msg}`);
    } finally {
      setCustomFillLoading(false);
    }
  }, [appendEvent, catalog, selectedCatalogId]);

  // Initialize or reload engine
  const initEngine = useCallback(async () => {
    setError(null);
    setEngineInitBusy(true);
    try {
      if (engineRef.current) {
        await engineRef.current.release().catch(() => {});
        engineRef.current = null;
        setEngineInfo(null);
      }

      let engine: StreamingDiarizationEngine;
      if (initMode === 'auto') {
        if (!catalog) throw new Error('Catalog is not loaded yet');
        const source = getDiarizationStreamingModelPathConfig(
          selectedCatalogId,
          {
            padModelIds: catalog.padModelIds,
            padModelsPath: catalog.padModelsPath,
            bundledFolders: catalog.bundledFolders,
            downloadedIds: new Set(catalog.downloadedIds),
          }
        );

        // Verify detection
        const det = await detectDiarizationModel(source);
        if (!det.success || !det.isStreaming) {
          throw new Error(
            `Model ${selectedCatalogId} is not a valid streaming diarization model: ${
              det.error ?? 'Unknown'
            }`
          );
        }

        engine = await createStreamingDiarization({
          modelSource: source,
          modelType: 'sortformer',
          onset,
          offset,
          minDurationOff,
          minDurationOn,
        });
      } else {
        if (!customFormState.fileSources.model) {
          throw new Error('Custom config requires a valid model file (.onnx)');
        }
        engine = await createStreamingDiarization({
          initMode: 'custom',
          modelType: 'sortformer',
          customConfig: {
            model: customFormState.fileSources.model,
            metadata: customFormState.fileSources.metadata,
          },
          onset,
          offset,
          minDurationOff,
          minDurationOn,
        });
      }

      engineRef.current = engine;
      setEngineInfo({
        instanceId: engine.instanceId,
        sampleRate: engine.sampleRate,
        maxSpeakers: engine.maxSpeakers,
        feedSamples: engine.feedSamples,
        strideSamples: engine.strideSamples,
        latencySeconds: engine.latencySeconds,
      });
      appendEvent(
        `Engine initialized (SR=${engine.sampleRate}, Speakers=${engine.maxSpeakers})`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      appendEvent(`Engine init error: ${msg}`);
    } finally {
      setEngineInitBusy(false);
    }
  }, [
    catalog,
    customFormState,
    initMode,
    minDurationOff,
    minDurationOn,
    offset,
    onset,
    selectedCatalogId,
    appendEvent,
  ]);

  // Unload engine
  const unloadEngine = useCallback(async () => {
    if (streamState !== 'idle') {
      Alert.alert(
        'Cannot Unload',
        'Please stop streaming before unloading the engine.'
      );
      return;
    }
    if (engineRef.current) {
      await engineRef.current.release().catch(() => {});
      engineRef.current = null;
      setEngineInfo(null);
      appendEvent('Engine unloaded');
    }
  }, [appendEvent, streamState]);

  // Pick custom audio file
  const pickCustomFile = useCallback(async () => {
    try {
      const [res] = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      if (res?.uri) {
        setCustomFileUri(res.uri);
        setCustomFileName(res.name ?? 'custom_audio.wav');
        appendEvent(`Selected custom audio: ${res.name ?? res.uri}`);
      }
    } catch (e) {
      const isCancel =
        (DocumentPicker as any)?.isCancel?.(e) ||
        (e as any)?.name === 'DocumentPickerCanceled';
      if (!isCancel) {
        appendEvent(`Pick file error: ${String(e)}`);
      }
    }
  }, [appendEvent]);

  // Start streaming pipeline
  const startStreaming = useCallback(async () => {
    if (!engineRef.current || !engineInfo) {
      Alert.alert(
        'Engine Not Initialized',
        'Please initialize the streaming diarization engine first.'
      );
      return;
    }

    setError(null);
    setStreamState('starting');
    setTurns([]);
    setActiveSpeaker(null);
    appendEvent('Starting streaming pipeline...');

    try {
      const engine = engineRef.current;

      // 1. Create live audio buffer (16 kHz mono)
      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: engine.sampleRate,
      });
      liveAudioRef.current = liveAudio;

      // 2. Create live segment buffer with onSegmentAppended listener
      const liveSeg = await createLiveSegmentBuffer({
        sourceAudioBufferId: liveAudio.bufferId,
        onSegmentAppended: (event: LiveSegmentBufferSegmentAppendedEvent) => {
          const rawSpeaker = (event.payload as any)?.speaker;
          const speaker = typeof rawSpeaker === 'number' ? rawSpeaker : 0;
          const sampleRate = event.sampleRate || engine.sampleRate || 16000;
          const startSec = event.startSample / sampleRate;
          const endSec = event.endSample / sampleRate;
          const durationSec = endSec - startSec;

          // Pulse active speaker HUD
          setActiveSpeaker(speaker);
          if (activeSpeakerResetTimer.current)
            clearTimeout(activeSpeakerResetTimer.current);
          activeSpeakerResetTimer.current = setTimeout(() => {
            setActiveSpeaker(null);
          }, 1800);

          const newTurn: SpeakerTurn = {
            id: event.segmentId,
            speaker,
            startSec,
            endSec,
            durationSec,
            startSample: event.startSample,
            endSample: event.endSample,
          };

          setTurns((prev) => [...prev, newTurn]);
          appendEvent(
            `Speaker ${speaker}: ${formatTime(startSec)} → ${formatTime(
              endSec
            )} (${formatDuration(durationSec)})`
          );
        },
      });
      liveSegRef.current = liveSeg;

      // 3. Start native background worker thread
      const pipeline = await engine.startPipeline(liveAudio, liveSeg, {
        chunkSize,
      });
      pipelineRef.current = pipeline;
      appendEvent(`Pipeline registered (ID=${pipeline.pipelineId})`);

      // 4. Start audio ingress
      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(liveAudio, { emitToJs: false });
        appendEvent('Microphone ingestion active');
      } else {
        let source: FileSource;
        if (sourceMode === 'preset') {
          const preset =
            DIARIZATION_AUDIO_FILES[selectedPresetIndex] ??
            DIARIZATION_AUDIO_FILES[0]!;
          source = fileSourceFromBundledPath(preset.id);
          appendEvent(`Ingesting preset: ${preset.name}`);
        } else {
          if (!customFileUri) throw new Error('No custom audio file chosen');
          source = toFileSource(customFileUri, customFileName ?? undefined);
          appendEvent(`Ingesting custom file: ${customFileName}`);
        }

        const ingest = await ingestFileToLiveAudioBuffer(
          liveAudio.bufferId,
          source,
          {
            targetSampleRateHz: engine.sampleRate,
            forceMono: true,
            autoFinalize: true,
            onProgress: (p) => {
              setIngestProgress(p.percent);
            },
          }
        );
        ingestHandleRef.current = ingest;

        // When file decode finishes, log event
        ingest.done
          .then(() => {
            setIngestProgress(100);
            appendEvent('Audio file decode & ingestion complete');
          })
          .catch((e) => {
            appendEvent(`Ingest failed: ${String(e)}`);
          });
      }

      setStreamState('running');

      // 5. Poll status metrics
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        if (!pipelineRef.current) return;
        try {
          const st = await pipelineRef.current.getStatus();
          setPipelineStatus(st);
        } catch {
          // Ignore polling errors during teardown
        }
      }, 250);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      appendEvent(`Pipeline start error: ${msg}`);
      setStreamState('idle');
      // Cleanup buffers if created
      if (liveAudioRef.current) {
        await releasePipelineAudioBuffer(liveAudioRef.current).catch(() => {});
        liveAudioRef.current = null;
      }
      if (liveSegRef.current) {
        await releasePipelineSegmentBuffer(liveSegRef.current).catch(() => {});
        liveSegRef.current = null;
      }
    }
  }, [
    chunkSize,
    customFileName,
    customFileUri,
    engineInfo,
    selectedPresetIndex,
    sourceMode,
    appendEvent,
  ]);

  // Flush pipeline
  const flushPipeline = useCallback(async () => {
    if (!pipelineRef.current) return;
    try {
      appendEvent('Flushing pipeline...');
      await pipelineRef.current.flush();
      appendEvent('Pipeline flushed');
    } catch (e) {
      appendEvent(`Flush error: ${String(e)}`);
    }
  }, [appendEvent]);

  // Reset pipeline state
  const resetPipeline = useCallback(async () => {
    if (!pipelineRef.current) return;
    try {
      appendEvent('Resetting pipeline...');
      await pipelineRef.current.reset();
      setTurns([]);
      setActiveSpeaker(null);
      appendEvent('Pipeline reset');
    } catch (e) {
      appendEvent(`Reset error: ${String(e)}`);
    }
  }, [appendEvent]);

  // Stop pipeline
  const stopStreaming = useCallback(async () => {
    if (streamState === 'idle' || streamState === 'stopping') return;
    setStreamState('stopping');
    appendEvent('Stopping pipeline...');

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    try {
      if (sourceMode === 'mic') {
        await stopMicToLiveAudioBuffer().catch(() => {});
      }
      if (pipelineRef.current) {
        await pipelineRef.current.flush().catch(() => {});
        await pipelineRef.current.stop().catch(() => {});
        await pipelineRef.current.completed.catch(() => {});
        pipelineRef.current = null;
      }
      if (liveAudioRef.current) {
        await releasePipelineAudioBuffer(liveAudioRef.current).catch(() => {});
        liveAudioRef.current = null;
      }
      if (liveSegRef.current) {
        await releasePipelineSegmentBuffer(liveSegRef.current).catch(() => {});
        liveSegRef.current = null;
      }
      appendEvent('Pipeline stopped and cleaned up');
    } catch (e) {
      appendEvent(`Stop error: ${String(e)}`);
    } finally {
      setStreamState('idle');
      setIngestProgress(null);
    }
  }, [appendEvent, sourceMode, streamState]);

  // Analytics computation
  const {
    totalSpeechTime,
    speakerDurations,
    speakerTurnCounts,
    maxMonitoredTime,
    dominantSpeaker,
  } = useMemo(() => {
    const durations: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let maxEnd = 0;

    for (const t of turns) {
      durations[t.speaker] = (durations[t.speaker] ?? 0) + t.durationSec;
      counts[t.speaker] = (counts[t.speaker] ?? 0) + 1;
      if (t.endSec > maxEnd) maxEnd = t.endSec;
    }

    const totalSpeech = Object.values(durations).reduce((acc, d) => acc + d, 0);

    let dominant = -1;
    let maxDur = 0;
    for (let s = 0; s < 4; s++) {
      if ((durations[s] ?? 0) > maxDur) {
        maxDur = durations[s] ?? 0;
        dominant = s;
      }
    }

    return {
      totalSpeechTime: totalSpeech,
      speakerDurations: durations,
      speakerTurnCounts: counts,
      maxMonitoredTime: maxEnd,
      dominantSpeaker: dominant >= 0 ? dominant : null,
    };
  }, [turns]);

  // Copy timeline to clipboard
  const copyTimeline = useCallback(() => {
    if (turns.length === 0) {
      Alert.alert('No turns', 'There are no speaker turns to copy.');
      return;
    }
    const text = turns
      .map((t) => {
        const alias = speakerAliases[t.speaker] ?? `Speaker ${t.speaker}`;
        return `[${formatTime(t.startSec)} → ${formatTime(
          t.endSec
        )}] ${alias} (+${formatDuration(t.durationSec)})`;
      })
      .join('\n');
    Clipboard.setString(text);
    Alert.alert('Copied!', 'Timeline copied to clipboard.');
  }, [speakerAliases, turns]);

  // Filtered turns
  const filteredTurns = useMemo(() => {
    if (speakerFilter === null) return turns;
    return turns.filter((t) => t.speaker === speakerFilter);
  }, [speakerFilter, turns]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Module 1: Model Selection & Parameter Tuning */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>1. Model & Engine Setup</Text>
            {engineInfo ? (
              <TouchableOpacity
                onPress={unloadEngine}
                disabled={streamState !== 'idle'}
              >
                <Ionicons name="trash-outline" size={20} color="#DC2626" />
              </TouchableOpacity>
            ) : null}
          </View>
          <Text style={styles.cardSubtitle}>
            Configure NeMo Sortformer streaming diarization model and inference
            parameters.
          </Text>

          <InitModeSelector value={initMode} onChange={setInitMode} />

          {initMode === 'auto' ? (
            <View style={styles.marginTop10}>
              <ModelFolderGrid
                entries={catalog?.entries ?? []}
                selectedId={selectedCatalogId}
                initializedId={engineInfo ? selectedCatalogId : null}
                onSelect={setSelectedCatalogId}
              />
            </View>
          ) : (
            <DiarizationStreamingCustomInitForm
              value={customFormState}
              onChange={setCustomFormState}
              selectedCatalogModelId={selectedCatalogId}
              onFillFromSelectedModel={handleFillCustomConfig}
              fillLoading={customFillLoading}
              fillHint={customFillHint}
              disabled={engineInitBusy || streamState !== 'idle'}
            />
          )}

          {/* Parameter Tuning Collapsible */}
          <TouchableOpacity
            style={[styles.paramRow, styles.marginTop10]}
            onPress={() => setTuningExpanded((p) => !p)}
          >
            <Text style={[styles.paramLabel, styles.tuningToggleLabel]}>
              {tuningExpanded
                ? '▼ Hide Tuning Parameters'
                : '▶ Advanced Tuning Parameters'}
            </Text>
          </TouchableOpacity>

          {tuningExpanded ? (
            <View style={styles.tuningSectionContent}>
              {/* Onset */}
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>Speech Onset Threshold</Text>
                <View style={styles.paramControls}>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setOnset((v) =>
                        Math.max(0.1, Math.round((v - 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>-</Text>
                  </TouchableOpacity>
                  <View style={styles.paramValueBadge}>
                    <Text style={styles.paramValueText}>
                      {onset.toFixed(2)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setOnset((v) =>
                        Math.min(0.9, Math.round((v + 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Offset */}
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>Speech Offset Threshold</Text>
                <View style={styles.paramControls}>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setOffset((v) =>
                        Math.max(0.1, Math.round((v - 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>-</Text>
                  </TouchableOpacity>
                  <View style={styles.paramValueBadge}>
                    <Text style={styles.paramValueText}>
                      {offset.toFixed(2)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setOffset((v) =>
                        Math.min(0.9, Math.round((v + 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Min Duration Off */}
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>Max Gap to Merge Turns</Text>
                <View style={styles.paramControls}>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setMinDurationOff((v) =>
                        Math.max(0.0, Math.round((v - 0.1) * 10) / 10)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>-</Text>
                  </TouchableOpacity>
                  <View style={styles.paramValueBadge}>
                    <Text style={styles.paramValueText}>
                      {minDurationOff.toFixed(1)}s
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setMinDurationOff((v) =>
                        Math.min(2.0, Math.round((v + 0.1) * 10) / 10)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Min Duration On */}
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>Min Turn Duration</Text>
                <View style={styles.paramControls}>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setMinDurationOn((v) =>
                        Math.max(0.0, Math.round((v - 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>-</Text>
                  </TouchableOpacity>
                  <View style={styles.paramValueBadge}>
                    <Text style={styles.paramValueText}>
                      {minDurationOn.toFixed(2)}s
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.paramStepButton}
                    onPress={() =>
                      setMinDurationOn((v) =>
                        Math.min(1.0, Math.round((v + 0.05) * 100) / 100)
                      )
                    }
                    disabled={streamState !== 'idle'}
                  >
                    <Text style={styles.paramStepButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Chunk Size */}
              <View style={styles.paramRow}>
                <Text style={styles.paramLabel}>Drain Chunk Size</Text>
                <View style={styles.paramControls}>
                  {CHUNK_SIZE_OPTIONS.map((sz) => (
                    <TouchableOpacity
                      key={sz}
                      style={[
                        styles.toggleChip,
                        chunkSize === sz && styles.toggleChipActive,
                        styles.chunkChip,
                      ]}
                      onPress={() => setChunkSize(sz)}
                      disabled={streamState !== 'idle'}
                    >
                      <Text
                        style={[
                          styles.toggleChipText,
                          chunkSize === sz && styles.toggleChipTextActive,
                          styles.chunkChipText,
                        ]}
                      >
                        {sz}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          ) : null}

          {/* Engine Action Button */}
          <View style={styles.marginTop12}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                (engineInitBusy || streamState !== 'idle') &&
                  styles.buttonDisabled,
              ]}
              onPress={initEngine}
              disabled={engineInitBusy || streamState !== 'idle'}
            >
              {engineInitBusy ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Ionicons
                    name="hardware-chip-outline"
                    size={18}
                    color="#FFFFFF"
                  />
                  <Text style={styles.buttonText}>
                    {engineInfo
                      ? 'Re-Initialize Engine'
                      : 'Initialize Diarization Engine'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {/* Engine Properties Card */}
          {engineInfo ? (
            <View style={styles.metaGrid}>
              <View style={styles.metaBadge}>
                <Text style={styles.metaBadgeLabel}>Sample Rate</Text>
                <Text style={styles.metaBadgeValue}>
                  {engineInfo.sampleRate} Hz
                </Text>
              </View>
              <View style={styles.metaBadge}>
                <Text style={styles.metaBadgeLabel}>Max Speakers</Text>
                <Text style={styles.metaBadgeValue}>
                  {engineInfo.maxSpeakers}
                </Text>
              </View>
              <View style={styles.metaBadge}>
                <Text style={styles.metaBadgeLabel}>Feed Window</Text>
                <Text style={styles.metaBadgeValue}>
                  {(engineInfo.feedSamples / engineInfo.sampleRate).toFixed(1)}s
                </Text>
              </View>
              <View style={styles.metaBadge}>
                <Text style={styles.metaBadgeLabel}>Step Stride</Text>
                <Text style={styles.metaBadgeValue}>
                  {(engineInfo.strideSamples / engineInfo.sampleRate).toFixed(
                    1
                  )}
                  s
                </Text>
              </View>
              <View style={styles.metaBadge}>
                <Text style={styles.metaBadgeLabel}>Latency</Text>
                <Text style={styles.metaBadgeValue}>
                  {engineInfo.latencySeconds.toFixed(1)}s
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        {/* Module 2: Audio Ingress & Pipeline Lifecycle */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            2. Audio Ingress & Stream Controls
          </Text>
          <Text style={styles.cardSubtitle}>
            Select live microphone, dedicated multi-speaker recordings, or a
            custom audio file.
          </Text>

          <View style={styles.toggleChipRow}>
            <TouchableOpacity
              style={[
                styles.toggleChip,
                sourceMode === 'preset' && styles.toggleChipActive,
              ]}
              onPress={() => setSourceMode('preset')}
              disabled={streamState !== 'idle'}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  sourceMode === 'preset' && styles.toggleChipTextActive,
                ]}
              >
                Multi-Speaker Presets
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.toggleChip,
                sourceMode === 'file' && styles.toggleChipActive,
              ]}
              onPress={() => setSourceMode('file')}
              disabled={streamState !== 'idle'}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  sourceMode === 'file' && styles.toggleChipTextActive,
                ]}
              >
                Custom Audio File
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.toggleChip,
                sourceMode === 'mic' && styles.toggleChipActive,
              ]}
              onPress={() => setSourceMode('mic')}
              disabled={streamState !== 'idle'}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  sourceMode === 'mic' && styles.toggleChipTextActive,
                ]}
              >
                Microphone (Live)
              </Text>
            </TouchableOpacity>
          </View>

          {sourceMode === 'preset' ? (
            <View style={styles.presetListContainer}>
              {DIARIZATION_AUDIO_FILES.map((preset, idx) => (
                <TouchableOpacity
                  key={preset.id}
                  style={[
                    styles.statBox,
                    selectedPresetIndex === idx && styles.presetSelectedBox,
                  ]}
                  onPress={() => setSelectedPresetIndex(idx)}
                  disabled={streamState !== 'idle'}
                >
                  <Text style={[styles.cardTitle, styles.presetTitle]}>
                    {preset.name}
                  </Text>
                  <Text style={styles.cardSubtitle}>{preset.description}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : sourceMode === 'file' ? (
            <View style={styles.presetListContainer}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={pickCustomFile}
                disabled={streamState !== 'idle'}
              >
                <Ionicons
                  name="folder-open-outline"
                  size={18}
                  color="#374151"
                />
                <Text style={styles.secondaryButtonText}>
                  {customFileName
                    ? `Change File (${customFileName})`
                    : 'Choose Audio File...'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.micHintContainer}>
              <Text style={[styles.cardSubtitle, styles.micHintText]}>
                Microphone captures directly into native LiveAudioBuffer at
                16kHz mono.
              </Text>
            </View>
          )}

          {ingestProgress !== null ? (
            <View style={styles.progressContainer}>
              <Text style={styles.paramLabel}>
                Ingest & Decode Progress: {ingestProgress.toFixed(0)}%
              </Text>
              <View style={[styles.airtimeBar, styles.airtimeProgressTrack]}>
                <View
                  style={[
                    styles.airtimeSegment,
                    { flex: ingestProgress },
                    styles.airtimeProgressFilled,
                  ]}
                />
                <View
                  style={[
                    styles.airtimeSegment,
                    { flex: Math.max(0, 100 - ingestProgress) },
                    styles.airtimeProgressEmpty,
                  ]}
                />
              </View>
            </View>
          ) : null}

          {/* Pipeline Action Controls */}
          <View style={styles.pipelineControlRow}>
            {streamState === 'idle' ? (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.flex1,
                  !engineInfo && styles.buttonDisabled,
                ]}
                onPress={startStreaming}
                disabled={!engineInfo}
              >
                <Ionicons name="play" size={18} color="#FFFFFF" />
                <Text style={styles.buttonText}>Start Streaming</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.dangerButton, styles.flex1]}
                onPress={stopStreaming}
                disabled={streamState === 'stopping'}
              >
                {streamState === 'stopping' ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Ionicons name="stop" size={18} color="#FFFFFF" />
                    <Text style={styles.buttonText}>Stop Pipeline</Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[
                styles.secondaryButton,
                streamState !== 'running' && styles.buttonDisabled,
              ]}
              onPress={flushPipeline}
              disabled={streamState !== 'running'}
            >
              <Ionicons name="flash-outline" size={16} color="#374151" />
              <Text style={styles.secondaryButtonText}>Flush</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.secondaryButton,
                streamState !== 'running' && styles.buttonDisabled,
              ]}
              onPress={resetPipeline}
              disabled={streamState !== 'running'}
            >
              <Ionicons name="refresh-outline" size={16} color="#374151" />
              <Text style={styles.secondaryButtonText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Module 3: Real-Time Active Speaker HUD */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>3. Active Speaker HUD</Text>
          <Text style={styles.cardSubtitle}>
            Live participant indicator with real-time speaking pulse and custom
            participant aliases.
          </Text>

          <View style={styles.speakerGrid}>
            {[0, 1, 2, 3].map((s) => {
              const isActive = activeSpeaker === s;
              const color = SPEAKER_COLORS[s];
              const bgColor = SPEAKER_BG_COLORS[s];
              const alias = speakerAliases[s] ?? `Speaker ${s}`;
              const dur = speakerDurations[s] ?? 0;
              const turnsCount = speakerTurnCounts[s] ?? 0;

              return (
                <View
                  key={s}
                  style={[
                    styles.speakerCard,
                    { backgroundColor: bgColor },
                    isActive && [
                      styles.speakerCardActive,
                      { borderColor: color },
                    ],
                  ]}
                >
                  <View style={styles.speakerCardTop}>
                    <View
                      style={[styles.speakerBadge, { backgroundColor: color }]}
                    >
                      <Text style={styles.speakerBadgeText}>{s}</Text>
                    </View>
                    {isActive ? (
                      <View
                        style={[
                          styles.speakerLiveDot,
                          { backgroundColor: color },
                        ]}
                      />
                    ) : null}
                  </View>

                  <TextInput
                    style={styles.speakerAliasInput}
                    value={alias}
                    onChangeText={(txt) =>
                      setSpeakerAliases((prev) => ({ ...prev, [s]: txt }))
                    }
                    placeholder={`Speaker ${s}`}
                    placeholderTextColor="#9CA3AF"
                  />

                  <View style={styles.speakerStatsRow}>
                    <Text style={styles.speakerStatLabel}>Speaking Time</Text>
                    <Text style={styles.speakerStatValue}>
                      {dur.toFixed(1)}s
                    </Text>
                  </View>
                  <View style={styles.speakerStatsRow}>
                    <Text style={styles.speakerStatLabel}>Turns Count</Text>
                    <Text style={styles.speakerStatValue}>{turnsCount}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* Module 4: Meeting Analytics & Airtime Share */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>4. Meeting & Airtime Analytics</Text>
          <Text style={styles.cardSubtitle}>
            Real-time proportional talk-time breakdown and conversation
            statistics.
          </Text>

          {/* Proportional Stacked Airtime Bar */}
          <View style={styles.airtimeBar}>
            {[0, 1, 2, 3].map((s) => {
              const dur = speakerDurations[s] ?? 0;
              const flexVal =
                totalSpeechTime > 0 ? (dur / totalSpeechTime) * 100 : 0;
              if (flexVal <= 0) return null;
              return (
                <View
                  key={s}
                  style={[
                    styles.airtimeSegment,
                    { flex: flexVal, backgroundColor: SPEAKER_COLORS[s] },
                  ]}
                />
              );
            })}
            {totalSpeechTime <= 0 ? (
              <View style={[styles.airtimeSegment, styles.airtimeEmptyBar]} />
            ) : null}
          </View>

          <View style={styles.analyticsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Monitored Duration</Text>
              <Text style={styles.statBoxValue}>
                {formatTime(maxMonitoredTime)}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Total Speech Active</Text>
              <Text style={styles.statBoxValue}>
                {formatDuration(totalSpeechTime)}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Total Turns Emitted</Text>
              <Text style={styles.statBoxValue}>{turns.length}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Dominant Speaker</Text>
              <Text
                style={[
                  styles.statBoxValue,
                  dominantSpeaker !== null && {
                    color: SPEAKER_COLORS[dominantSpeaker],
                  },
                ]}
              >
                {dominantSpeaker !== null
                  ? speakerAliases[dominantSpeaker] ??
                    `Speaker ${dominantSpeaker}`
                  : 'None'}
              </Text>
            </View>
          </View>
        </View>

        {/* Module 5: Real-Time Chronological Speaker Turn Timeline */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>
              5. Speaker Turn Timeline ({filteredTurns.length})
            </Text>
            <TouchableOpacity
              onPress={copyTimeline}
              disabled={turns.length === 0}
              style={styles.copyButtonRow}
            >
              <Ionicons name="copy-outline" size={16} color="#0F62FE" />
              <Text style={styles.copyButtonText}>Copy</Text>
            </TouchableOpacity>
          </View>

          {/* Speaker Filter Chips */}
          <View style={styles.timelineFilterRow}>
            <TouchableOpacity
              style={[
                styles.toggleChip,
                speakerFilter === null && styles.toggleChipActive,
              ]}
              onPress={() => setSpeakerFilter(null)}
            >
              <Text
                style={[
                  styles.toggleChipText,
                  speakerFilter === null && styles.toggleChipTextActive,
                ]}
              >
                All ({turns.length})
              </Text>
            </TouchableOpacity>
            {[0, 1, 2, 3].map((s) => {
              const count = speakerTurnCounts[s] ?? 0;
              const alias = speakerAliases[s] ?? `Speaker ${s}`;
              const isSelected = speakerFilter === s;
              return (
                <TouchableOpacity
                  key={s}
                  style={[
                    styles.toggleChip,
                    isSelected && {
                      backgroundColor: SPEAKER_COLORS[s],
                      borderColor: SPEAKER_COLORS[s],
                    },
                  ]}
                  onPress={() => setSpeakerFilter(isSelected ? null : s)}
                >
                  <Text
                    style={[
                      styles.toggleChipText,
                      isSelected && styles.toggleChipTextActive,
                    ]}
                  >
                    {alias} ({count})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Timeline List */}
          {filteredTurns.length === 0 ? (
            <View style={styles.emptyNotice}>
              <Text style={styles.emptyNoticeText}>
                {streamState === 'running'
                  ? 'Listening for speech turns...'
                  : 'Start streaming to see committed speaker segments.'}
              </Text>
            </View>
          ) : (
            <ScrollView nestedScrollEnabled style={styles.timelineList}>
              {filteredTurns.map((turn) => {
                const color = SPEAKER_COLORS[turn.speaker];
                const alias =
                  speakerAliases[turn.speaker] ?? `Speaker ${turn.speaker}`;
                return (
                  <View
                    key={turn.id}
                    style={[styles.timelineItem, { borderLeftColor: color }]}
                  >
                    <View
                      style={[
                        styles.timelineSpeakerTag,
                        { backgroundColor: color },
                      ]}
                    >
                      <Text style={styles.timelineSpeakerTagText}>{alias}</Text>
                    </View>
                    <View style={styles.timelineTimeInfo}>
                      <Text style={styles.timelineTimeRange}>
                        {formatTime(turn.startSec)} → {formatTime(turn.endSec)}
                      </Text>
                      <Text style={styles.timelineSampleRange}>
                        [{turn.startSample.toLocaleString()} ..{' '}
                        {turn.endSample.toLocaleString()}]
                      </Text>
                    </View>
                    <View style={styles.timelineDurationBadge}>
                      <Text style={styles.timelineDurationText}>
                        +{formatDuration(turn.durationSec)}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>

        {/* Module 6: Pipeline Diagnostics & Event Stream */}
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.cardHeader}
            onPress={() => setDiagnosticsExpanded((p) => !p)}
          >
            <Text style={styles.cardTitle}>
              6. Pipeline Diagnostics & Event Stream
            </Text>
            <Ionicons
              name={diagnosticsExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color="#6B7280"
            />
          </TouchableOpacity>

          {diagnosticsExpanded ? (
            <View>
              {pipelineStatus ? (
                <View style={styles.statusBox}>
                  <Text style={styles.statusText}>
                    isRunning: {String(pipelineStatus.isRunning)}
                  </Text>
                  <Text style={styles.statusDimText}>
                    chunksProcessed: {pipelineStatus.chunksProcessed}
                  </Text>
                  <Text style={styles.statusDimText}>
                    unitsRead: {pipelineStatus.unitsRead} samples
                  </Text>
                  <Text style={styles.statusDimText}>
                    unitsWritten: {pipelineStatus.unitsWritten} segments
                  </Text>
                  {pipelineStatus.error ? (
                    <Text style={[styles.statusText, styles.statusErrorText]}>
                      error: {pipelineStatus.error}
                    </Text>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.cardSubtitle}>
                  Pipeline is currently inactive.
                </Text>
              )}

              <Text style={[styles.paramLabel, styles.eventsHeaderLabel]}>
                Recent Event Log ({events.length})
              </Text>
              <View style={[styles.statusBox, styles.eventLogContainer]}>
                <ScrollView nestedScrollEnabled>
                  {events.length === 0 ? (
                    <Text style={styles.statusDimText}>
                      No events recorded yet.
                    </Text>
                  ) : (
                    events.map((ev) => (
                      <Text key={ev.id} style={styles.statusDimText}>
                        [{ev.time}] {ev.message}
                      </Text>
                    ))
                  )}
                </ScrollView>
              </View>
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>Error: {error}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      <ScreenIntroModal screenId="DiarizationStreaming" />
    </SafeAreaView>
  );
}
