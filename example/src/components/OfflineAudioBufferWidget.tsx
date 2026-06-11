/**
 * OfflineAudioBufferWidget
 *
 * Shared component that handles the full offline audio-file → OfflineAudioBuffer
 * lifecycle used across STT, Enhancement, VAD, GenerateTimestamp, and
 * SegmentationShowcase screens.
 *
 * Responsibilities:
 *  - Two source choices: Example Audio (from the provided audioFiles list) or
 *    Own Audio (DocumentPicker, all SDK-decodable formats).
 *  - Decode progress UI.
 *  - Buffer-ready card with bufferId, label, delete, Output-device dropdown,
 *    and Play-buffer toggle.
 *  - Calls onBufferReady / onBufferReleased callbacks so the parent screen can
 *    enable/disable its primary action button.
 *
 * What stays in the screen:
 *  - Model initialisation
 *  - Primary action button (Transcribe / Run Enhancement / Run VAD / …)
 *  - Results display
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
  type OfflineAudioBufferRef,
} from 'react-native-sherpa-onnx/audiobuffer';
import { DECODABLE_AUDIO_PICKER_TYPES } from '../utils/decodableAudioPickerTypes';

import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import type { AudioFileInfo } from '../audioConfig';
import { AudioDeviceDropdown } from './AudioDeviceDropdown';
import {
  fetchOutputDevices,
  keepValidDeviceSelection,
  type AudioRouteDevice,
} from '../utils/audioDevices';
import {
  fileSourceFromBundledPath,
  resolveAudioFileDisplayName,
  toFileSource as toFileSourceWithHint,
} from '../utils/fileSourceFromUri';
import { widgetStyles as s } from './OfflineAudioBufferWidget.styles';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OfflineAudioBufferInfo = {
  bufferId: string;
  sourceLabel: string;
};

export type OfflineAudioBufferWidgetHandle = {
  /** Imperatively release the current buffer and reset. */
  clear: () => Promise<void>;
};

