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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Clipboard from '@react-native-clipboard/clipboard';
import type { DiarizationPipelineHandle } from 'react-native-sherpa-onnx/diarization';
import {
  createEmptyLiveAudioBuffer,
  appendOfflineToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  type LiveAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveSegmentBuffer,
  readLiveSegment,
  releasePipelineSegmentBuffer,
  type LiveSegmentBufferRef,
  type LiveSegmentBufferSegmentAppendedEvent,
} from 'react-native-sherpa-onnx/segmentbuffer';
import type { StreamingPipelineStatus } from 'react-native-sherpa-onnx/audiobuffer';
import type { RootStackParamList } from '../../types/navigation';
import { DiarizationStreamingModelInitPanel } from '../../components/DiarizationStreamingModelInitPanel';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { useDiarizationStreamingModelInit } from '../../hooks/useDiarizationStreamingModelInit';
import { DIARIZATION_AUDIO_FILES } from '../../audioConfig';
import type { AudioIngressSourceMode } from '../../components/AudioIngressSourceToggle';
import {
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import { StreamingAudioInputSection } from '../../components/StreamingAudioInputSection';
import {
  SPEAKER_BG_COLORS,
  SPEAKER_COLORS,
  styles,
} from './DiarizationStreamingScreen.styles';

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
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const stopStreamingRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const streaming = useDiarizationStreamingModelInit({
    onBeforeInit: () => stopStreamingRef.current?.(),
  });
  const { engineRef, engineInfo, chunkSize, minDurationOff } = streaming;

  // Audio ingress selection
  const [sourceMode, setSourceMode] = useState<AudioIngressSourceMode>('file');
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);

  // Streaming pipeline lifecycle
  const [streamState, setStreamState] = useState<
    'idle' | 'starting' | 'running' | 'stopping'
  >('idle');
  const pipelineRef = useRef<DiarizationPipelineHandle | null>(null);
  const liveAudioRef = useRef<LiveAudioBufferRef | null>(null);
  const liveSegRef = useRef<LiveSegmentBufferRef | null>(null);
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
  const turnsRef = useRef<SpeakerTurn[]>([]);
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [pipelineStatus, setPipelineStatus] =
    useState<StreamingPipelineStatus | null>(null);
  const [events, setEvents] = useState<EventLogItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const appendEvent = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [
      { id: `${Date.now()}_${Math.random()}`, time, message },
      ...prev.slice(0, 49),
    ]);
  }, []);

  // Clean up pipeline on unmount (engine persists in module cache)
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (activeSpeakerResetTimer.current)
        clearTimeout(activeSpeakerResetTimer.current);
      const pipe = pipelineRef.current;
      pipelineRef.current = null;
      pipe?.stop().catch(() => {});
    };
  }, []);

  // Start streaming pipeline
  const startStreaming = useCallback(async () => {
    if (!engineRef.current || !engineInfo) {
      Alert.alert(
        'Engine Not Initialized',
        'Please initialize the streaming diarization engine first.'
      );
      return;
    }

    if (sourceMode === 'file' && !offlineInputBuffer) {
      Alert.alert(
        'No Audio Buffer',
        'Please select and decode an audio buffer (preset or custom file) first.'
      );
      return;
    }

    // Stop preview playback if active
    await offlineWidgetRef.current?.stopPlayback?.().catch(() => {});

    setError(null);
    setStreamState('starting');
    turnsRef.current = [];
    setTurns([]);
    setActiveSpeaker(null);
    appendEvent('Starting streaming pipeline...');

    try {
      const engine = engineRef.current;

      // 1. Determine ring cache size (ensure full buffer fits in live ring buffer)
      let ringSeconds = 60;
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

      // 2. Create live audio buffer (16 kHz mono)
      const liveAudio = await createEmptyLiveAudioBuffer({
        sampleRate: engine.sampleRate,
        ringSeconds,
      });
      liveAudioRef.current = liveAudio;

      // 3. Create live segment buffer with onSegmentAppended listener
      const liveSeg = await createLiveSegmentBuffer({
        sourceAudioBufferId: liveAudio.bufferId,
        onSegmentAppended: (event: LiveSegmentBufferSegmentAppendedEvent) => {
          readLiveSegment(event)
            .then((meta) => {
              const rawSpeaker =
                meta?.kind === 'diarization'
                  ? (meta.payload as { speaker?: number } | undefined)?.speaker
                  : undefined;
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

              // Live turn-stitching: extend existing turn if within minDurationOff gap
              const prev = turnsRef.current;
              let lastSpeakerTurnIndex = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                const t = prev[i];
                if (t && t.speaker === speaker) {
                  lastSpeakerTurnIndex = i;
                  break;
                }
              }

              let isExtended = false;
              let updatedTurn: SpeakerTurn | null = null;

              if (lastSpeakerTurnIndex >= 0) {
                const lastTurn = prev[lastSpeakerTurnIndex];
                if (
                  lastTurn &&
                  startSec <= lastTurn.endSec + minDurationOff &&
                  endSec >= lastTurn.startSec
                ) {
                  const newStartSec = Math.min(lastTurn.startSec, startSec);
                  const newEndSec = Math.max(lastTurn.endSec, endSec);
                  const newStartSample = Math.min(
                    lastTurn.startSample,
                    event.startSample
                  );
                  const newEndSample = Math.max(
                    lastTurn.endSample,
                    event.endSample
                  );
                  updatedTurn = {
                    id: lastTurn.id,
                    speaker: lastTurn.speaker,
                    startSec: newStartSec,
                    endSec: newEndSec,
                    durationSec: newEndSec - newStartSec,
                    startSample: newStartSample,
                    endSample: newEndSample,
                  };
                  isExtended = true;
                }
              }

              if (isExtended && updatedTurn) {
                const next = [...prev];
                next[lastSpeakerTurnIndex] = updatedTurn;
                turnsRef.current = next;
                setTurns(next);
                appendEvent(
                  `Speaker ${speaker} (extended): ${formatTime(
                    updatedTurn.startSec
                  )} → ${formatTime(updatedTurn.endSec)} (+${formatDuration(
                    updatedTurn.durationSec
                  )})`
                );
              } else {
                const newTurn: SpeakerTurn = {
                  id: event.segmentId,
                  speaker,
                  startSec,
                  endSec,
                  durationSec,
                  startSample: event.startSample,
                  endSample: event.endSample,
                };
                const next = [...prev, newTurn];
                turnsRef.current = next;
                setTurns(next);
                appendEvent(
                  `Speaker ${speaker} (new turn): ${formatTime(
                    startSec
                  )} → ${formatTime(endSec)} (+${formatDuration(durationSec)})`
                );
              }
            })
            .catch(() => undefined);
        },
      });
      liveSegRef.current = liveSeg;

      // 4. Start native background worker thread
      const pipeline = await engine.startPipeline(liveAudio, liveSeg, {
        chunkSize,
      });
      pipelineRef.current = pipeline;
      appendEvent(`Pipeline registered (ID=${pipeline.pipelineId})`);

      // 5. Start audio ingress
      if (sourceMode === 'mic') {
        await startMicToLiveAudioBuffer(liveAudio, { emitToJs: false });
        appendEvent('Microphone ingestion active');
      } else {
        appendEvent(
          `Ingesting offline audio buffer: ${offlineInputBuffer!.sourceLabel}`
        );

        // Append all offline buffer samples into live audio buffer
        await appendOfflineToLiveAudioBuffer(
          liveAudio.bufferId,
          offlineInputBuffer!.bufferId
        );
        // Finalize live audio buffer so streaming worker finishes once all chunks are processed
        await finalizeLiveAudioBuffer(liveAudio.bufferId);
        appendEvent('All buffer samples appended; live audio finalized');
      }

      setStreamState('running');

      // Listen for pipeline completion (especially for file ingest)
      pipeline.completed
        .then(() => {
          appendEvent('Pipeline completed (all audio processed)');
          setStreamState('idle');
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        })
        .catch((e) => {
          appendEvent(`Pipeline completion error: ${String(e)}`);
        });

      // 6. Poll status metrics
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
    appendEvent,
    chunkSize,
    engineInfo,
    engineRef,
    minDurationOff,
    offlineInputBuffer,
    sourceMode,
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
      turnsRef.current = [];
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
    }
  }, [appendEvent, sourceMode, streamState]);

  stopStreamingRef.current = async () => {
    if (streamState !== 'idle') {
      await stopStreaming();
    }
  };

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
        <DiarizationStreamingModelInitPanel
          streaming={streaming}
          disabled={streamState !== 'idle'}
          onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
        />

        <StreamingAudioInputSection
          title="2. Input source"
          sourceMode={sourceMode}
          onSourceModeChange={setSourceMode}
          audioFiles={DIARIZATION_AUDIO_FILES}
          onBufferReady={(info) => {
            setOfflineInputBuffer(info);
            appendEvent(`Audio buffer ready: ${info.sourceLabel}`);
          }}
          onBufferReleased={() => {
            setOfflineInputBuffer(null);
            appendEvent('Audio buffer released');
          }}
          disabled={streamState !== 'idle'}
          widgetRef={offlineWidgetRef}
          micSampleRateHz={engineInfo?.sampleRate ?? 16000}
          decodeTargetSampleRateHz={engineInfo?.sampleRate ?? 16000}
        />

        {/* Module 3: Pipeline Lifecycle */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>3. Stream Controls</Text>
          <Text style={styles.cardSubtitle}>
            Start the diarization pipeline after preparing file or microphone
            input above.
          </Text>

          {/* Pipeline Action Controls */}
          <View style={styles.pipelineControlRow}>
            {streamState === 'idle' ? (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.flex1,
                  (!engineInfo ||
                    (sourceMode === 'file' && !offlineInputBuffer)) &&
                    styles.buttonDisabled,
                ]}
                onPress={startStreaming}
                disabled={
                  !engineInfo || (sourceMode === 'file' && !offlineInputBuffer)
                }
              >
                <Ionicons name="play" size={18} color="#FFFFFF" />
                <Text style={styles.buttonText}>
                  {sourceMode === 'file' && !offlineInputBuffer
                    ? 'Select & Decode Audio First'
                    : 'Start Streaming'}
                </Text>
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
