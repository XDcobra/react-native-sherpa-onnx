import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  computeAudioVisualizationProfile,
  type AudioVisualizationProfile,
} from 'react-native-sherpa-onnx/visualization';
import { CODEC_ASSET_ENTRIES, type CodecAssetFormat } from '../../audioConfig';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { Spectrum3DView } from '../../components/Spectrum3DView';
import { SpectrumBarsView } from '../../components/SpectrumBarsView';
import { SpectrumHeatmapView } from '../../components/SpectrumHeatmapView';
import { describeFileSource } from '../../utils/fileSourceFromUri';
import {
  pickFileioInputForChannel,
  resolveBundledCodecSource,
  type FileioInputSource,
} from '../fileio/fileioInputChannels';
import {
  debugLogComputedProfile,
  debugLogDisplayPipeline,
} from './audioVisualizationDebug';
import { styles } from './AudioVisualizationScreen.styles';

type ViewMode = 'static' | 'animated' | 'heatmap' | '3d';

const SAMPLE_FORMATS: CodecAssetFormat[] = ['wav', 'mp3', 'm4a'];

const COMPUTE_OPTIONS = {
  kind: 'spectrum_bars' as const,
  barCount: 96,
  // mean across timeline frames for static levels; per-frame rows still use max_hold buckets
  timeAggregate: 'mean' as const,
  includeTimeline: true,
  frameDurationMs: 500,
  maxAnalysisDurationMs: 120_000,
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0:00';
  }

  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function frameLevels(
  profile: AudioVisualizationProfile,
  frameIndex: number
): number[] {
  const { barCount, frames, frameCount } = profile;
  if (
    !(frames instanceof Float32Array) ||
    frameIndex < 0 ||
    frameIndex >= frameCount
  ) {
    return [];
  }

  const offset = frameIndex * barCount;
  return Array.from(
    { length: barCount },
    (_, bar) => frames[offset + bar] ?? 0
  );
}

function hasTimeline(profile: AudioVisualizationProfile | null): boolean {
  return (
    !!profile &&
    profile.frameCount > 0 &&
    profile.frames instanceof Float32Array &&
    profile.frames.length >= profile.frameCount * profile.barCount
  );
}

function normalizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : String(error);

  if (message.includes('AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE')) {
    return 'Visualization payload too large. Try fewer frames or a shorter audio file.';
  }

  return message;
}

