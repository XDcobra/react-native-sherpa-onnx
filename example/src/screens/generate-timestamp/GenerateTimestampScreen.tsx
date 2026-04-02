import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { unlink } from '@dr.pogodin/react-native-fs';
import { copyContentUriToCache } from 'react-native-sherpa-onnx/tts';
import { decodeAudioFileToFloatSamples } from 'react-native-sherpa-onnx/audio';
import { styles } from './GenerateTimestampScreen.styles';

type DropdownType = 'mode' | 'granularity' | null;
type SubtitleMode = 'fast' | 'accurate';
type SubtitleGranularity = 'sentence' | 'word';

type SubtitleItem = {
  text: string;
  start: number;
  end: number;
};

type SubtitleResult = {
  subtitles: SubtitleItem[];
  timingMode: 'estimated' | 'aligned';
};

type ModeOption = {
  value: SubtitleMode;
  label: string;
  description: string;
};

type GranularityOption = {
  value: SubtitleGranularity;
  label: string;
  description: string;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'fast',
    label: 'fast',
    description: 'Estimated timing from audio length and text split',
  },
  {
    value: 'accurate',
    label: 'accurate',
    description:
      'Reserved for future forced alignment (currently not implemented)',
  },
];

const GRANULARITY_OPTIONS: GranularityOption[] = [
  {
    value: 'sentence',
    label: 'sentence',
    description: 'Generate one subtitle item per sentence',
  },
  {
    value: 'word',
    label: 'word',
    description: 'Generate one subtitle item per word',
  },
];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0.00';
  }
  return seconds.toFixed(2);
}

function splitTextIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;。！？；])\s+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function splitTextIntoWords(text: string): string[] {
  return text
    .split(/[\s.,!?;:()[\]{}"'`~<>/\\|@#$%^&*+=…，。！？；：、]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function distributeByTextWeight(
  totalSamples: number,
  segments: string[]
): number[] {
  if (segments.length === 0 || totalSamples <= 0) {
    return new Array(segments.length).fill(0);
  }

  const weights = segments.map((segment) => Math.max(1, segment.length));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const base = weights.map((weight) =>
    Math.floor((totalSamples * weight) / weightSum)
  );
  let assigned = base.reduce((sum, value) => sum + value, 0);

  let index = 0;
  while (assigned < totalSamples && base.length > 0) {
    const slot = index % base.length;
    base[slot] = (base[slot] ?? 0) + 1;
    assigned += 1;
    index += 1;
  }

  return base;
}

function buildSubtitlesFromCounts(
  segments: string[],
  sampleCounts: number[],
  sampleRate: number
): SubtitleItem[] {
  if (sampleRate <= 0) {
    return [];
  }

  let offset = 0;
  return segments.map((segment, index) => {
    const count = Math.max(0, sampleCounts[index] ?? 0);
    const start = offset / sampleRate;
    offset += count;
    const end = offset / sampleRate;
    return {
      text: segment,
      start,
      end,
    };
  });
}

async function generateSubtitlesFromAudioLocal(
  text: string,
  audioPath: string,
  options: { mode: SubtitleMode; granularity: SubtitleGranularity }
): Promise<SubtitleResult> {
  if (options.mode === 'accurate') {
    throw new Error(
      "Accurate subtitle mode is not yet implemented. Use 'fast'."
    );
  }

  const decoded = await decodeAudioFileToFloatSamples(audioPath);
  const segments =
    options.granularity === 'word'
      ? splitTextIntoWords(text)
      : splitTextIntoSentences(text);

  if (
    segments.length === 0 ||
    decoded.samples.length === 0 ||
    decoded.sampleRate <= 0
  ) {
    return {
      subtitles: [],
      timingMode: 'estimated',
    };
  }

  const sampleCounts = distributeByTextWeight(decoded.samples.length, segments);
  return {
    subtitles: buildSubtitlesFromCounts(
      segments,
      sampleCounts,
      decoded.sampleRate
    ),
    timingMode: 'estimated',
  };
}

function normalizeUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURI(uri.replace(/^file:\/\//, ''));
  }
  return uri;
}

function getFileNameFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const segments = withoutQuery.split('/');
  return decodeURIComponent(segments[segments.length - 1] ?? 'audio.wav');
}

export default function GenerateTimestampScreen() {
  const [selectedAudioUri, setSelectedAudioUri] = useState<string | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState<string | null>(
    null
  );
  const [transcriptText, setTranscriptText] = useState<string>('');
  const [mode, setMode] = useState<SubtitleMode>('fast');
  const [granularity, setGranularity] =
    useState<SubtitleGranularity>('sentence');
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubtitleResult | null>(null);

  const selectedMode = useMemo(
    () =>
      MODE_OPTIONS.find((option) => option.value === mode) ?? {
        value: 'fast',
        label: 'fast',
        description: 'Estimated timing',
      },
    [mode]
  );

  const selectedGranularity = useMemo(
    () =>
      GRANULARITY_OPTIONS.find((option) => option.value === granularity) ?? {
        value: 'sentence',
        label: 'sentence',
        description: 'Generate one subtitle item per sentence',
      },
    [granularity]
  );

  const shouldWarnNonWav = useMemo(() => {
    if (!selectedAudioName) {
      return false;
    }
    return !selectedAudioName.toLowerCase().endsWith('.wav');
  }, [selectedAudioName]);

  const pickAudioFile = async () => {
    setError(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as { fileUri?: string })?.fileUri ?? '';
      if (!uri) {
        setError('Could not resolve file URI from picker result.');
        return;
      }

      setSelectedAudioUri(uri);
      setSelectedAudioName(file?.name ?? getFileNameFromUri(uri));
      setResult(null);
    } catch (err: unknown) {
      const cancelled =
        (
          DocumentPicker as { isCancel?: (value: unknown) => boolean }
        ).isCancel?.(err) ?? false;
      if (cancelled) {
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Failed to pick audio file'
      );
    }
  };

  const handleGenerateTimestamps = async () => {
    if (!selectedAudioUri) {
      setError('Please choose an audio file first.');
      return;
    }

    const text = transcriptText.trim();
    if (!text) {
      setError('Please enter transcript text.');
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);

    let cleanupPath: string | null = null;
    try {
      let audioPath = normalizeUriToPath(selectedAudioUri);
      if (selectedAudioUri.startsWith('content://')) {
        audioPath = await copyContentUriToCache(
          selectedAudioUri,
          `timestamp_input_${Date.now()}.wav`
        );
        cleanupPath = audioPath;
      }

      const subtitleResult = await generateSubtitlesFromAudioLocal(
        text,
        audioPath,
        {
          mode,
          granularity,
        }
      );
      setResult(subtitleResult);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate timestamps';
      setError(message);
    } finally {
      if (cleanupPath) {
        unlink(cleanupPath).catch(() => {
          // ignore cleanup errors
        });
      }
      setRunning(false);
    }
  };

  const closeDropdown = () => setOpenDropdown(null);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Select Audio File</Text>
            <Text style={styles.sectionDescription}>
              Choose the audio file for timestamp generation.
            </Text>

            <View style={styles.hintCard}>
              <Ionicons
                name="information-circle-outline"
                size={18}
                color="#FF9800"
              />
              <Text style={styles.hintText}>
                Recommended input format: WAV, mono, 16 kHz.
              </Text>
            </View>

            <TouchableOpacity style={styles.button} onPress={pickAudioFile}>
              <Text style={styles.buttonText}>Choose Audio File</Text>
            </TouchableOpacity>

            {selectedAudioName && (
              <View style={styles.selectedFileCard}>
                <Text style={styles.selectedFileLabel}>Selected:</Text>
                <Text style={styles.selectedFileName}>{selectedAudioName}</Text>
                {shouldWarnNonWav && (
                  <Text style={styles.warningText}>
                    This file is not a .wav file. For best results use WAV mono
                    16 kHz.
                  </Text>
                )}
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Transcript Text</Text>
            <Text style={styles.sectionDescription}>
              Enter the text that should be aligned to the selected audio.
            </Text>
            <Text style={styles.inputLabel}>Transcript</Text>
            <TextInput
              style={styles.textInput}
              value={transcriptText}
              onChangeText={setTranscriptText}
              placeholder="Enter transcript text..."
              multiline
              numberOfLines={5}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Options</Text>
            <Text style={styles.sectionDescription}>
              Set subtitle mode and granularity.
            </Text>

            <View style={styles.optionRow}>
              <Text style={styles.inputLabel}>Mode</Text>
              <TouchableOpacity
                style={styles.dropdownTrigger}
                onPress={() => setOpenDropdown('mode')}
              >
                <Text style={styles.dropdownTriggerText}>
                  {selectedMode.label}
                </Text>
                <Ionicons name="chevron-down" size={16} color="#666" />
              </TouchableOpacity>
            </View>

            <View style={styles.optionRow}>
              <Text style={styles.inputLabel}>Granularity</Text>
              <TouchableOpacity
                style={styles.dropdownTrigger}
                onPress={() => setOpenDropdown('granularity')}
              >
                <Text style={styles.dropdownTriggerText}>
                  {selectedGranularity.label}
                </Text>
                <Ionicons name="chevron-down" size={16} color="#666" />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[
                styles.button,
                styles.generateButton,
                running && styles.buttonDisabled,
              ]}
              onPress={handleGenerateTimestamps}
              disabled={running}
            >
              {running ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Generate Timestamps</Text>
              )}
            </TouchableOpacity>

            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          {result && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>4. Result</Text>
              <View style={styles.resultCard}>
                <Text style={styles.resultMetaText}>
                  Timing mode: {result.timingMode}
                </Text>
                <Text style={styles.resultMetaText}>
                  Subtitle items: {result.subtitles.length}
                </Text>
              </View>

              {result.subtitles.length > 0 ? (
                <View style={styles.subtitleList}>
                  {result.subtitles.map((item, index) => (
                    <View
                      key={`${item.text}-${item.start}-${index}`}
                      style={styles.subtitleItem}
                    >
                      <Text style={styles.subtitleText}>
                        {item.text.trim().length > 0 ? item.text : '...'}
                      </Text>
                      <Text style={styles.subtitleTime}>
                        {formatTime(item.start)}s - {formatTime(item.end)}s
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyText}>No subtitles generated.</Text>
              )}
            </View>
          )}
        </ScrollView>
      </View>

      <Modal
        transparent
        visible={openDropdown != null}
        animationType="fade"
        onRequestClose={closeDropdown}
      >
        <Pressable style={styles.dropdownBackdrop} onPress={closeDropdown}>
          <Pressable style={styles.dropdownMenu}>
            <Text style={styles.dropdownTitle}>
              {openDropdown === 'mode' ? 'Select mode' : 'Select granularity'}
            </Text>
            {openDropdown === 'mode'
              ? MODE_OPTIONS.map((option) => {
                  const active = option.value === mode;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.dropdownItem,
                        active && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setMode(option.value);
                        closeDropdown();
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          active && styles.dropdownItemTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text style={styles.dropdownItemDescription}>
                        {option.description}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              : GRANULARITY_OPTIONS.map((option) => {
                  const active = option.value === granularity;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[
                        styles.dropdownItem,
                        active && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setGranularity(option.value);
                        closeDropdown();
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          active && styles.dropdownItemTextActive,
                        ]}
                      >
                        {option.label}
                      </Text>
                      <Text style={styles.dropdownItemDescription}>
                        {option.description}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
