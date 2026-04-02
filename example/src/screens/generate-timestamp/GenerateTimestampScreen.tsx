import { useEffect, useMemo, useState } from 'react';
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
import {
  copyContentUriToCache,
  generateSubtitlesFromAudio,
  type SubtitleGranularity,
  type SubtitleMode,
  type SubtitleResult,
} from 'react-native-sherpa-onnx/tts';
import {
  deleteAlignmentModel,
  downloadAlignmentModel,
  isAlignmentModelReady,
} from 'react-native-sherpa-onnx';
import { styles } from './GenerateTimestampScreen.styles';

type DropdownType = 'mode' | 'granularity' | null;
type ScreenSubtitleMode = Extract<SubtitleMode, 'fast' | 'accurate'>;

type ModeOption = {
  value: ScreenSubtitleMode;
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
    description: 'Precise forced alignment using wav2vec2 (requires model)',
  },
];

const ALL_GRANULARITY_OPTIONS: GranularityOption[] = [
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
  {
    value: 'character',
    label: 'character',
    description:
      'Generate one subtitle item per character (accurate mode only)',
  },
];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0.00';
  }
  return seconds.toFixed(2);
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function GenerateTimestampScreen() {
  const [selectedAudioUri, setSelectedAudioUri] = useState<string | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState<string | null>(
    null
  );
  const [transcriptText, setTranscriptText] = useState<string>('');
  const [mode, setMode] = useState<ScreenSubtitleMode>('fast');
  const [granularity, setGranularity] =
    useState<SubtitleGranularity>('sentence');
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);
  const [modelReady, setModelReady] = useState(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    bytesWritten: number;
    contentLength: number;
  } | null>(null);
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
      ALL_GRANULARITY_OPTIONS.find(
        (option) => option.value === granularity
      ) ?? {
        value: 'sentence',
        label: 'sentence',
        description: 'Generate one subtitle item per sentence',
      },
    [granularity]
  );

  const granularityOptions = useMemo(
    () =>
      mode === 'accurate'
        ? ALL_GRANULARITY_OPTIONS
        : ALL_GRANULARITY_OPTIONS.filter(
            (option) => option.value !== 'character'
          ),
    [mode]
  );

  const downloadProgressPercent = useMemo(() => {
    if (
      !downloadProgress ||
      !Number.isFinite(downloadProgress.contentLength) ||
      downloadProgress.contentLength <= 0
    ) {
      return 0;
    }
    return Math.max(
      0,
      Math.min(
        100,
        (downloadProgress.bytesWritten / downloadProgress.contentLength) * 100
      )
    );
  }, [downloadProgress]);

  const shouldWarnNonWav = useMemo(() => {
    if (!selectedAudioName) {
      return false;
    }
    return !selectedAudioName.toLowerCase().endsWith('.wav');
  }, [selectedAudioName]);

  const refreshAlignmentModelStatus = async () => {
    try {
      const ready = await isAlignmentModelReady();
      setModelReady(ready);
    } catch {
      setModelReady(false);
    }
  };

  useEffect(() => {
    refreshAlignmentModelStatus().catch(() => {
      // ignore initial status errors
    });
  }, []);

  useEffect(() => {
    if (mode === 'accurate') {
      refreshAlignmentModelStatus().catch(() => {
        // ignore status refresh errors
      });
    }
  }, [mode]);

  useEffect(() => {
    const isValid = granularityOptions.some(
      (option) => option.value === granularity
    );
    if (!isValid) {
      setGranularity('sentence');
    }
  }, [granularity, granularityOptions]);

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

  const handleDownloadAlignmentModel = async () => {
    setError(null);
    setIsDownloadingModel(true);
    setDownloadProgress({ bytesWritten: 0, contentLength: 0 });

    try {
      await downloadAlignmentModel({
        onProgress: (progress: {
          bytesWritten: number;
          contentLength: number;
        }) => {
          setDownloadProgress(progress);
        },
      });
      setModelReady(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to download model';
      setError(message);
    } finally {
      setIsDownloadingModel(false);
    }
  };

  const handleDeleteAlignmentModel = async () => {
    setError(null);
    try {
      await deleteAlignmentModel();
      setModelReady(false);
      setDownloadProgress(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete model';
      setError(message);
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

    if (mode === 'accurate' && !modelReady) {
      setError(
        'Accurate mode requires the alignment model. Download it first.'
      );
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

      const subtitleResult = await generateSubtitlesFromAudio(text, audioPath, {
        mode,
        granularity,
      });
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
              Set subtitle mode and granularity (character is accurate-only).
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

            {mode === 'accurate' && (
              <View style={styles.modelCard}>
                <Text style={styles.inputLabel}>Alignment model</Text>
                <Text style={styles.sectionDescription}>
                  Accurate mode uses wav2vec2 forced alignment and requires a
                  one-time model download.
                </Text>

                <View style={styles.modelStatusRow}>
                  <Text style={styles.modelStatusLabel}>Status:</Text>
                  <Text
                    style={[
                      styles.modelStatusValue,
                      modelReady && styles.modelStatusValueReady,
                    ]}
                  >
                    {modelReady ? 'Ready' : 'Not downloaded'}
                  </Text>
                </View>

                {isDownloadingModel && (
                  <View style={styles.progressContainer}>
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: `${downloadProgressPercent}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.progressText}>
                      {formatBytes(downloadProgress?.bytesWritten ?? 0)}
                      {' / '}
                      {formatBytes(downloadProgress?.contentLength ?? 0)}
                    </Text>
                  </View>
                )}

                <View style={styles.modelButtonsRow}>
                  <TouchableOpacity
                    style={[
                      styles.modelButton,
                      (isDownloadingModel || modelReady) &&
                        styles.modelButtonDisabled,
                    ]}
                    onPress={handleDownloadAlignmentModel}
                    disabled={isDownloadingModel || modelReady}
                  >
                    {isDownloadingModel ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={styles.modelButtonText}>Download model</Text>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.modelButton,
                      styles.modelButtonSecondary,
                      (isDownloadingModel || !modelReady) &&
                        styles.modelButtonDisabled,
                    ]}
                    onPress={handleDeleteAlignmentModel}
                    disabled={isDownloadingModel || !modelReady}
                  >
                    <Text
                      style={[
                        styles.modelButtonText,
                        styles.modelButtonTextSecondary,
                      ]}
                    >
                      Delete model
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

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
              : granularityOptions.map((option) => {
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
