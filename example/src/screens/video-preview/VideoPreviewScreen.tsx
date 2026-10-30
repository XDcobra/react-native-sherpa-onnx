import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  createOfflineVideoBufferFromFile,
  releaseVideoBuffer,
  type OfflineVideoBufferRef,
} from 'react-native-sherpa-onnx/videobuffer';
import {
  createVideoPreviewPlayer,
  useVideoPreviewStatus,
  type VideoPreviewAudioStatus,
  type VideoPreviewAudioUnavailableEvent,
  type VideoPreviewError,
  type VideoPreviewPlayer,
} from 'react-native-sherpa-onnx/videopreview';
import { ExampleVideoPreviewPlayer } from '../../components/ExampleVideoPreviewPlayer';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { fileSourceFromBundledPath } from '../../utils/fileSourceFromUri';
import { TEST_VIDEO_FILES } from '../../videoConfig';
import { styles } from './VideoPreviewScreen.styles';

const BUNDLED_VIDEO = TEST_VIDEO_FILES.PREVIEW_H264_AAC;

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
          <ExampleVideoPreviewPlayer
            player={player}
            loading={loading}
            onPlayError={(message) => setPlayError(message)}
          />
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
