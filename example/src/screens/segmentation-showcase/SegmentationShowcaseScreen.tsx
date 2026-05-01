import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
  FlatList,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  segmentOfflineBuffer,
  getSegments,
} from 'react-native-sherpa-onnx/segment';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import type {
  TextSegment,
  SpeechSegment,
} from 'react-native-sherpa-onnx/segment';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import { styles } from './SegmentationShowcaseScreen.styles';

type Mode = 'text' | 'audio';

type TextSegmentationState = {
  inputText: string;
  segments: TextSegment[];
  maxLengthChars: number;
  sentenceBoundary: boolean;
};

type AudioSegmentationState = {
  audioFile: { uri: string; name: string } | null;
  segments: SpeechSegment[];
  silenceThresholdMs: number;
  energyThresholdDb: number;
  minSegmentMs: number;
  maxSegmentMs: number;
  hangoverMs: number;
};

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { code?: string; message?: string };
    if (maybe.code && maybe.message) {
      return `[${maybe.code}] ${maybe.message}`;
    }
    if (maybe.message) {
      return maybe.message;
    }
  }
  return 'Unknown error';
}

function toFileSource(pathOrUri: string): FileSource {
  const trimmed = pathOrUri.trim();
  if (trimmed.startsWith('content://')) {
    return { kind: 'contentUri', uri: trimmed };
  }
  if (trimmed.startsWith('file://')) {
    return { kind: 'fs', path: decodeURI(trimmed.replace(/^file:\/\//, '')) };
  }
  return { kind: 'fs', path: trimmed };
}

const EXAMPLE_TEXT =
  'Hello world. This is a longer example text that will be segmented. The segmentation engine cuts text at sentence boundaries and respects length limits. You can adjust parameters to see how segments change.';

export default function SegmentationShowcaseScreen() {
  const [mode, setMode] = useState<Mode>('text');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Text mode state
  const [textState, setTextState] = useState<TextSegmentationState>({
    inputText: EXAMPLE_TEXT,
    segments: [],
    maxLengthChars: 100,
    sentenceBoundary: true,
  });

  // Audio mode state
  const [audioState, setAudioState] = useState<AudioSegmentationState>({
    audioFile: null,
    segments: [],
    silenceThresholdMs: 500,
    energyThresholdDb: -40,
    minSegmentMs: 1000,
    maxSegmentMs: 30000,
    hangoverMs: 300,
  });

  // Refs for cleanup
  const textBufferRef = useRef<string | null>(null);
  const audioBufferRef = useRef<string | null>(null);

  const handleRunTextSegmentation = useCallback(async () => {
    if (!textState.inputText.trim()) {
      setError('Please enter some text');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Clean up previous buffer if exists
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
      }

      // Pre-filled offline buffer (see docs/segmentation-engine.md Quick start)
      const textBuffer = await createOfflineTextBufferFromText(
        textState.inputText
      );
      textBufferRef.current = textBuffer.bufferId;

      // Run segmentation
      await segmentOfflineBuffer(textBuffer, {
        evaluator: 'text_synthetic_auto',
        sentenceBoundary: textState.sentenceBoundary,
        maxLengthChars: textState.maxLengthChars,
      });

      // Get segments
      const segments = (await getSegments(textBuffer, 0, 128)) as TextSegment[];

      setTextState((prev) => ({ ...prev, segments }));
    } catch (err) {
      setError(`Text segmentation failed: ${normalizeErrorMessage(err)}`);
      if (textBufferRef.current) {
        try {
          await releasePipelineTextBuffer(textBufferRef.current);
        } catch {}
        textBufferRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  }, [
    textState.inputText,
    textState.sentenceBoundary,
    textState.maxLengthChars,
  ]);

  const handleSelectAudioFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.pick({
        presentationStyle: 'pageSheet',
      });

      if (result && result.length > 0) {
        const file = result[0];
        if (file.uri) {
          setAudioState((prev) => ({
            ...prev,
            audioFile: {
              uri: file.uri,
              name: file.name ?? 'audio',
            },
          }));
        }
      }
    } catch (err) {
      // User cancelled or error
      if (!String(err).includes('cancelled')) {
        setError(`File picker error: ${normalizeErrorMessage(err)}`);
      }
    }
  }, []);

  const handleRunAudioSegmentation = useCallback(async () => {
    if (!audioState.audioFile) {
      setError('Please select an audio file');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Clean up previous buffer if exists
      if (audioBufferRef.current) {
        try {
          await releasePipelineAudioBuffer(audioBufferRef.current);
        } catch {}
      }

      // Create audio buffer from file
      const fileSource = toFileSource(audioState.audioFile.uri);
      const audioBuffer = await createOfflineAudioBufferFromFile(fileSource);
      audioBufferRef.current = audioBuffer.bufferId;

      // Run segmentation
      await segmentOfflineBuffer(audioBuffer, {
        evaluator: 'speech_energy_silence',
        silenceThresholdMs: audioState.silenceThresholdMs,
        energyThresholdDb: audioState.energyThresholdDb,
        minSegmentMs: audioState.minSegmentMs,
        maxSegmentMs: audioState.maxSegmentMs,
        hangoverMs: audioState.hangoverMs,
      });

      // Get segments
      const segments = (await getSegments(
        audioBuffer,
        0,
        128
      )) as SpeechSegment[];

      setAudioState((prev) => ({ ...prev, segments }));
    } catch (err) {
      setError(`Audio segmentation failed: ${normalizeErrorMessage(err)}`);
      if (audioBufferRef.current) {
        try {
          await releasePipelineAudioBuffer(audioBufferRef.current);
        } catch {}
        audioBufferRef.current = null;
      }
    } finally {
      setLoading(false);
    }
  }, [
    audioState.audioFile,
    audioState.silenceThresholdMs,
    audioState.energyThresholdDb,
    audioState.minSegmentMs,
    audioState.maxSegmentMs,
    audioState.hangoverMs,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (textBufferRef.current) {
        releasePipelineTextBuffer(textBufferRef.current).catch(() => {});
      }
      if (audioBufferRef.current) {
        releasePipelineAudioBuffer(audioBufferRef.current).catch(() => {});
      }
    };
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
      >
        {/* Mode Selector */}
        <View style={styles.modeSelector}>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'text' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('text');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'text' ? 'document-text' : 'document-text-outline'}
              size={20}
              color={mode === 'text' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'text' && styles.modeButtonTextActive,
              ]}
            >
              Text
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.modeButton,
              mode === 'audio' && styles.modeButtonActive,
            ]}
            onPress={() => {
              setMode('audio');
              setError(null);
            }}
          >
            <Ionicons
              name={mode === 'audio' ? 'volume-high' : 'volume-high-outline'}
              size={20}
              color={mode === 'audio' ? '#007AFF' : '#666'}
              style={styles.modeIcon}
            />
            <Text
              style={[
                styles.modeButtonText,
                mode === 'audio' && styles.modeButtonTextActive,
              ]}
            >
              Audio
            </Text>
          </Pressable>
        </View>

        {/* Error display */}
        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color="#D32F2F" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Text Mode */}
        {mode === 'text' && (
          <View style={styles.modeContent}>
            <Text style={styles.sectionTitle}>Text Input</Text>
            <TextInput
              style={styles.textInput}
              multiline
              placeholder="Enter text to segment..."
              placeholderTextColor="#999"
              value={textState.inputText}
              onChangeText={(text) =>
                setTextState((prev) => ({ ...prev, inputText: text }))
              }
              editable={!loading}
            />

            <Text style={styles.sectionTitle}>Segmentation Policy</Text>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Max Length (chars):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="number-pad"
                value={String(textState.maxLengthChars)}
                onChangeText={(text) => {
                  const num = parseInt(text, 10);
                  if (!isNaN(num) && num > 0) {
                    setTextState((prev) => ({
                      ...prev,
                      maxLengthChars: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Sentence Boundary:</Text>
              <Switch
                value={textState.sentenceBoundary}
                onValueChange={(value) =>
                  setTextState((prev) => ({
                    ...prev,
                    sentenceBoundary: value,
                  }))
                }
                disabled={loading}
              />
            </View>

            <Pressable
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleRunTextSegmentation}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Text</Text>
                </>
              )}
            </Pressable>

            {textState.segments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Segments ({textState.segments.length})
                </Text>
                <FlatList
                  data={textState.segments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => (
                    <View key={item.segmentId} style={styles.segmentCard}>
                      <View style={styles.segmentHeader}>
                        <Text style={styles.segmentIndex}>#{index + 1}</Text>
                        <View style={styles.reasonBadge}>
                          <Text style={styles.reasonBadgeText}>
                            {item.reason}
                          </Text>
                        </View>
                        <Text style={styles.segmentMeta}>
                          {item.utf16Length} chars
                        </Text>
                      </View>
                      <Text style={styles.segmentText}>{item.text}</Text>
                    </View>
                  )}
                  keyExtractor={(item) => item.segmentId}
                />
              </>
            )}
          </View>
        )}

        {/* Audio Mode */}
        {mode === 'audio' && (
          <View style={styles.modeContent}>
            <Text style={styles.sectionTitle}>Audio File</Text>
            {audioState.audioFile ? (
              <View style={styles.fileSelectedBox}>
                <Ionicons name="document-attach" size={20} color="#007AFF" />
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName}>
                    {audioState.audioFile.name}
                  </Text>
                  <Text style={styles.fileUri} numberOfLines={1}>
                    {audioState.audioFile.uri}
                  </Text>
                </View>
                <Pressable
                  onPress={() =>
                    setAudioState((prev) => ({ ...prev, audioFile: null }))
                  }
                >
                  <Ionicons name="close" size={20} color="#666" />
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={styles.filePickerButton}
                onPress={handleSelectAudioFile}
              >
                <Ionicons
                  name="folder-open-outline"
                  size={24}
                  color="#007AFF"
                  style={styles.filePickerIcon}
                />
                <Text style={styles.filePickerText}>Select Audio File</Text>
              </Pressable>
            )}

            <Text style={styles.sectionTitle}>Segmentation Policy</Text>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Silence Threshold (ms):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="number-pad"
                value={String(audioState.silenceThresholdMs)}
                onChangeText={(text) => {
                  const num = parseInt(text, 10);
                  if (!isNaN(num) && num >= 0) {
                    setAudioState((prev) => ({
                      ...prev,
                      silenceThresholdMs: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Energy Threshold (dB):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="decimal-pad"
                value={String(audioState.energyThresholdDb)}
                onChangeText={(text) => {
                  const num = parseFloat(text);
                  if (!isNaN(num)) {
                    setAudioState((prev) => ({
                      ...prev,
                      energyThresholdDb: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Min Segment (ms):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="number-pad"
                value={String(audioState.minSegmentMs)}
                onChangeText={(text) => {
                  const num = parseInt(text, 10);
                  if (!isNaN(num) && num >= 0) {
                    setAudioState((prev) => ({
                      ...prev,
                      minSegmentMs: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Max Segment (ms):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="number-pad"
                value={String(audioState.maxSegmentMs)}
                onChangeText={(text) => {
                  const num = parseInt(text, 10);
                  if (!isNaN(num) && num > 0) {
                    setAudioState((prev) => ({
                      ...prev,
                      maxSegmentMs: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>
            <View style={styles.policyControl}>
              <Text style={styles.policyLabel}>Hangover (ms):</Text>
              <TextInput
                style={styles.policyInput}
                keyboardType="number-pad"
                value={String(audioState.hangoverMs)}
                onChangeText={(text) => {
                  const num = parseInt(text, 10);
                  if (!isNaN(num) && num >= 0) {
                    setAudioState((prev) => ({
                      ...prev,
                      hangoverMs: num,
                    }));
                  }
                }}
                editable={!loading}
              />
            </View>

            <Pressable
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleRunAudioSegmentation}
              disabled={loading || !audioState.audioFile}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons
                    name="cut"
                    size={18}
                    color="#FFF"
                    style={styles.buttonIcon}
                  />
                  <Text style={styles.buttonText}>Segment Audio</Text>
                </>
              )}
            </Pressable>

            {audioState.segments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>
                  Timeline ({audioState.segments.length} segments)
                </Text>
                <View style={styles.timelineContainer}>
                  <View style={styles.timeline}>
                    {audioState.segments.map((segment) => {
                      const totalDuration = audioState.segments.reduce(
                        (sum, s) => sum + s.durationMs,
                        0
                      );
                      const width =
                        totalDuration > 0
                          ? (segment.durationMs / totalDuration) * 100
                          : 0;
                      const colors = [
                        '#FF6B6B',
                        '#4ECDC4',
                        '#45B7D1',
                        '#FFA07A',
                        '#98D8C8',
                        '#F7DC6F',
                      ];
                      const color =
                        colors[segment.segmentIndex % colors.length];

                      return (
                        <View
                          key={segment.segmentId}
                          style={[
                            styles.timelineSegment,
                            { width: `${width}%`, backgroundColor: color },
                          ]}
                          accessibilityLabel={`${segment.reason}: ${segment.durationMs}ms`}
                        />
                      );
                    })}
                  </View>
                </View>

                <FlatList
                  data={audioState.segments}
                  scrollEnabled={false}
                  renderItem={({ item, index }) => (
                    <View key={item.segmentId} style={styles.segmentCard}>
                      <View style={styles.segmentHeader}>
                        <Text style={styles.segmentIndex}>#{index + 1}</Text>
                        <View style={styles.reasonBadge}>
                          <Text style={styles.reasonBadgeText}>
                            {item.reason}
                          </Text>
                        </View>
                        <Text style={styles.segmentMeta}>
                          {item.durationMs}ms
                        </Text>
                      </View>
                      {item.energy !== undefined && (
                        <Text style={styles.segmentDetail}>
                          Energy: {item.energy.toFixed(2)} dB
                        </Text>
                      )}
                      {item.vadInfo && (
                        <Text style={styles.segmentDetail}>
                          VAD: {item.vadInfo.decision || 'unknown'}
                        </Text>
                      )}
                    </View>
                  )}
                  keyExtractor={(item) => item.segmentId}
                />
              </>
            )}
          </View>
        )}
      </ScrollView>
      <ScreenIntroModal screenId="SegmentationShowcase" />
    </SafeAreaView>
  );
}
