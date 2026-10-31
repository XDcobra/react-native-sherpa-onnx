import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Switch,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  useVideoPreviewStatus,
  VideoPreviewView,
  type VideoPreviewPlayer,
} from 'react-native-sherpa-onnx/videopreview';
import { styles } from './ExampleVideoPreviewPlayer.styles';

const SEEK_STEP_MS = 2000;

function formatClock(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(clamped / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export type ExampleVideoPreviewPlayerProps = {
  player: VideoPreviewPlayer | null;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  showSeekBy?: boolean;
  showFrameStep?: boolean;
  showLoop?: boolean;
  showMute?: boolean;
  onPlayError?: (message: string) => void;
  style?: StyleProp<ViewStyle>;
};

export function ExampleVideoPreviewPlayer({
  player,
  loading = false,
  loadingLabel = 'Creating OfflineVideoBuffer…',
  emptyLabel = 'No player — check the load error above.',
  showSeekBy = true,
  showFrameStep = true,
  showLoop = true,
  showMute = true,
  onPlayError,
  style,
}: ExampleVideoPreviewPlayerProps) {
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [seekWidth, setSeekWidth] = useState(0);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const status = useVideoPreviewStatus(player);

  const durationMs = status?.durationMs ?? 0;
  const positionMs = status?.positionMs ?? 0;
  const displayMs = scrubMs ?? positionMs;
  const playing = status?.state === 'playing';
  const ended = status?.state === 'ended';
  const ready = player != null && status != null && status.state !== 'released';
  const playLabel = playing ? 'Pause' : ended ? 'Restart' : 'Play';
  const playIcon = playing ? 'pause' : ended ? 'refresh' : 'play';
  const fillRatio =
    durationMs > 0 ? Math.max(0, Math.min(1, displayMs / durationMs)) : 0;

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
        onPlayError?.(code ? `${code}: ${message}` : message);
      }
    },
    [onPlayError, player]
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

  const seekFromLocationX = useCallback(
    (x: number) => {
      if (!player || durationMs <= 0 || seekWidth <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / seekWidth));
      const targetMs = Math.round(ratio * durationMs);
      setScrubMs(targetMs);
      void run(() => player.seekTo(targetMs));
    },
    [durationMs, player, run, seekWidth]
  );

  const onSeekGrant = useCallback(
    (event: GestureResponderEvent) => {
      seekFromLocationX(event.nativeEvent.locationX);
    },
    [seekFromLocationX]
  );

  const onSeekMove = useCallback(
    (event: GestureResponderEvent) => {
      seekFromLocationX(event.nativeEvent.locationX);
    },
    [seekFromLocationX]
  );

  const onSeekRelease = useCallback(() => {
    setScrubMs(null);
  }, []);

  useEffect(() => {
    if (!player) return;
    void player.setLoop(loop).catch(() => undefined);
  }, [loop, player]);

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
    <View style={style}>
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
              {loading ? loadingLabel : emptyLabel}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.clockRow}>
        <Text style={styles.clock}>{formatClock(displayMs)}</Text>
        <Text style={styles.clock}>
          {durationMs > 0 ? formatClock(durationMs) : '—'}
        </Text>
      </View>
      <View
        style={styles.seekTrack}
        onLayout={onSeekTrackLayout}
        onStartShouldSetResponder={() => ready && durationMs > 0}
        onMoveShouldSetResponder={() => ready && durationMs > 0}
        onResponderGrant={onSeekGrant}
        onResponderMove={onSeekMove}
        onResponderRelease={onSeekRelease}
        onResponderTerminate={onSeekRelease}
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityValue={{
          min: 0,
          max: Math.max(0, Math.round(durationMs)),
          now: Math.round(displayMs),
        }}
      >
        <View style={styles.seekRail}>
          <View style={[styles.seekFill, { width: `${fillRatio * 100}%` }]} />
        </View>
        <View style={[styles.seekThumb, { left: `${fillRatio * 100}%` }]} />
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.primaryButton, !ready && styles.primaryButtonDisabled]}
          onPress={onPlayPause}
          disabled={!ready}
          activeOpacity={0.7}
        >
          <Ionicons name={playIcon} size={20} color="#fff" />
          <Text style={styles.primaryButtonText}>{playLabel}</Text>
        </TouchableOpacity>
      </View>

      {showSeekBy ? (
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
      ) : null}

      {showFrameStep ? (
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
      ) : null}

      {showLoop ? (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Loop</Text>
          <Switch value={loop} onValueChange={setLoop} disabled={!ready} />
        </View>
      ) : null}
      {showMute ? (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Mute</Text>
          <Switch
            value={muted}
            onValueChange={onToggleMuted}
            disabled={!ready}
          />
        </View>
      ) : null}
    </View>
  );
}