export default function AudioVisualizationScreen() {
  const [selectedSource, setSelectedSource] =
    useState<FileioInputSource | null>(null);

  const [selectedSampleFormat, setSelectedSampleFormat] =
    useState<CodecAssetFormat | null>(null);

  const [profile, setProfile] = useState<AudioVisualizationProfile | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('static');
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sliderWidth, setSliderWidth] = useState(0);

  const requestIdRef = useRef(0);

  const timelineAvailable = hasTimeline(profile);

  useEffect(() => {
    if (viewMode === 'static') {
      setIsPlaying(false);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!profile) {
      setActiveFrameIndex(0);
      return;
    }
    setActiveFrameIndex((prev) =>
      Math.max(0, Math.min(prev, profile.frameCount - 1))
    );
  }, [profile]);

  useEffect(() => {
    if (!timelineAvailable && viewMode !== 'static') {
      setViewMode('static');
      setIsPlaying(false);
    }
  }, [timelineAvailable, viewMode]);

  useEffect(() => {
    if (!timelineAvailable || !profile || !isPlaying || viewMode === 'static') {
      return;
    }

    const intervalMs = Math.max(80, Math.round(profile.frameDurationMs || 250));
    const timer = setInterval(() => {
      setActiveFrameIndex(
        (prev) => (prev + 1) % Math.max(1, profile.frameCount)
      );
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [isPlaying, profile, timelineAvailable, viewMode]);

  useEffect(() => {
    if (!selectedSource) {
      return;
    }

    let cancelled = false;
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);
    setProfile(null);
    setActiveFrameIndex(0);
    setIsPlaying(false);

    (async () => {
      try {
        const nextProfile = await computeAudioVisualizationProfile(
          { kind: 'file', source: selectedSource.fileSource },
          COMPUTE_OPTIONS
        );

        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }

        debugLogComputedProfile(nextProfile, {
          sourceLabel: selectedSource.label,
        });
        setProfile(nextProfile);
      } catch (computeError) {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }

        const message = normalizeError(computeError);
        setError(message);
        Alert.alert('Compute failed', message);
      } finally {
        if (!cancelled && requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [selectedSource]);

  const onPickAudio = useCallback(async () => {
    try {
      const picked = await pickFileioInputForChannel(
        Platform.OS === 'ios' ? 'securityScoped' : 'contentUri'
      );
      if (!picked) {
        return;
      }
      setSelectedSampleFormat(null);
      setSelectedSource(picked);
    } catch (pickError) {
      const message = normalizeError(pickError);
      Alert.alert('Pick failed', message);
    }
  }, []);

  const onSelectBundledSample = useCallback((format: CodecAssetFormat) => {
    setSelectedSampleFormat(format);
    setSelectedSource(resolveBundledCodecSource(format));
  }, []);

  const onSwitchMode = useCallback(
    (mode: ViewMode) => {
      if (
        (mode === 'animated' || mode === 'heatmap' || mode === '3d') &&
        !timelineAvailable
      ) {
        return;
      }
      setViewMode(mode);
    },
    [timelineAvailable]
  );

  const onSliderLayout = useCallback((event: LayoutChangeEvent) => {
    setSliderWidth(event.nativeEvent.layout.width);
  }, []);

  const applyFrameIndexFromPress = useCallback(
    (event: GestureResponderEvent) => {
      if (!profile || profile.frameCount <= 1 || sliderWidth <= 0) {
        return;
      }

      const x = Math.max(0, Math.min(sliderWidth, event.nativeEvent.locationX));
      const ratio = x / sliderWidth;
      const next = Math.round(ratio * (profile.frameCount - 1));
      setActiveFrameIndex(next);
    },
    [profile, sliderWidth]
  );

  const currentFrameLevels = useMemo(() => {
    if (!profile || !timelineAvailable) {
      return [];
    }
    return frameLevels(profile, activeFrameIndex);
  }, [activeFrameIndex, profile, timelineAvailable]);

  const barsLevels = useMemo(() => {
    if (viewMode === 'animated' && timelineAvailable) {
      return currentFrameLevels;
    }
    return profile?.levels ?? [];
  }, [currentFrameLevels, profile?.levels, timelineAvailable, viewMode]);

  const debugDisplayLevels =
    viewMode === '3d' && timelineAvailable ? currentFrameLevels : barsLevels;

  const frameInsights = useMemo(() => {
    if (!timelineAvailable || !profile || currentFrameLevels.length === 0) {
      return null;
    }

    let sum = 0;
    let peak = 0;
    let peakIndex = 0;
    let activeBars = 0;
    for (let i = 0; i < currentFrameLevels.length; i += 1) {
      const value = Math.max(0, Math.min(1, currentFrameLevels[i] ?? 0));
      sum += value;
      if (value > peak) {
        peak = value;
        peakIndex = i;
      }
      if (value >= 0.15) {
        activeBars += 1;
      }
    }

    const mean = sum / currentFrameLevels.length;
    const previousFrame =
      activeFrameIndex > 0 ? frameLevels(profile, activeFrameIndex - 1) : [];
    let motion = 0;
    if (previousFrame.length === currentFrameLevels.length) {
      let diff = 0;
      for (let i = 0; i < currentFrameLevels.length; i += 1) {
        diff += Math.abs(
          (currentFrameLevels[i] ?? 0) - (previousFrame[i] ?? 0)
        );
      }
      motion = diff / currentFrameLevels.length;
    }

    return {
      energyPct: Math.round(mean * 100),
      peakPct: Math.round(peak * 100),
      peakIndex,
      activeBars,
      motionPct: Math.round(motion * 100),
      activeRatioPct: Math.round(
        (activeBars / currentFrameLevels.length) * 100
      ),
    };
  }, [activeFrameIndex, currentFrameLevels, profile, timelineAvailable]);

  useEffect(() => {
    if (!profile || loading) {
      return;
    }
    debugLogDisplayPipeline({
      viewMode,
      profile,
      displayLevels: debugDisplayLevels,
      activeFrameIndex,
      timelineAvailable,
    });
  }, [
    activeFrameIndex,
    debugDisplayLevels,
    loading,
    profile,
    timelineAvailable,
    viewMode,
  ]);

  const frameProgressPct =
    profile && profile.frameCount > 1
      ? (activeFrameIndex / Math.max(1, profile.frameCount - 1)) * 100
      : 0;

  const activeSampleLabel =
    selectedSampleFormat != null
      ? CODEC_ASSET_ENTRIES.find(
          (entry) => entry.format === selectedSampleFormat
        )?.label ?? selectedSampleFormat.toUpperCase()
      : null;

  return (
    <SafeAreaView style={styles.root} edges={['bottom', 'left', 'right']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Audio input</Text>
          <Text style={styles.sectionHint}>
            Use a bundled test_codec sample from the example app, or pick any
            audio file from your device.
          </Text>

          <Text style={styles.subsectionLabel}>
            Bundled samples (test_codec)
          </Text>
          <View style={styles.rowWrap}>
            {SAMPLE_FORMATS.map((format) => {
              const active = selectedSampleFormat === format;
              const label =
                CODEC_ASSET_ENTRIES.find((entry) => entry.format === format)
                  ?.label ?? format.toUpperCase();

              return (
                <Pressable
                  key={format}
                  style={[styles.chip, active ? styles.chipActive : null]}
                  onPress={() => onSelectBundledSample(format)}
                >
                  <Text style={styles.chipText}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.inputDividerRow}>
            <View style={styles.inputDividerLine} />
            <Text style={styles.inputDividerText}>or</Text>
            <View style={styles.inputDividerLine} />
          </View>

          <Pressable style={styles.pickButtonOutline} onPress={onPickAudio}>
            <Text style={styles.pickButtonOutlineText}>
              Pick audio from device
            </Text>
          </Pressable>

          {selectedSource ? (
            <>
              <Text style={styles.sourceLabel}>
                Selected: {selectedSource.label}
                {activeSampleLabel ? ` (${activeSampleLabel})` : ''}
              </Text>
              <Text style={styles.sourceMeta}>
                {describeFileSource(selectedSource.fileSource)}
              </Text>
            </>
          ) : (
            <Text style={styles.inlineInfoText}>
              Select a bundled sample above or pick a file to start.
            </Text>
          )}
        </View>

        {loading ? (
          <View style={styles.section}>
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#007AFF" />
              <Text style={styles.loadingText}>Computing spectrum...</Text>
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.section}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {!loading && !profile && !error ? (
          <View style={styles.placeholderSection}>
            <Text style={styles.placeholderText}>
              One compute run fills Static, Animated, Heatmap, and 3D views.
            </Text>
          </View>
        ) : null}

        {profile ? (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Profile metadata</Text>
              <View style={styles.metaGrid}>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>duration</Text>
                  <Text style={styles.metaValue}>
                    {formatMs(profile.durationMs)}
                  </Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>sample rate</Text>
                  <Text style={styles.metaValue}>{profile.sampleRate} Hz</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>bar count</Text>
                  <Text style={styles.metaValue}>{profile.barCount}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>frames</Text>
                  <Text style={styles.metaValue}>{profile.frameCount}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaLabel}>frame ms</Text>
                  <Text style={styles.metaValue}>
                    {profile.frameDurationMs}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>View mode</Text>
              <View style={styles.segmented}>
                <Pressable
                  style={[
                    styles.segmentButton,
                    viewMode === 'static' ? styles.segmentButtonActive : null,
                  ]}
                  onPress={() => onSwitchMode('static')}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      viewMode === 'static' ? styles.segmentTextActive : null,
                    ]}
                  >
                    Static
                  </Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.segmentButton,
                    viewMode === 'animated' ? styles.segmentButtonActive : null,
                    !timelineAvailable ? styles.segmentButtonDisabled : null,
                  ]}
                  onPress={() => onSwitchMode('animated')}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      viewMode === 'animated' ? styles.segmentTextActive : null,
                    ]}
                  >
                    Animated
                  </Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.segmentButton,
                    viewMode === 'heatmap' ? styles.segmentButtonActive : null,
                    !timelineAvailable ? styles.segmentButtonDisabled : null,
                  ]}
                  onPress={() => onSwitchMode('heatmap')}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      viewMode === 'heatmap' ? styles.segmentTextActive : null,
                    ]}
                  >
                    Heatmap
                  </Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.segmentButton,
                    viewMode === '3d' ? styles.segmentButtonActive : null,
                    !timelineAvailable ? styles.segmentButtonDisabled : null,
                  ]}
                  onPress={() => onSwitchMode('3d')}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      viewMode === '3d' ? styles.segmentTextActive : null,
                    ]}
                  >
                    3D
                  </Text>
                </Pressable>
              </View>

              {viewMode === 'heatmap' ? (
                <SpectrumHeatmapView
                  frames={profile.frames}
                  frameCount={profile.frameCount}
                  barCount={profile.barCount}
                  activeFrameIndex={activeFrameIndex}
                  height={210}
                />
              ) : viewMode === '3d' ? (
                <Spectrum3DView
                  levels={currentFrameLevels}
                  barCount={profile.barCount}
                  height={210}
                />
              ) : (
                <SpectrumBarsView
                  levels={barsLevels}
                  barCount={profile.barCount}
                  height={200}
                  mirrored
                />
              )}

              {!timelineAvailable ? (
                <Text style={styles.disabledNote}>
                  Timeline not available. Animated, Heatmap, and 3D need
                  timeline frames.
                </Text>
              ) : null}

              {viewMode === '3d' ? (
                <Text style={styles.chartNote}>
                  Example UI only: pseudo-3D rendered with Skia from SDK frame
                  data, not a native SDK 3D feature.
                </Text>
              ) : null}

              {viewMode === '3d' && frameInsights ? (
                <View style={styles.insightGrid}>
                  <View style={styles.insightCard}>
                    <Text style={styles.insightLabel}>Energy</Text>
                    <Text style={styles.insightValue}>
                      {frameInsights.energyPct}%
                    </Text>
                  </View>
                  <View style={styles.insightCard}>
                    <Text style={styles.insightLabel}>Peak Bin</Text>
                    <Text style={styles.insightValue}>
                      #{frameInsights.peakIndex + 1} ({frameInsights.peakPct}%)
                    </Text>
                  </View>
                  <View style={styles.insightCard}>
                    <Text style={styles.insightLabel}>Active Bins</Text>
                    <Text style={styles.insightValue}>
                      {frameInsights.activeBars}/{profile.barCount} (
                      {frameInsights.activeRatioPct}%)
                    </Text>
                  </View>
                  <View style={styles.insightCard}>
                    <Text style={styles.insightLabel}>Frame Motion</Text>
                    <Text style={styles.insightValue}>
                      {frameInsights.motionPct}%
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>

            {viewMode !== 'static' ? (
              <View style={styles.timelineControls}>
                <Text style={styles.timelineSummary}>
                  {formatMs(activeFrameIndex * profile.frameDurationMs)} /{' '}
                  {formatMs(profile.durationMs)} (frame {activeFrameIndex + 1}/
                  {Math.max(1, profile.frameCount)})
                </Text>

                <View style={styles.transportRow}>
                  <View style={styles.transportButtons}>
                    <Pressable
                      style={[
                        styles.transportButton,
                        activeFrameIndex <= 0
                          ? styles.transportButtonDisabled
                          : null,
                      ]}
                      onPress={() =>
                        setActiveFrameIndex((prev) => Math.max(0, prev - 1))
                      }
                      disabled={activeFrameIndex <= 0}
                    >
                      <Text style={styles.transportButtonText}>{'<'}</Text>
                    </Pressable>

                    <Pressable
                      style={styles.transportButton}
                      onPress={() => setIsPlaying((prev) => !prev)}
                    >
                      <Text style={styles.transportButtonText}>
                        {isPlaying ? 'Pause' : 'Play'}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={[
                        styles.transportButton,
                        activeFrameIndex >= profile.frameCount - 1
                          ? styles.transportButtonDisabled
                          : null,
                      ]}
                      onPress={() =>
                        setActiveFrameIndex((prev) =>
                          Math.min(
                            Math.max(0, profile.frameCount - 1),
                            prev + 1
                          )
                        )
                      }
                      disabled={activeFrameIndex >= profile.frameCount - 1}
                    >
                      <Text style={styles.transportButtonText}>{'>'}</Text>
                    </Pressable>
                  </View>

                  <Text style={styles.inlineInfoText}>
                    step {profile.frameDurationMs} ms
                  </Text>
                </View>

                <Pressable
                  style={styles.progressTrack}
                  onLayout={onSliderLayout}
                  onPress={applyFrameIndexFromPress}
                >
                  <View style={styles.progressRail}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${frameProgressPct}%` },
                      ]}
                    />
                  </View>
                  <View
                    style={[
                      styles.progressThumb,
                      { left: `${frameProgressPct}%` },
                    ]}
                  />
                </Pressable>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <ScreenIntroModal screenId="AudioVisualization" />
    </SafeAreaView>
  );
}
