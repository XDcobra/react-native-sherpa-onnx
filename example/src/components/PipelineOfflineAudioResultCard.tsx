/**
 * Compact “buffer ready” card for an existing offline pipeline audio buffer:
 * output device, play/stop, save-as-file, dismiss (release buffer).
 * Shared by Live Pipeline Showcase and similar flows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { createPcmPlayer, type PcmPlayer } from 'react-native-sherpa-onnx/pcm';
import { setPipelineAudioRoutePreference } from 'react-native-sherpa-onnx/audio';
import type { AudioOutputFormat } from 'react-native-sherpa-onnx/audio';
import type { ResolvedFileRef } from 'react-native-sherpa-onnx/fileio';
import { AudioDeviceDropdown } from './AudioDeviceDropdown';
import { AudioSaveDestinationPicker } from './AudioSaveDestinationPicker';
import { formatResolvedLocation } from './audioSaveUtils';
import {
  fetchOutputDevices,
  keepValidDeviceSelection,
  type AudioRouteDevice,
} from '../utils/audioDevices';
import { widgetStyles as s } from './OfflineAudioBufferWidget.styles';

export type PipelineOfflineAudioResultCardProps = {
  bufferId: string;
  sourceLabel: string;
  sampleRate: number;
  durationMs: number;
  /** Release native buffer and clear parent state. */
  onDismiss: () => void;
  disabled?: boolean;
};

export function PipelineOfflineAudioResultCard({
  bufferId,
  sourceLabel,
  sampleRate,
  durationMs,
  onDismiss,
  disabled = false,
}: PipelineOfflineAudioResultCardProps) {
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<PcmPlayer | null>(null);
  const [outputDevices, setOutputDevices] = useState<AudioRouteDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<
    string | null
  >(null);
  const [saveFormat] = useState<AudioOutputFormat>('wav');

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

  useEffect(() => {
    return () => {
      playerRef.current?.destroy().catch(() => {});
      playerRef.current = null;
    };
  }, []);

  const stopPlayer = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    playerRef.current = null;
    setPlaying(false);
    await p.destroy().catch(() => {});
  }, []);

  const handleTogglePlayback = useCallback(async () => {
    if (playerRef.current) {
      await stopPlayer();
      return;
    }
    try {
      await setPipelineAudioRoutePreference({
        outputDeviceId: selectedOutputDeviceId ?? null,
      }).catch(() => {});
      const player = await createPcmPlayer(bufferId, {
        onEnded: () => {
          playerRef.current = null;
          setPlaying(false);
        },
      });
      playerRef.current = player;
      setPlaying(true);
    } catch (e) {
      Alert.alert(
        'Playback failed',
        e instanceof Error ? e.message : String(e)
      );
      setPlaying(false);
    }
  }, [bufferId, selectedOutputDeviceId, stopPlayer]);

  const handleDismiss = useCallback(async () => {
    await stopPlayer();
    onDismiss();
  }, [onDismiss, stopPlayer]);

  const durSec = (durationMs / 1000).toFixed(1);

  return (
    <View style={s.bufferReadyCard}>
      <View style={s.bufferHeaderRow}>
        <View style={s.bufferHeaderTextWrap}>
          <Text style={s.bufferReadyLabel}>
            Captured audio (offline buffer)
          </Text>
          <Text style={s.bufferSourceLabel}>{sourceLabel}</Text>
          <Text style={s.bufferIdText} selectable>
            {bufferId}
          </Text>
          <Text style={[s.bufferIdText, localStyles.bufferMetaLine]}>
            {sampleRate} Hz · {durSec}s
          </Text>
        </View>
        <TouchableOpacity
          style={[s.bufferDeleteButton, disabled && s.buttonDisabled]}
          onPress={() => {
            handleDismiss().catch(() => {});
          }}
          disabled={disabled}
          accessibilityLabel="Dismiss captured audio"
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
        onPress={() => {
          handleTogglePlayback().catch(() => {});
        }}
        disabled={disabled}
      >
        <View style={s.rowAlignCenter}>
          <Ionicons
            name={playing ? 'stop' : 'play'}
            size={16}
            style={s.iconInline}
          />
          <Text style={s.playButtonText}>{playing ? 'Stop' : 'Play'}</Text>
        </View>
      </TouchableOpacity>

      <View style={localStyles.saveSection}>
        <Text style={[s.subsectionTitle, localStyles.saveSubsectionTitle]}>
          Save as file
        </Text>
        <AudioSaveDestinationPicker
          audioInput={bufferId}
          filename={`pipeline_tts_${Date.now()}.${
            saveFormat === 'wav' ? 'wav' : 'mp3'
          }`}
          format={saveFormat}
          options={{ outputSampleRateHz: sampleRate }}
          disabled={disabled}
          onSaveComplete={(result: ResolvedFileRef) => {
            Alert.alert('Saved', formatResolvedLocation(result));
          }}
          onError={(err: Error) => Alert.alert('Save failed', err.message)}
        />
      </View>
    </View>
  );
}

const localStyles = StyleSheet.create({
  bufferMetaLine: { marginTop: 4 },
  saveSection: { marginTop: 14 },
  saveSubsectionTitle: { marginTop: 0 },
});
