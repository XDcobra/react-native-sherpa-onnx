import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
} from './OfflineAudioBufferWidget';

type Props = {
  visible: boolean;
  disabled?: boolean;
  applyVoiceSample: (bufferId: string) => Promise<void>;
};

/**
 * Optional VoxLock enroll clip. File picker only — never bundled example audio.
 * Decodes to an offline PCM buffer and calls `setVoiceSample`.
 */
export function VoxLockReferenceAudioPicker({
  visible,
  disabled = false,
  applyVoiceSample,
}: Props) {
  const [applying, setApplying] = useState(false);
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  if (!visible) return null;

  const handleBufferReady = (info: OfflineAudioBufferInfo) => {
    setApplyError(null);
    setAppliedLabel(null);
    setApplying(true);
    if (__DEV__) {
      console.log('[VoxLockReferenceAudio] setVoiceSample apply', {
        bufferId: info.bufferId,
        sampleRate: info.sampleRate,
        durationSeconds: info.durationSeconds,
      });
    }
    applyVoiceSample(info.bufferId)
      .then(() => {
        setAppliedLabel(info.sourceLabel);
        if (__DEV__) {
          console.log('[VoxLockReferenceAudio] setVoiceSample ok', {
            bufferId: info.bufferId,
          });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (__DEV__) {
          console.log('[VoxLockReferenceAudio] setVoiceSample fail', {
            bufferId: info.bufferId,
            message,
          });
        }
        setApplyError(message);
      })
      .finally(() => {
        setApplying(false);
      });
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Reference audio (optional)</Text>
      <Text style={styles.hint}>
        File picker only. Applies PCM via setVoiceSample (≥3s after resample).
        Skip to auto-enroll from the mix.
      </Text>
      <OfflineAudioBufferWidget
        audioFiles={[]}
        pickerMode="own-file"
        disabled={disabled || applying}
        onBufferReady={handleBufferReady}
        onBufferReleased={() => {
          setAppliedLabel(null);
          setApplyError(null);
        }}
        externalError={applyError}
      />
      {applying ? (
        <View style={styles.applyingRow}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.applyingText}>Applying voice sample…</Text>
        </View>
      ) : null}
      {appliedLabel ? (
        <Text style={styles.appliedText}>
          Voice sample applied: {appliedLabel}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 16,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    marginTop: 4,
    marginBottom: 6,
  },
  hint: {
    fontSize: 13,
    color: '#666',
    marginBottom: 10,
    lineHeight: 18,
  },
  applyingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  applyingText: {
    fontSize: 13,
    color: '#555',
  },
  appliedText: {
    marginTop: 8,
    fontSize: 13,
    color: '#1b5e20',
    fontWeight: '600',
  },
});
