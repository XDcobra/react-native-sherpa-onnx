/**
 * EXAMPLE: Using AudioSaveDestinationPicker in a Feature Screen
 *
 * This file demonstrates how to integrate AudioSaveDestinationPicker
 * into a real feature screen with minimal changes.
 *
 * Copy this pattern for your own screens.
 */

import { useState, useCallback } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { AudioOutputFormat } from 'react-native-sherpa-onnx/audio';
import type { ResolvedFileRef } from 'react-native-sherpa-onnx/fileio';
import { AudioSaveDestinationPicker } from './AudioSaveDestinationPicker';
import { formatResolvedLocation } from './audioSaveUtils';

/**
 * Minimal example: Feature screen with audio save capability.
 *
 * Key patterns:
 * - Keep the AudioSaveDestinationPicker simple: just pass audioInput + filename.
 * - Let the component handle all FileDestination selection and picker flows.
 * - Use callbacks to update your screen UI after save.
 */
function ExampleAudioFeatureScreen() {
  // Audio state: buffer ID or null if no audio yet
  const [audioBuffer, _setAudioBuffer] = useState<string | null>(null);
  const [format, setFormat] = useState<AudioOutputFormat>('wav');

  // ─────────────────────────────────────────────────────────────
  // Process audio, generate output, etc.
  // ─────────────────────────────────────────────────────────────

  const handleGenerateAudio = useCallback(async () => {
    try {
      // ... your audio processing here ...
      // (e.g., TTS synthesis, enhancement, separation, etc)
      // const result = await generateAudio(...);
      // _setAudioBuffer(result.bufferId);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Save Handlers
  // ─────────────────────────────────────────────────────────────

  const handleSaveComplete = useCallback((result: ResolvedFileRef) => {
    const location = formatResolvedLocation(result);
    // You can also extract filename if needed:
    // const filename = extractFilename(location);
    Alert.alert('Audio Saved', `Location:\n${location}`);
  }, []);

  const handleSaveError = useCallback((error: Error) => {
    // User cancellations are silently ignored (onError not called).
    // Only real errors reach here.
    Alert.alert('Save Failed', error.message);
  }, []);

  return (
    <ScrollView style={styles.container}>
      {/* Your existing UI */}
      <View style={styles.section}>
        <Text style={styles.title}>Audio Processing</Text>
        <Pressable style={styles.button} onPress={handleGenerateAudio}>
          <Ionicons name="play-circle-outline" size={20} color="#FFF" />
          <Text style={styles.buttonText}>Generate Audio</Text>
        </Pressable>
      </View>

      {/* Reusable Save Component */}
      {audioBuffer && (
        <View style={styles.section}>
          <Text style={styles.title}>Save Output</Text>
          <AudioSaveDestinationPicker
            audioInput={audioBuffer}
            filename={`audio_${Date.now()}.${format === 'wav' ? 'wav' : 'mp3'}`}
            format={format}
            options={{ outputSampleRateHz: 16000 }}
            onSaveComplete={handleSaveComplete}
            onError={handleSaveError}
          />

          {/* Optional: Format selector */}
          <View style={styles.formatRow}>
            <Text style={styles.label}>Format:</Text>
            {(['wav', 'mp3'] as const).map((fmt) => (
              <Pressable
                key={fmt}
                style={[
                  styles.formatButton,
                  format === fmt && styles.formatButtonActive,
                ]}
                onPress={() => setFormat(fmt)}
              >
                <Text
                  style={[
                    styles.formatButtonText,
                    format === fmt && styles.formatButtonTextActive,
                  ]}
                >
                  {fmt.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  section: {
    margin: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3A3A3C',
    marginBottom: 8,
  },
  formatRow: {
    marginTop: 16,
    gap: 8,
  },
  formatButton: {
    marginVertical: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    backgroundColor: '#F2F2F7',
  },
  formatButtonActive: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.1)',
  },
  formatButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3A3A3C',
    textAlign: 'center',
  },
  formatButtonTextActive: {
    color: '#007AFF',
  },
});

export default ExampleAudioFeatureScreen;
