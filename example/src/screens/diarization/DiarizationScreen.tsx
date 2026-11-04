import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
  type DiarizationSegmentMeta,
} from 'react-native-sherpa-onnx/segmentbuffer';
import type { RootStackParamList } from '../../types/navigation';
import { DIARIZATION_AUDIO_FILES } from '../../audioConfig';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from '../../components/OfflineAudioBufferWidget';
import { DiarizationModelInitPanel } from '../../components/DiarizationModelInitPanel';
import { useDiarizationModelInit } from '../../hooks/useDiarizationModelInit';
import {
  styles,
  SPEAKER_COLORS,
  SPEAKER_BG_COLORS,
} from './DiarizationScreen.styles';

export type SpeakerTurn = {
  id: string;
  speaker: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  startSample: number;
  endSample: number;
  /** Silhouette confidence in [-1, 1] when computeConfidence is on. */
  confidence?: number;
};

type EventLogItem = {
  id: string;
  time: string;
  message: string;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms
    .toString()
    .padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`;
  }
  return `${seconds.toFixed(2)}s`;
}

function getSpeakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length] ?? '#2563EB';
}

function getSpeakerBgColor(index: number): string {
  return SPEAKER_BG_COLORS[index % SPEAKER_BG_COLORS.length] ?? '#EFF6FF';
}

export default function DiarizationScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();

  const offlineWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [hasDiarizedOnce, setHasDiarizedOnce] = useState(false);

  // Audio Ingress & Diarization Execution
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(null);
  const [diarizeBusy, setDiarizeBusy] = useState(false);
  const [reclusterBusy, setReclusterBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processingTimeMs, setProcessingTimeMs] = useState(0);
  const [executionError, setExecutionError] = useState<string | null>(null);

  // Indeterminate progress animation for offline oneshot
  const indeterminateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (diarizeBusy && progress === 0) {
      indeterminateAnim.setValue(0);
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(indeterminateAnim, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: false,
          }),
          Animated.timing(indeterminateAnim, {
            toValue: 0,
            duration: 1200,
            useNativeDriver: false,
          }),
        ])
      );
      animation.start();
      return () => animation.stop();
    }
    return undefined;
  }, [diarizeBusy, progress, indeterminateAnim]);

  const indeterminateLeft = indeterminateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '65%'],
  });

  // Speaker Analytics & Timeline
  const [turns, setTurns] = useState<SpeakerTurn[]>([]);
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);
  const [speakerAliases, setSpeakerAliases] = useState<Record<number, string>>(
    {}
  );

  // Diagnostics & Event Log
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [events, setEvents] = useState<EventLogItem[]>([]);

  const appendEvent = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [
      { id: `${Date.now()}_${Math.random()}`, time, message },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const clearDiarizationRunState = useCallback(() => {
    setHasDiarizedOnce(false);
    setTurns([]);
    setProgress(0);
    setProcessingTimeMs(0);
    setExecutionError(null);
  }, []);

  const diarization = useDiarizationModelInit({
    onEngineReady: () => {
      setHasDiarizedOnce(false);
    },
    onAfterRelease: clearDiarizationRunState,
  });

  const {
    engineRef,
    engineInfo,
    tuning,
    patchTuning,
    loading: engineInitBusy,
    ensureEngineReady,
    updateEngineInfoAfterRecluster,
  } = diarization;

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const {
    clusteringThreshold,
    numClusters,
    computeConfidence,
    numThreads,
    windowShiftRatio,
  } = tuning;

  // Run Diarization
  const runDiarization = useCallback(async () => {
    if (!offlineInputBuffer || diarizeBusy || reclusterBusy) return;
    setDiarizeBusy(true);
    setProgress(0);
    setExecutionError(null);
    setTurns([]);

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;
    const startedAt = Date.now();

    // Stop playback if audio is currently playing in widget
    await offlineWidgetRef.current?.stopPlayback?.().catch(() => {});

    let segOutId: string | null = null;
    try {
      const engine = await ensureEngineReady(tuning);

      appendEvent(
        `Starting diarization on "${offlineInputBuffer.sourceLabel}"...`
      );

      const segOut = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: offlineInputBuffer.bufferId,
      });
      segOutId = segOut.bufferId;

      const res = await engine.diarize(
        offlineInputBuffer.bufferId,
        segOut.bufferId,
        {
          onProgress: (p) => {
            setProgress(Math.round((p.fraction ?? 0) * 100));
          },
          signal: abortCtrl.signal,
        }
      );

      const durMs = Date.now() - startedAt;
      setProcessingTimeMs(durMs);
      setProgress(100);

      // Read segments from segOut
      const metas = await getOfflineSegmentBufferSegments(
        segOut.bufferId,
        0,
        4096
      );
      const diarMetas = metas.filter(
        (m): m is DiarizationSegmentMeta => m.kind === 'diarization'
      );

      const newTurns: SpeakerTurn[] = diarMetas.map((seg) => {
        const speaker = seg.payload?.speaker ?? 0;
        const startSec = seg.startSample / seg.sampleRate;
        const endSec = seg.endSample / seg.sampleRate;
        return {
          id: seg.id,
          speaker,
          startSec,
          endSec,
          durationSec: endSec - startSec,
          startSample: seg.startSample,
          endSample: seg.endSample,
          ...(typeof seg.confidence === 'number'
            ? { confidence: seg.confidence }
            : {}),
        };
      });

      setTurns(newTurns);
      setHasDiarizedOnce(true);
      const withConf = newTurns.filter(
        (t) => typeof t.confidence === 'number'
      ).length;
      appendEvent(
        `Diarization complete in ${durMs}ms: ${res.numSpeakers} speakers, ${res.segmentCount} segments` +
          (computeConfidence
            ? ` (confidence on ${withConf}/${newTurns.length})`
            : '')
      );
    } catch (e) {
      if (abortCtrl.signal.aborted) {
        appendEvent('Diarization cancelled by user');
        setExecutionError('Diarization cancelled');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        if (engineRef.current) {
          setExecutionError(`Diarization failed: ${msg}`);
        }
        appendEvent(`Diarization error: ${msg}`);
      }
    } finally {
      if (segOutId) {
        await releasePipelineSegmentBuffer(segOutId).catch(() => {});
      }
      abortControllerRef.current = null;
      setDiarizeBusy(false);
    }
  }, [
    appendEvent,
    computeConfidence,
    diarizeBusy,
    engineRef,
    ensureEngineReady,
    offlineInputBuffer,
    reclusterBusy,
    tuning,
  ]);

  // Cancel Diarization
  const cancelDiarization = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      appendEvent('Cancelling diarization...');
    }
  }, [appendEvent]);

  // Recluster (Instant without re-inference)
  const reclusterEngine = useCallback(async () => {
    if (!engineRef.current || reclusterBusy || diarizeBusy) return;
    setReclusterBusy(true);
    setExecutionError(null);
    const startedAt = Date.now();
    try {
      appendEvent(
        `Reclustering (threshold=${clusteringThreshold.toFixed(
          2
        )}, numClusters=${numClusters}, computeConfidence=${computeConfidence})...`
      );
      const res = await engineRef.current.recluster({
        numClusters: numClusters > 0 ? numClusters : undefined,
        threshold: clusteringThreshold,
        computeConfidence,
      });
      const durMs = Date.now() - startedAt;
      setProcessingTimeMs(durMs);

      if (res.segments && res.segments.length > 0) {
        const sampleRate = res.sampleRate || 16000;
        const updatedTurns: SpeakerTurn[] = res.segments.map((s, idx) => ({
          id: `recluster_${idx}`,
          speaker: s.speaker,
          startSec: s.start,
          endSec: s.end,
          durationSec: s.end - s.start,
          startSample: Math.round(s.start * sampleRate),
          endSample: Math.round(s.end * sampleRate),
          ...(typeof s.confidence === 'number'
            ? { confidence: s.confidence }
            : {}),
        }));
        setTurns(updatedTurns);
        updateEngineInfoAfterRecluster({
          numClusters,
          clusteringThreshold,
          computeConfidence,
        });
        const withConf = updatedTurns.filter(
          (t) => typeof t.confidence === 'number'
        ).length;
        appendEvent(
          `Recluster complete in ${durMs}ms: ${res.numSpeakers} speakers, ${res.segmentCount} segments` +
            (computeConfidence
              ? ` (confidence on ${withConf}/${updatedTurns.length})`
              : '')
        );
      } else {
        appendEvent(
          `Recluster finished in ${durMs}ms (${res.numSpeakers} speakers)`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExecutionError(`Recluster failed: ${msg}`);
      appendEvent(`Recluster error: ${msg}`);
    } finally {
      setReclusterBusy(false);
    }
  }, [
    appendEvent,
    clusteringThreshold,
    computeConfidence,
    diarizeBusy,
    engineRef,
    numClusters,
    reclusterBusy,
    updateEngineInfoAfterRecluster,
  ]);

  // Speaker Analytics Computation
  const {
    totalSpeechTime,
    speakerDurations,
    speakerTurnCounts,
    uniqueSpeakers,
    dominantSpeaker,
  } = useMemo(() => {
    const durations: Record<number, number> = {};
    const counts: Record<number, number> = {};
    const spkSet = new Set<number>();

    for (const t of turns) {
      durations[t.speaker] = (durations[t.speaker] ?? 0) + t.durationSec;
      counts[t.speaker] = (counts[t.speaker] ?? 0) + 1;
      spkSet.add(t.speaker);
    }

    const totalSpeech = Object.values(durations).reduce((acc, d) => acc + d, 0);
    const sortedSpeakers = Array.from(spkSet).sort((a, b) => a - b);

    let dominant = -1;
    let maxDur = 0;
    for (const s of sortedSpeakers) {
      const dur = durations[s] ?? 0;
      if (dur > maxDur) {
        maxDur = dur;
        dominant = s;
      }
    }

    return {
      totalSpeechTime: totalSpeech,
      speakerDurations: durations,
      speakerTurnCounts: counts,
      uniqueSpeakers: sortedSpeakers,
      dominantSpeaker: dominant >= 0 ? dominant : null,
    };
  }, [turns]);

  // Real-Time Factor (RTF)
  const rtf = useMemo(() => {
    const durSec = offlineInputBuffer?.durationSeconds ?? 0;
    if (durSec <= 0 || processingTimeMs <= 0) return 0;
    return processingTimeMs / 1000 / durSec;
  }, [offlineInputBuffer, processingTimeMs]);

  // Filtered turns
  const filteredTurns = useMemo(() => {
    if (speakerFilter === null) return turns;
    return turns.filter((t) => t.speaker === speakerFilter);
  }, [speakerFilter, turns]);

  // Copy timeline to clipboard
  const copyTimeline = useCallback(() => {
    if (turns.length === 0) {
      Alert.alert('No turns', 'There are no speaker turns to copy.');
      return;
    }
    const text = turns
      .map((t) => {
        const alias = speakerAliases[t.speaker] ?? `Speaker ${t.speaker}`;
        const conf =
          typeof t.confidence === 'number'
            ? ` conf=${t.confidence.toFixed(3)}`
            : '';
        return `[${formatTime(t.startSec)} → ${formatTime(
          t.endSec
        )}] ${alias} (+${formatDuration(t.durationSec)})${conf}`;
      })
      .join('\n');
    Clipboard.setString(text);
    Alert.alert('Copied!', 'Timeline copied to clipboard.');
  }, [speakerAliases, turns]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['left', 'right', 'bottom']}>
      <ScreenIntroModal screenId="Diarization" />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <DiarizationModelInitPanel
          diarization={diarization}
          disabled={engineInitBusy || diarizeBusy || reclusterBusy}
          onOpenDownloads={() => navigation.navigate('DownloadShowcase')}
        />

        {/* Module 2: Audio Ingress & Diarization Execution */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>2. Audio Ingress & Diarization</Text>
          <Text style={styles.cardSubtitle}>
            Select multi-speaker audio or pick custom file, then run diarization
          </Text>

          <OfflineAudioBufferWidget
            ref={offlineWidgetRef}
            audioFiles={DIARIZATION_AUDIO_FILES}
            decodeTargetSampleRateHz={engineInfo?.sampleRate ?? 16000}
            disabled={diarizeBusy || reclusterBusy}
            visible={true}
            onBufferReady={(info) => {
              setExecutionError(null);
              setOfflineInputBuffer(info);
              const durText =
                info.durationSeconds != null
                  ? ` (${info.durationSeconds.toFixed(2)}s)`
                  : '';
              appendEvent(`Audio buffer ready: ${info.sourceLabel}${durText}`);

              // Auto-set cluster count for example audio
              if (info.sourceLabel.includes('4 Speakers')) {
                patchTuning({ numClusters: 4 });
              } else if (info.sourceLabel.includes('2 Speakers')) {
                patchTuning({ numClusters: 2 });
              } else {
                patchTuning({ numClusters: 0 });
              }
            }}
            onBufferReleased={() => {
              setExecutionError(null);
              setOfflineInputBuffer(null);
              setTurns([]);
              appendEvent('Audio buffer released');
            }}
          />

          {/* Diarization Execution Actions */}
          <View style={styles.actionControlRow}>
            {diarizeBusy ? (
              <TouchableOpacity
                style={[styles.dangerButton, styles.flex1]}
                onPress={cancelDiarization}
              >
                <Ionicons
                  name="stop-circle-outline"
                  size={18}
                  color="#FFFFFF"
                />
                <Text style={styles.buttonText}>Cancel Diarization</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  styles.flex1,
                  !offlineInputBuffer && styles.buttonDisabled,
                ]}
                onPress={() => {
                  runDiarization().catch(() => {});
                }}
                disabled={!offlineInputBuffer || reclusterBusy}
              >
                <Ionicons name="people-outline" size={18} color="#FFFFFF" />
                <Text style={styles.buttonText}>
                  {offlineInputBuffer
                    ? 'Run Diarization'
                    : 'Select Audio First'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Instant Recluster Button */}
            <TouchableOpacity
              style={[
                styles.accentButton,
                (!hasDiarizedOnce || diarizeBusy || reclusterBusy) &&
                  styles.buttonDisabled,
              ]}
              onPress={() => {
                reclusterEngine().catch(() => {});
              }}
              disabled={!hasDiarizedOnce || diarizeBusy || reclusterBusy}
            >
              {reclusterBusy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="git-branch-outline" size={18} color="#FFFFFF" />
              )}
              <Text style={styles.buttonText}>Recluster (Instant)</Text>
            </TouchableOpacity>
          </View>

          {/* Diarization Progress Bar */}
          {diarizeBusy && (
            <View style={styles.progressContainer}>
              {progress > 0 ? (
                <>
                  <View style={styles.progressLabelRow}>
                    <Text style={styles.progressLabel}>
                      Diarizing audio frames…
                    </Text>
                    <Text style={styles.progressPercent}>{progress}%</Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <View
                      style={[styles.progressFill, { width: `${progress}%` }]}
                    />
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.progressLabelRow}>
                    <View style={styles.progressLabelWrap}>
                      <ActivityIndicator
                        size="small"
                        color="#0F62FE"
                        style={styles.progressSpinner}
                      />
                      <Text style={styles.progressLabel}>
                        Diarizing audio (segmentation & clustering)…
                      </Text>
                    </View>
                  </View>
                  <View style={styles.progressTrack}>
                    <Animated.View
                      style={[
                        styles.progressFill,
                        styles.progressFillIndeterminate,
                        { left: indeterminateLeft },
                      ]}
                    />
                  </View>
                </>
              )}
            </View>
          )}

          {executionError && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{executionError}</Text>
            </View>
          )}
        </View>

        {/* Module 3: Speaker Airtime & Timeline Analytics */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>3. Speaker Airtime & Analytics</Text>
            <TouchableOpacity
              style={styles.copyButtonRow}
              onPress={copyTimeline}
            >
              <Ionicons name="copy-outline" size={16} color="#0F62FE" />
              <Text style={styles.copyButtonText}>Copy Timeline</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.cardSubtitle}>
            Airtime distribution, turn counts, dominant speaker, and RTF
          </Text>

          {/* Proportional Stacked Airtime Bar */}
          <View style={styles.airtimeBar}>
            {totalSpeechTime > 0 ? (
              uniqueSpeakers.map((spk) => {
                const dur = speakerDurations[spk] ?? 0;
                const flex = Math.max(0.001, dur / totalSpeechTime);
                return (
                  <View
                    key={spk}
                    style={[
                      styles.airtimeSegment,
                      {
                        flex,
                        backgroundColor: getSpeakerColor(spk),
                      },
                    ]}
                  />
                );
              })
            ) : (
              <View style={styles.airtimeEmptyBar} />
            )}
          </View>

          {/* Active Speakers HUD & Aliases */}
          {uniqueSpeakers.length > 0 ? (
            <View style={styles.speakerGrid}>
              {uniqueSpeakers.map((spk) => {
                const dur = speakerDurations[spk] ?? 0;
                const pct =
                  totalSpeechTime > 0
                    ? ((dur / totalSpeechTime) * 100).toFixed(1)
                    : '0';
                const count = speakerTurnCounts[spk] ?? 0;
                return (
                  <View
                    key={spk}
                    style={[
                      styles.speakerCard,
                      { backgroundColor: getSpeakerBgColor(spk) },
                    ]}
                  >
                    <View style={styles.speakerCardTop}>
                      <View
                        style={[
                          styles.speakerBadge,
                          { backgroundColor: getSpeakerColor(spk) },
                        ]}
                      >
                        <Text style={styles.speakerBadgeText}>{spk}</Text>
                      </View>
                      <Text style={styles.speakerStatValue}>{pct}%</Text>
                    </View>

                    <TextInput
                      style={styles.speakerAliasInput}
                      value={speakerAliases[spk] ?? `Speaker ${spk}`}
                      onChangeText={(val) =>
                        setSpeakerAliases((prev) => ({
                          ...prev,
                          [spk]: val,
                        }))
                      }
                      placeholder={`Speaker ${spk}`}
                      placeholderTextColor="#9CA3AF"
                    />

                    <View style={styles.speakerStatsRow}>
                      <Text style={styles.speakerStatLabel}>Airtime</Text>
                      <Text style={styles.speakerStatValue}>
                        {formatDuration(dur)}
                      </Text>
                    </View>
                    <View style={styles.speakerStatsRow}>
                      <Text style={styles.speakerStatLabel}>Turns</Text>
                      <Text style={styles.speakerStatValue}>{count}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <View style={styles.emptyNotice}>
              <Text style={styles.emptyNoticeText}>
                No speaker clusters detected yet. Run diarization to identify
                speakers.
              </Text>
            </View>
          )}

          {/* 4-Card Analytics Grid */}
          <View style={styles.analyticsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Total Speech</Text>
              <Text style={styles.statBoxValue}>
                {formatDuration(totalSpeechTime)}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Turns Count</Text>
              <Text style={styles.statBoxValue}>{turns.length}</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Dominant Speaker</Text>
              <Text style={styles.statBoxValue}>
                {dominantSpeaker !== null
                  ? speakerAliases[dominantSpeaker] ??
                    `Speaker ${dominantSpeaker}`
                  : '—'}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statBoxLabel}>Processing / RTF</Text>
              <Text style={styles.statBoxValue}>
                {processingTimeMs > 0
                  ? `${processingTimeMs}ms (${rtf.toFixed(2)}x)`
                  : '—'}
              </Text>
            </View>
          </View>

          {/* Chronological Turn Timeline with Filters */}
          <Text style={styles.sectionTitle}>Turn Timeline</Text>
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
                All Turns ({turns.length})
              </Text>
            </TouchableOpacity>

            {uniqueSpeakers.map((spk) => (
              <TouchableOpacity
                key={spk}
                style={[
                  styles.toggleChip,
                  speakerFilter === spk && {
                    backgroundColor: getSpeakerColor(spk),
                    borderColor: getSpeakerColor(spk),
                  },
                ]}
                onPress={() =>
                  setSpeakerFilter((curr) => (curr === spk ? null : spk))
                }
              >
                <Text
                  style={[
                    styles.toggleChipText,
                    speakerFilter === spk && styles.toggleChipTextActive,
                  ]}
                >
                  {speakerAliases[spk] ?? `Speaker ${spk}`} (
                  {speakerTurnCounts[spk] ?? 0})
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {filteredTurns.length > 0 ? (
            <ScrollView
              style={styles.timelineList}
              nestedScrollEnabled
              showsVerticalScrollIndicator={true}
            >
              {filteredTurns.map((turn) => {
                const spkColor = getSpeakerColor(turn.speaker);
                const alias =
                  speakerAliases[turn.speaker] ?? `Speaker ${turn.speaker}`;
                return (
                  <View
                    key={turn.id}
                    style={[styles.timelineItem, { borderLeftColor: spkColor }]}
                  >
                    <View
                      style={[
                        styles.timelineSpeakerTag,
                        { backgroundColor: spkColor },
                      ]}
                    >
                      <Text style={styles.timelineSpeakerTagText}>{alias}</Text>
                    </View>

                    <View style={styles.timelineTimeInfo}>
                      <Text style={styles.timelineTimeRange}>
                        {formatTime(turn.startSec)} → {formatTime(turn.endSec)}
                      </Text>
                      <Text style={styles.timelineSampleRange}>
                        #{turn.startSample} - #{turn.endSample}
                      </Text>
                    </View>

                    <View style={styles.timelineDurationBadge}>
                      <Text style={styles.timelineDurationText}>
                        +{formatDuration(turn.durationSec)}
                      </Text>
                    </View>
                    {typeof turn.confidence === 'number' ? (
                      <View style={styles.timelineConfidenceBadge}>
                        <Text style={styles.timelineConfidenceText}>
                          {turn.confidence.toFixed(2)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          ) : (
            <View style={styles.emptyNotice}>
              <Text style={styles.emptyNoticeText}>
                {turns.length === 0
                  ? 'No speaker turns available. Run diarization to analyze the audio.'
                  : 'No turns match the selected speaker filter.'}
              </Text>
            </View>
          )}
        </View>

        {/* Module 4: Diagnostics & Event Log */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>4. Diagnostics & Log</Text>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setDiagnosticsExpanded((v) => !v)}
            >
              <Ionicons
                name={diagnosticsExpanded ? 'chevron-up' : 'chevron-down'}
                size={16}
                color="#374151"
              />
              <Text style={styles.secondaryButtonText}>
                {diagnosticsExpanded ? 'Collapse' : 'Expand'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.cardSubtitle}>
            State transitions, clustering timing, and audio metadata
          </Text>

          <View style={styles.statusBox}>
            <Text style={styles.statusText}>
              Engine: {engineInfo ? 'INITIALIZED' : 'IDLE'}
            </Text>
            <Text style={styles.statusDimText}>
              Seg Model: {engineInfo?.segId ?? 'None'}
            </Text>
            <Text style={styles.statusDimText}>
              Emb Model: {engineInfo?.embId ?? 'None'}
            </Text>
            <Text style={styles.statusDimText}>
              Threads: {engineInfo?.numThreads ?? numThreads} | Hop:{' '}
              {engineInfo?.windowShiftRatio ?? windowShiftRatio}
            </Text>
            <Text style={styles.statusDimText}>
              Clustering:{' '}
              {numClusters > 0
                ? `${numClusters} clusters (fixed)`
                : `Threshold ${clusteringThreshold.toFixed(2)}`}
            </Text>
            <Text style={styles.statusDimText}>
              Audio:{' '}
              {offlineInputBuffer
                ? `${offlineInputBuffer.sourceLabel}${
                    offlineInputBuffer.durationSeconds != null
                      ? ` (${offlineInputBuffer.durationSeconds.toFixed(2)}s`
                      : ''
                  }${
                    offlineInputBuffer.sampleRate != null
                      ? `, ${offlineInputBuffer.sampleRate}Hz)`
                      : offlineInputBuffer.durationSeconds != null
                      ? ')'
                      : ''
                  }`
                : 'None'}
            </Text>
            <Text style={styles.statusDimText}>
              Speakers Discovered: {uniqueSpeakers.length}
            </Text>
            <Text style={styles.statusDimText}>Turns: {turns.length}</Text>
            {processingTimeMs > 0 && (
              <Text style={styles.statusText}>
                Last Diarization: {processingTimeMs}ms (RTF: {rtf.toFixed(2)}x)
              </Text>
            )}
          </View>

          {diagnosticsExpanded && (
            <View>
              <View style={styles.cardHeader}>
                <Text style={[styles.sectionTitle, styles.eventsHeaderLabel]}>
                  Recent Events
                </Text>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setEvents([])}
                >
                  <Text style={styles.secondaryButtonText}>Clear</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.eventLogContainer}
                nestedScrollEnabled
                showsVerticalScrollIndicator={true}
              >
                {events.length > 0 ? (
                  events.map((ev) => (
                    <Text key={ev.id} style={styles.statusDimText}>
                      [{ev.time}] {ev.message}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.emptyNoticeText}>
                    No events logged yet.
                  </Text>
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