type Props = {
  /**
   * List of example audio files to offer. Pass the result of
   * `getAudioFilesForModel` or `AUDIO_FILES` directly.
   */
  audioFiles: AudioFileInfo[];
  /**
   * Called once a buffer is ready. The parent stores the info and uses it for
   * the primary action (transcribe / run / …).
   */
  onBufferReady: (info: OfflineAudioBufferInfo) => void;
  /**
   * Called when the current buffer is released (user tap Delete or
   * imperative clear()).
   */
  onBufferReleased: () => void;
  /**
   * When true the widget disables all interactive elements.
   * Use this while the screen runs a long operation (transcribing, etc.).
   */
  disabled?: boolean;
  /**
   * Show/hide the component entirely (convenience prop for guarding with
   * model-ready state). Defaults to true.
   */
  visible?: boolean;
  /**
   * Optional error string passed in from the parent (e.g. a decode error
   * that the parent already caught) to show alongside the widget's own errors.
   */
  externalError?: string | null;
  /**
   * When set, decode/resample the file to this sample rate before creating the
   * offline buffer. Use the separation (or other feature) model sample rate so
   * segmented pipelines match orchestrator output buffers.
   */
  decodeTargetSampleRateHz?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toFileSource(pathOrUri: string, displayName?: string) {
  const trimmed = pathOrUri.trim();
  // Relative paths are bundled example assets (test_wavs/test_codec).
  if (
    !trimmed.startsWith('content://') &&
    !trimmed.startsWith('file://') &&
    !trimmed.startsWith('/')
  ) {
    return fileSourceFromBundledPath(trimmed);
  }
  return toFileSourceWithHint(trimmed, displayName);
}

function isEphemeralFd(pathOrUri: string): boolean {
  const p = pathOrUri.startsWith('file://')
    ? decodeURI(pathOrUri.replace(/^file:\/\//, ''))
    : pathOrUri;
  return p.startsWith('/proc/self/fd/');
}

function isPickerCancel(err: unknown): boolean {
  if (!err) return false;
  const e = err as any;
  return (
    (typeof (DocumentPicker as any).isCancel === 'function' &&
      (DocumentPicker as any).isCancel(err)) ||
    e?.code === 'DOCUMENT_PICKER_CANCELED' ||
    e?.name === 'DocumentPickerCanceled' ||
    (typeof e?.message === 'string' &&
      e.message.toLowerCase().includes('cancel'))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const OfflineAudioBufferWidget = forwardRef<
  OfflineAudioBufferWidgetHandle,
  Props
>(function OfflineAudioBufferWidget(
  {
    audioFiles,
    onBufferReady,
    onBufferReleased,
    disabled = false,
    visible = true,
    externalError = null,
    decodeTargetSampleRateHz,
  },
  ref
) {
  // ── source choice ──────────────────────────────────────────────────────────
  const [sourceType, setSourceType] = useState<'example' | 'own' | null>(null);

  // ── decode state ───────────────────────────────────────────────────────────
  const [decoding, setDecoding] = useState(false);
  const [decodeProgress, setDecodeProgress] = useState<number | null>(null);
  const [decodeStatus, setDecodeStatus] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const decodeRequestRef = useRef(0);

  // ── buffer state ───────────────────────────────────────────────────────────
  const [bufferInfo, setBufferInfo] = useState<OfflineAudioBufferInfo | null>(
    null
  );
  // We keep the full ref around so we can pass it to createPcmPlayer.
  const bufferRefStore = useRef<OfflineAudioBufferRef | null>(null);

  // ── playback ───────────────────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<PcmPlayer | null>(null);

  // ── output devices ─────────────────────────────────────────────────────────
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Output device refresh
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchOutputDevices()
      .then((devices) => {
        setOutputDevices(devices);
        setSelectedOutputDeviceId((prev) =>
          keepValidDeviceSelection(prev, devices)
        );
      })
      .catch(() => {});
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup on unmount
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      // cancel any in-flight decode
      decodeRequestRef.current += 1;
      // destroy player
      playerRef.current?.destroy().catch(() => {});
      playerRef.current = null;
      // release buffer
      const existing = bufferRefStore.current;
      if (existing) {
        releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
        bufferRefStore.current = null;
      }
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  const stopPlayer = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    playerRef.current = null;
    setPlaying(false);
    await p.destroy().catch(() => {});
  }, []);

  const releaseBuffer = useCallback(async () => {
    await stopPlayer();
    const existing = bufferRefStore.current;
    bufferRefStore.current = null;
    setBufferInfo(null);
    if (existing) {
      await releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
    }
  }, [stopPlayer]);

  const resetAll = useCallback(
    async (keepSourceChoice = false) => {
      decodeRequestRef.current += 1;
      setDecoding(false);
      setDecodeProgress(null);
      setDecodeStatus(null);
      setDecodeError(null);
      await releaseBuffer();
      if (!keepSourceChoice) {
        setSourceType(null);
      }
    },
    [releaseBuffer]
  );

  const handleDelete = useCallback(async () => {
    await resetAll(false);
    onBufferReleased();
  }, [resetAll, onBufferReleased]);

  // ─────────────────────────────────────────────────────────────────────────
  // Imperative handle
  // ─────────────────────────────────────────────────────────────────────────

  useImperativeHandle(
    ref,
    () => ({
      clear: async () => {
        await resetAll(false);
        onBufferReleased();
      },
    }),
    [resetAll, onBufferReleased]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Decode
  // ─────────────────────────────────────────────────────────────────────────

  const decodeSource = useCallback(
    async (label: string, source: ReturnType<typeof toFileSource>) => {
      const requestId = ++decodeRequestRef.current;

      // Release any existing buffer first
      await stopPlayer();
      const existing = bufferRefStore.current;
      bufferRefStore.current = null;
      setBufferInfo(null);
      if (existing) {
        await releasePipelineAudioBuffer(existing.bufferId).catch(() => {});
      }

      setDecoding(true);
      setDecodeProgress(0);
      setDecodeStatus(`Decoding "${label}" into OfflineAudioBuffer…`);
      setDecodeError(null);

      const decodeOptions = {
        forceMono: true,
        ...(decodeTargetSampleRateHz != null && decodeTargetSampleRateHz > 0
          ? { targetSampleRateHz: decodeTargetSampleRateHz }
          : {}),
        onProgress: (event: {
          percent?: number;
          framesDecoded?: number;
          totalFramesEstimate?: number;
        }) => {
          if (requestId !== decodeRequestRef.current) return;
          const pct = Math.max(0, Math.min(100, event.percent ?? 0));
          setDecodeProgress(pct);
          const total = event.totalFramesEstimate ?? 0;
          setDecodeStatus(
            total > 0
              ? `Decoding "${label}"… ${Math.round(pct)}% (${
                  event.framesDecoded
                }/${total} frames)`
              : `Decoding "${label}"… ${Math.round(pct)}%`
          );
        },
      };

      try {
        const audioRef = await createOfflineAudioBufferFromFile(
          source,
          decodeOptions
        );

        if (requestId !== decodeRequestRef.current) {
          await releasePipelineAudioBuffer(audioRef.bufferId).catch(() => {});
          return;
        }

        bufferRefStore.current = audioRef;
        const info: OfflineAudioBufferInfo = {
          bufferId: audioRef.bufferId,
          sourceLabel: label,
        };
        setBufferInfo(info);
        setDecodeProgress(null);
        setDecodeStatus(null);
        onBufferReady(info);
      } catch (err) {
        if (requestId !== decodeRequestRef.current) return;
        setDecodeError(err instanceof Error ? err.message : String(err));
        setDecodeProgress(null);
        setDecodeStatus(null);
      } finally {
        if (requestId === decodeRequestRef.current) {
          setDecoding(false);
        }
      }
    },
    [decodeTargetSampleRateHz, onBufferReady, stopPlayer]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Example audio pick
  // ─────────────────────────────────────────────────────────────────────────

  const handleExamplePick = useCallback(
    async (audioFile: AudioFileInfo) => {
      try {
        await decodeSource(audioFile.name, toFileSource(audioFile.id));
      } catch (err) {
        setDecodeError(err instanceof Error ? err.message : String(err));
      }
    },
    [decodeSource]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Own file pick
  // ─────────────────────────────────────────────────────────────────────────

  const handlePickOwnFile = useCallback(async () => {
    setDecodeError(null);
    try {
      const res = await DocumentPicker.pick({
        type: DECODABLE_AUDIO_PICKER_TYPES,
      });
      const file = Array.isArray(res) ? res[0] : res;
      const uri =
        file?.uri ??
        (file as any)?.fileCopyUri ??
        (file as any)?.localUri ??
        (file as any)?.nativeUri;
      const name =
        resolveAudioFileDisplayName(uri, file?.name) ??
        file?.name?.trim() ??
        uri?.split('/')?.pop() ??
        'audio';

      if (!uri) {
        setDecodeError('Could not get file URI from picker result');
        return;
      }
      if (isEphemeralFd(uri)) {
        setDecodeError(
          'The selected file points to an ephemeral file descriptor. Please re-pick from Files/Documents.'
        );
        return;
      }

      const source = toFileSource(uri, name);
      await decodeSource(name, source);
    } catch (err) {
      if (isPickerCancel(err)) return;
      setDecodeError(err instanceof Error ? err.message : String(err));
    }
  }, [decodeSource]);

  // ─────────────────────────────────────────────────────────────────────────
  // Playback
  // ─────────────────────────────────────────────────────────────────────────

  const handleTogglePlayback = useCallback(async () => {
    if (playerRef.current) {
      await stopPlayer();
      return;
    }
    if (!bufferRefStore.current) return;
    try {
      await setPipelineAudioRoutePreference({
        outputDeviceId: selectedOutputDeviceId ?? null,
      }).catch(() => {});
      const player = await createPcmPlayer(
        bufferRefStore.current.bufferId as any,
        {
          onEnded: () => {
            const cur = playerRef.current;
            playerRef.current = null;
            setPlaying(false);
            cur?.destroy().catch(() => {});
          },
        }
      );
      playerRef.current = player;
      setPlaying(true);
    } catch (e) {
      Alert.alert(
        'Playback failed',
        e instanceof Error ? e.message : String(e)
      );
      setPlaying(false);
    }
  }, [selectedOutputDeviceId, stopPlayer]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (!visible) return null;

  const busy = disabled || decoding;
  const errorMsg = decodeError ?? externalError ?? null;

  // ── Source choice ──
  if (!sourceType) {
    return (
      <View>
        <Text style={s.subsectionTitle}>Choose Audio Source:</Text>
        <View style={s.sourceChoiceRow}>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => setSourceType('example')}
            disabled={busy}
          >
            <View style={s.rowCenter}>
              <Ionicons name="folder-outline" size={18} style={s.iconInline} />
              <Text style={s.sourceChoiceButtonText}>Example Audio</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.sourceChoiceButton, busy && s.sourceChoiceButtonDisabled]}
            onPress={() => setSourceType('own')}
            disabled={busy}
          >
            <View style={s.rowCenter}>
              <Ionicons name="musical-notes" size={18} style={s.iconInline} />
              <Text style={s.sourceChoiceButtonText}>
                Select Your Own Audio
              </Text>
            </View>
          </TouchableOpacity>
        </View>
        {errorMsg ? (
          <View style={s.errorContainer}>
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  // ── Decode in progress ──
  if (decoding || decodeStatus != null) {
    return (
      <View>
        <View style={s.decodeProgressContainer}>
          <View style={s.decodeProgressHeaderRow}>
            <Text style={s.decodeProgressLabel}>
              {decodeStatus ?? 'Preparing OfflineAudioBuffer…'}
            </Text>
            {decodeProgress != null ? (
              <Text style={s.decodeProgressPercent}>
                {Math.round(decodeProgress)}%
              </Text>
            ) : null}
          </View>
          <View style={s.decodeProgressTrack}>
            <View
              style={[
                s.decodeProgressFill,
                {
                  width: `${Math.max(0, Math.min(100, decodeProgress ?? 0))}%`,
                },
              ]}
            />
          </View>
          {decoding ? (
            <Text style={s.decodeProgressMeta}>
              Large files can take a while to decode.
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  // ── Buffer ready ──
  if (bufferInfo) {
    return (
      <View style={s.bufferReadyCard}>
        <View style={s.bufferHeaderRow}>
          <View style={s.bufferHeaderTextWrap}>
            <Text style={s.bufferReadyLabel}>OfflineAudioBuffer ready:</Text>
            <Text style={s.bufferSourceLabel}>{bufferInfo.sourceLabel}</Text>
            <Text style={s.bufferIdText} selectable>
              {bufferInfo.bufferId}
            </Text>
          </View>
          <TouchableOpacity
            style={[s.bufferDeleteButton, disabled && s.buttonDisabled]}
            onPress={handleDelete}
            disabled={disabled}
          >
            <Ionicons name="trash-outline" size={18} color="#b71c1c" />
          </TouchableOpacity>
        </View>

        <AudioDeviceDropdown
          label="Output device"
          devices={outputDevices}
          selectedDeviceId={selectedOutputDeviceId}
          onSelectDeviceId={setSelectedOutputDeviceId}
          disabled={disabled}
        />

        <TouchableOpacity
          style={[s.playButton, disabled && s.buttonDisabled]}
          onPress={handleTogglePlayback}
          disabled={disabled}
        >
          <View style={s.rowAlignCenter}>
            <Ionicons
              name={playing ? 'stop' : 'play'}
              size={16}
              style={s.iconInline}
            />
            <Text style={s.playButtonText}>
              {playing ? 'Stop Buffer' : 'Play Buffer'}
            </Text>
          </View>
        </TouchableOpacity>

        {errorMsg ? (
          <View style={[s.errorContainer, { marginTop: 10 }]}>
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  // ── Example file list ──
  if (sourceType === 'example') {
    return (
      <View>
        <Text style={s.subsectionTitle}>Select Audio File:</Text>
        {audioFiles.length === 0 ? (
          <Text style={{ color: '#666', marginBottom: 8 }}>
            No example audio available for this model.
          </Text>
        ) : (
          <View style={s.audioFilesContainer}>
            {audioFiles.map((audioFile) => (
              <TouchableOpacity
                key={audioFile.id}
                style={[s.audioFileButton, busy && s.buttonDisabled]}
                onPress={() => handleExamplePick(audioFile)}
                disabled={busy}
              >
                <Text style={s.audioFileButtonText}>{audioFile.name}</Text>
                <Text style={s.audioFileDescription}>
                  {audioFile.description}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {errorMsg ? (
          <View style={s.errorContainer}>
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[s.changeSourceButton, busy && s.buttonDisabled]}
          onPress={() => {
            setSourceType(null);
            setDecodeError(null);
          }}
          disabled={busy}
        >
          <Text style={s.changeSourceButtonText}>← Change Audio Source</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Own file ──
  return (
    <View>
      <Text style={s.subsectionTitle}>Select Audio File:</Text>
      <TouchableOpacity
        style={[s.pickButton, busy && s.buttonDisabled]}
        onPress={handlePickOwnFile}
        disabled={busy}
      >
        {decoding ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <View style={s.rowCenter}>
            <Ionicons
              name="folder-open-outline"
              size={16}
              style={s.iconInline}
            />
            <Text style={s.pickButtonText}>Choose Audio File</Text>
          </View>
        )}
      </TouchableOpacity>
      {errorMsg ? (
        <View style={s.errorContainer}>
          <Text style={s.errorText}>{errorMsg}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={[s.changeSourceButton, busy && s.buttonDisabled]}
        onPress={() => {
          setSourceType(null);
          setDecodeError(null);
        }}
        disabled={busy}
      >
        <Text style={s.changeSourceButtonText}>← Change Audio Source</Text>
      </TouchableOpacity>
    </View>
  );
});
