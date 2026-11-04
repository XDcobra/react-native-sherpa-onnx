/**
 * Shared streaming audio ingress: File (OfflineAudioBufferWidget) | Microphone.
 * File path matches offline screens (example + own file); mic is the streaming extra.
 */

import { useRef, type RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AudioFileInfo } from '../audioConfig';
import {
  AudioIngressSourceToggle,
  type AudioIngressSourceMode,
} from './AudioIngressSourceToggle';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
  type OfflineAudioBufferWidgetHandle,
} from './OfflineAudioBufferWidget';

export type StreamingAudioInputSectionProps = {
  sourceMode: AudioIngressSourceMode;
  onSourceModeChange: (mode: AudioIngressSourceMode) => void;
  audioFiles: AudioFileInfo[];
  favoriteAudioFileIds?: readonly string[];
  onBufferReady: (info: OfflineAudioBufferInfo) => void;
  onBufferReleased: () => void;
  disabled?: boolean;
  widgetRef?: RefObject<OfflineAudioBufferWidgetHandle | null>;
  title?: string;
  micSampleRateHz?: number;
  decodeTargetSampleRateHz?: number;
};

export function StreamingAudioInputSection({
  sourceMode,
  onSourceModeChange,
  audioFiles,
  favoriteAudioFileIds,
  onBufferReady,
  onBufferReleased,
  disabled = false,
  widgetRef,
  title = 'Input source',
  micSampleRateHz = 16000,
  decodeTargetSampleRateHz,
}: StreamingAudioInputSectionProps) {
  const internalWidgetRef = useRef<OfflineAudioBufferWidgetHandle | null>(null);
  const resolvedWidgetRef = widgetRef ?? internalWidgetRef;

  const handleSourceModeChange = (mode: AudioIngressSourceMode) => {
    if (mode === sourceMode) return;
    if (sourceMode === 'file' && mode === 'mic') {
      resolvedWidgetRef.current?.clear().catch(() => {});
    }
    onSourceModeChange(mode);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionDescription}>
        File uses the same example and own-file flow as offline screens.
        Microphone captures live audio after you Start.
      </Text>

      <AudioIngressSourceToggle
        value={sourceMode}
        onChange={handleSourceModeChange}
        disabled={disabled}
      />

      {sourceMode === 'file' ? (
        <OfflineAudioBufferWidget
          ref={resolvedWidgetRef}
          audioFiles={audioFiles}
          favoriteAudioFileIds={favoriteAudioFileIds}
          onBufferReady={onBufferReady}
          onBufferReleased={onBufferReleased}
          disabled={disabled}
          decodeTargetSampleRateHz={decodeTargetSampleRateHz}
        />
      ) : (
        <Text style={styles.micHint}>
          Audio is captured from the device microphone at {micSampleRateHz} Hz
          mono. Grant mic permission when prompted, then tap Start.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  micHint: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 20,
  },
});
