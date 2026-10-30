import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  TurboModuleRegistry,
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
import { TEST_VIDEO_FILES } from '../../videoConfig';
import { styles } from './VideoPreviewScreen.styles';

const BUNDLED_VIDEO = TEST_VIDEO_FILES.PREVIEW_H264_AAC;
const SEEK_STEP_MS = 2000;

function resolveBundledAssetPath(relativePath: string): Promise<string> {
  const native = TurboModuleRegistry.getEnforcing('SherpaOnnx') as unknown as {
    resolveBundledAssetPath(path: string): Promise<string>;
  };
  return native.resolveBundledAssetPath(relativePath);
}

function log(phase: string, extra?: Record<string, unknown>): void {
  if (__DEV__) {
    console.log('[VideoPreviewExample]', { phase, ...extra });
  }
}

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
    log('player_error', { code: error.code, message: error.message });
    setPlayError(`${error.code}: ${error.message}`);
  }, []);

  const onAudioUnavailable = useCallback(
    (event: VideoPreviewAudioUnavailableEvent) => {
      log('audio_unavailable', {
        reason: event.reason,
        code: event.code,
        codec: event.codec,
      });
      setAudioHint(
        `Video continues without sound (${event.reason}: ${event.code}${
          event.codec ? ` ${event.codec}` : ''
        }).`
      );
    },
    []
  );

  const status = useVideoPreviewStatus(player, { smoothPosition: true });

  useEffect(() => {
    let cancelled = false;
    let playerLocal: VideoPreviewPlayer | null = null;
    let bufferLocal: OfflineVideoBufferRef | null = null;

    const releaseAll = async (reason: string) => {
      if (playerLocal) {
        const currentPlayer = playerLocal;
        playerLocal = null;
        log('release_player', { reason, playerId: currentPlayer.playerId });
        try {
          await currentPlayer.release();
        } catch (e) {
          log('release_player_failed', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (bufferLocal) {
        const currentBuffer = bufferLocal;
        bufferLocal = null;
        log('release_buffer', { reason, bufferId: currentBuffer.bufferId });
        try {
          await releaseVideoBuffer(currentBuffer);
        } catch (e) {
          log('release_buffer_failed', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    setLoading(true);
    setLoadError(null);
    setPlayError(null);
    setAudioHint(null);

    void (async () => {
      try {
        log('resolve_asset', { relativePath: BUNDLED_VIDEO });
        const path = await resolveBundledAssetPath(BUNDLED_VIDEO);
        if (cancelled) return;
        log('create_buffer', { path });
        const created = await createOfflineVideoBufferFromFile(path);
        bufferLocal = created;
        if (cancelled) {
          await releaseAll('create_buffer_cancelled');
          return;
        }
        setBuffer(created);
        log('buffer_ready', {
          bufferId: created.bufferId,
          durationUs: created.info.seekableEndUs,
          frameCount: created.info.frameCount,
          audio: created.info.audio,
        });
        const createdPlayer = await createVideoPreviewPlayer(created, {
          audio: { source: 'track', required: false },
          progressIntervalMs: 250,
          onError,
          onAudioUnavailable,
        });
        playerLocal = createdPlayer;
        if (cancelled) {
          await releaseAll('create_player_cancelled');
          return;
        }
        setPlayer(createdPlayer);
        log('player_ready', {
          playerId: createdPlayer.playerId,
          bufferId: createdPlayer.bufferId,
          state: createdPlayer.initialSnapshot.state,
          audio: createdPlayer.initialSnapshot.audio,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log('load_failed', { message });
        if (!cancelled) {
          setLoadError(message);
        }
        await releaseAll('load_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void releaseAll('unmount');
    };
  }, [onAudioUnavailable, onError]);

  const durationMs = status?.durationMs ?? 0;
  const positionMs = status?.positionMs ?? 0;
  const playing = status?.state === 'playing';
  const ready = player != null && status != null && status.state !== 'released';

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!player) return;
      try {
        log(label, { playerId: player.playerId, state: status?.state });
        await fn();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`${label}_failed`, { message });
        setPlayError(message);
      }
    },
    [player, status?.state]
  );

  const onPlayPause = useCallback(() => {
    if (!player) return;
    if (playing) {
      void run('pause', () => player.pause());
      return;
    }
    void run('play', () => player.play());
  }, [player, playing, run]);

  const onSeekBy = useCallback(
    (deltaMs: number) => {
      if (!player) return;
      void run('seek_by', () => player.seekBy(deltaMs));
    },
    [player, run]
  );

  const onStep = useCallback(
    (direction: 1 | -1) => {
      if (!player) return;
      void run('step_frame', () => player.stepFrame(direction));
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
      void run('seek_to', () => player.seekTo(targetMs));
    },
    [durationMs, player, run, seekWidth]
  );

  const onToggleLoop = useCallback(
    (next: boolean) => {
      setLoop(next);
      if (player) {
        void run('set_loop', () => player.setLoop(next));
      }
    },
    [player, run]
  );

  const onToggleMuted = useCallback(
    (next: boolean) => {
      setMuted(next);
      if (player) {
        void run('set_muted', () => player.setMuted(next));
      }
    },
    [player, run]
  );

  const fillRatio =
    durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScreenIntroModal screenId="VideoPreview" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bundled clip</Text>
          <Text style={styles.sectionHint}>
            Loads the bundled clip via resolveBundledAssetPath, then
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
              <Ionicons
                name={playing ? 'pause' : 'play'}
                size={20}
                color="#fff"
              />
              <Text style={styles.primaryButtonText}>
                {playing ? 'Pause' : 'Play'}
              </Text>
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
