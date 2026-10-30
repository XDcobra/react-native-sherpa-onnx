import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createOfflineVideoBufferFromFile,
  releaseVideoBuffer,
  type OfflineVideoBufferRef,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  createVideoPreviewPlayer,
  useVideoPreviewStatus,
  VideoPreviewView,
  type VideoPreviewAudioStatus,
  type VideoPreviewAudioUnavailableEvent,
  type VideoPreviewError,
  type VideoPreviewPlayer,
} from 'react-native-sherpa-onnx/videopreview';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { fileSourceFromBundledPath } from '../../utils/fileSourceFromUri';
import { TEST_VIDEO_FILES } from '../../videoConfig';
import { styles } from './VideoPreviewScreen.styles';

const BUNDLED_VIDEO = TEST_VIDEO_FILES.PREVIEW_H264_AAC;
const SEEK_STEP_MS = 2000;

function formatClock(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(clamped / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function describeAudio(audio: VideoPreviewAudioStatus | undefined): string {
  if (audio == null) return '—';
  if (audio.status === 'playing' || audio.status === 'muted') {
    return `${audio.status} ${audio.codec} ${audio.sampleRate}Hz/${audio.channels}ch`;
  }
  if (audio.status === 'unavailable') {
    return `${audio.status} ${audio.reason}`;
  }
  if (audio.status === 'interrupted') {
    return `${audio.status} ${audio.reason}`;
  }
  return audio.status;
}

export default function VideoPreviewScreen() {
  const [buffer, setBuffer] = useState<OfflineVideoBufferRef | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [audioHint, setAudioHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [seekWidth, setSeekWidth] = useState(0);
  const [player, setPlayer] = useState<VideoPreviewPlayer | null>(null);

  const onError = useCallback((error: VideoPreviewError) => {
    setPlayError(`${error.code}: ${error.message}`);
  }, []);

  const onAudioUnavailable = useCallback(
    (event: VideoPreviewAudioUnavailableEvent) => {
      setAudioHint(
        `Video continues without sound (${event.reason}: ${event.code}${
          event.codec ? ` ${event.codec}` : ''
        }).`
      );
    },
    []
  );

  const status = useVideoPreviewStatus(player);

  useEffect(() => {
    let cancelled = false;
    let playerLocal: VideoPreviewPlayer | null = null;
    let bufferLocal: OfflineVideoBufferRef | null = null;

    const releaseAll = async () => {
      if (playerLocal) {
        const currentPlayer = playerLocal;
        playerLocal = null;
        try {
          await currentPlayer.release();
        } catch {
          // ignore
        }
      }
      if (bufferLocal) {
        const currentBuffer = bufferLocal;
        bufferLocal = null;
        try {
          await releaseVideoBuffer(currentBuffer);
        } catch {
          // ignore
        }
      }
    };

    setLoading(true);
    setLoadError(null);
    setPlayError(null);
    setAudioHint(null);

    void (async () => {
      try {
        const created = await createOfflineVideoBufferFromFile(
          fileSourceFromBundledPath(BUNDLED_VIDEO)
        );
        bufferLocal = created;
        if (cancelled) {
          await releaseAll();
          return;
        }
        setBuffer(created);
        const createdPlayer = await createVideoPreviewPlayer(created, {
          audio: { source: 'track', required: false },
          progressIntervalMs: 250,
          onError,
          onAudioUnavailable,
        });
        playerLocal = createdPlayer;
        if (cancelled) {
          await releaseAll();
          return;
        }
        setPlayer(createdPlayer);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setLoadError(message);
        }
        await releaseAll();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void releaseAll();
    };
  }, [onAudioUnavailable, onError]);

  const durationMs = status?.durationMs ?? 0;
  const positionMs = status?.positionMs ?? 0;
  const playing = status?.state === 'playing';
  const ended = status?.state === 'ended';
  const ready = player != null && status != null && status.state !== 'released';
  const playLabel = playing ? 'Pause' : ended ? 'Restart' : 'Play';
  const playIcon = playing ? 'pause' : ended ? 'refresh' : 'play';
  const fillRatio =
    durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!player) return;
      try {
        await fn();
      } catch (e) {
        const code =
          e && typeof e === 'object' && 'code' in e
            ? String((e as { code?: unknown }).code ?? '')
            : '';
        const message = e instanceof Error ? e.message : String(e);
        setPlayError(code ? `${code}: ${message}` : message);
      }
    },
    [player]
  );

  const onPlayPause = useCallback(() => {
    if (!player) return;
    if (playing) {
      void run(() => player.pause());
      return;
    }
    void run(() => player.play());
  }, [player, playing, run]);

  const onSeekBy = useCallback(
    (deltaMs: number) => {
      if (!player) return;
      void run(() => player.seekBy(deltaMs));
    },
    [player, run]
  );

  const onStep = useCallback(
    (direction: 1 | -1) => {
      if (!player) return;
      void run(() => player.stepFrame(direction));
    },
    [player, run]
  );

  const onSeekTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setSeekWidth(event.nativeEvent.layout.width);
  }, []);

  const onSeekTrackPress = useCallback(
    (event: GestureResponderEvent) => {
      if (!player || durationMs <= 0 || seekWidth <= 0) return;
      const x = event.nativeEvent.locationX;
      const ratio = Math.max(0, Math.min(1, x / seekWidth));
      const targetMs = Math.round(ratio * durationMs);
      void run(() => player.seekTo(targetMs));
    },
    [durationMs, player, run, seekWidth]
  );

  useEffect(() => {
    if (!player) return;
    void player.setLoop(loop).catch(() => undefined);
  }, [loop, player]);

  const onToggleLoop = useCallback((next: boolean) => {
    setLoop(next);
  }, []);

  const onToggleMuted = useCallback(
    (next: boolean) => {
      setMuted(next);
      if (player) {
        void run(() => player.setMuted(next));
      }
    },
    [player, run]
  );

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="VideoPreview" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bundled clip</Text>
          <Text style={styles.sectionHint}>
            Loads the bundled clip as a FileSource (apkAsset / appBundle), then
            createOfflineVideoBufferFromFile and createVideoPreviewPlayer.
          </Text>
          <Text style={styles.mono}>{BUNDLED_VIDEO}</Text>
          {buffer ? (
            <Text style={styles.mono}>buffer {buffer.bufferId}</Text>
          ) : null}
        </View>

        {loadError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Failed to load video</Text>
            <Text style={styles.errorText}>{loadError}</Text>
          </View>
        ) : null}
        {playError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Player error</Text>
            <Text style={styles.errorText}>{playError}</Text>
          </View>
        ) : null}
        {audioHint ? (
          <View style={styles.hintBox}>
            <Text style={styles.hintText}>{audioHint}</Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Preview</Text>
          <View style={styles.playerFrame}>
            {player ? (
              <VideoPreviewView
                player={player}
                resizeMode="contain"
                style={styles.player}
              />
            ) : (
              <View style={styles.playerPlaceholder}>
                {loading ? <ActivityIndicator color="#94a3b8" /> : null}
                <Text style={styles.playerPlaceholderText}>
                  {loading
                    ? 'Creating OfflineVideoBuffer…'
                    : 'No player — check the load error above.'}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.clockRow}>
            <Text style={styles.clock}>{formatClock(positionMs)}</Text>
            <Text style={styles.clock}>
              {durationMs > 0 ? formatClock(durationMs) : '—'}
            </Text>
          </View>
          <Pressable
            style={styles.seekTrack}
            onLayout={onSeekTrackLayout}
            onPress={onSeekTrackPress}
            disabled={!ready || durationMs <= 0}
          >
            <View style={styles.seekTrackBg}>
              <View
                style={[styles.seekTrackFill, { width: `${fillRatio * 100}%` }]}
              />
            </View>
          </Pressable>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                !ready && styles.primaryButtonDisabled,
              ]}
              onPress={onPlayPause}
              disabled={!ready}
              activeOpacity={0.7}
            >
              <Ionicons name={playIcon} size={20} color="#fff" />
              <Text style={styles.primaryButtonText}>{playLabel}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => onSeekBy(-SEEK_STEP_MS)}
              disabled={!ready}
              activeOpacity={0.7}
            >
              <Ionicons name="play-back" size={18} color="#0f172a" />
              <Text style={styles.secondaryButtonText}>-2s</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => onSeekBy(SEEK_STEP_MS)}
              disabled={!ready}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryButtonText}>+2s</Text>
              <Ionicons name="play-forward" size={18} color="#0f172a" />
            </TouchableOpacity>
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => onStep(-1)}
              disabled={!ready}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryButtonText}>Prev frame</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => onStep(1)}
              disabled={!ready}
              activeOpacity={0.7}
            >
              <Text style={styles.secondaryButtonText}>Next frame</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Loop</Text>
            <Switch
              value={loop}
              onValueChange={onToggleLoop}
              disabled={!ready}
            />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Mute</Text>
            <Switch
              value={muted}
              onValueChange={onToggleMuted}
              disabled={!ready}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Status</Text>
          <View style={styles.statusRow}>
            <View style={styles.statusChip}>
              <Text style={styles.statusLabel}>State</Text>
              <Text style={styles.statusValue}>{status?.state ?? '—'}</Text>
            </View>
            <View style={styles.statusChip}>
              <Text style={styles.statusLabel}>Audio</Text>
              <Text style={styles.statusValue}>
                {describeAudio(status?.audio)}
              </Text>
            </View>
            <View style={styles.statusChip}>
              <Text style={styles.statusLabel}>Frames</Text>
              <Text style={styles.statusValue}>
                {status
                  ? `${status.stats.framesRendered} shown / ${status.stats.framesDropped} drop`
                  : '—'}
              </Text>
            </View>
            <View style={styles.statusChip}>
              <Text style={styles.statusLabel}>A/V offset</Text>
              <Text style={styles.statusValue}>
                {status ? `${status.stats.avOffsetMs} ms` : '—'}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
