import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { DocumentDirectoryPath, unlink } from '@dr.pogodin/react-native-fs';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import { copyContentUriToCache } from 'react-native-sherpa-onnx/files';
import {
  alignTextToAudio,
  detectAlignmentModel,
  type AlignTextToAudioResult,
  type AlignmentGranularity,
  type AlignmentModelType,
} from 'react-native-sherpa-onnx/alignment';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createOfflineTextBufferFromText,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
  type ModelMeta,
} from 'react-native-sherpa-onnx/download';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../../modelConfig';
import { styles } from './GenerateTimestampScreen.styles';

const PAD_PACK_NAME = 'sherpa_models';

/** Bundled wav2vec2 alignment folders are inferred as `unknown` by native listAssetModels (see STT/TTS hints). */
function isAlignmentModelFolder(folder: string, hint: string): boolean {
  if (hint === 'alignment') {
    return true;
  }
  const n = folder.toLowerCase();
  return n.includes('wav2vec');
}

type AlignmentModelEntry = { id: string; label: string };

type DropdownType = 'mode' | 'granularity' | null;
type ScreenSubtitleMode = 'proportional' | 'accurate';

type ModeOption = {
  value: ScreenSubtitleMode;
  label: string;
  description: string;
};

type GranularityOption = {
  value: AlignmentGranularity;
  label: string;
  description: string;
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'proportional',
    label: 'proportional',
    description: 'Spread duration by text weight (no alignment model)',
  },
  {
    value: 'accurate',
    label: 'accurate',
    description: 'CTC forced alignment (wav2vec2; requires model)',
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

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function getAlignmentModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
  }
) {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Alignment, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export default function GenerateTimestampScreen() {
  const [availableModels, setAvailableModels] = useState<AlignmentModelEntry[]>(
    []
  );
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [bundledAlignmentFolders, setBundledAlignmentFolders] = useState<
    string[]
  >([]);
  const [downloadedAlignmentIds, setDownloadedAlignmentIds] = useState<
    string[]
  >([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [initializedModelId, setInitializedModelId] = useState<string | null>(
    null
  );
  const [initializedModelPath, setInitializedModelPath] = useState<
    string | null
  >(null);
  const [detectedModelType, setDetectedModelType] = useState<string | null>(
    null
  );
  const [initializingModel, setInitializingModel] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);

  const [selectedAudioUri, setSelectedAudioUri] = useState<string | null>(null);
  const [selectedAudioName, setSelectedAudioName] = useState<string | null>(
    null
  );
  const [transcriptText, setTranscriptText] = useState<string>('');
  const [mode, setMode] = useState<ScreenSubtitleMode>('proportional');
  const [granularity, setGranularity] =
    useState<AlignmentGranularity>('sentence');
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'init' | 'generate' | null>(
    null
  );
  const [result, setResult] = useState<AlignTextToAudioResult | null>(null);

  const loadAvailableModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const assetModels = await listAssetModels();
      const bundledFolders = assetModels
        .filter((m) => isAlignmentModelFolder(m.folder, m.hint))
        .map((m) => m.folder);

      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => isAlignmentModelFolder(m.folder, m.hint))
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
          console.log(
            'GenerateTimestampScreen: PAD/filesystem alignment models:',
            padFolders,
            'at',
            padPath
          );
        }
      } catch (e) {
        console.warn('GenerateTimestampScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);
      setPadModelIds(padFolders);
      setBundledAlignmentFolders(bundledFolders);

      const downloaded = await listDownloadedModels(ModelCategory.Alignment);
      const downloadedIds = new Set(downloaded.map((d) => d.id));
      setDownloadedAlignmentIds([...downloadedIds]);

      const combinedIds: string[] = [];
      const pushId = (id: string) => {
        if (!combinedIds.includes(id)) {
          combinedIds.push(id);
        }
      };
      for (const id of padFolders) {
        pushId(id);
      }
      for (const id of bundledFolders) {
        pushId(id);
      }
      for (const d of downloaded) {
        pushId(d.id);
      }

      const metaById = new Map(downloaded.map((m) => [m.id, m] as const));
      const entries: AlignmentModelEntry[] = combinedIds.map((id) => {
        const meta = metaById.get(id);
        return {
          id,
          label: meta ? getModelLabel(meta) : getModelDisplayName(id),
        };
      });

      setAvailableModels(entries);

      const ids = new Set(combinedIds);
      setSelectedModelId((prev) => {
        if (prev && ids.has(prev)) {
          return prev;
        }
        return combinedIds[0] ?? null;
      });

      if (initializedModelId && !ids.has(initializedModelId)) {
        setInitializedModelId(null);
        setInitializedModelPath(null);
        setDetectedModelType(null);
        setInitResult(null);
      }
    } catch (err) {
      console.error(
        'GenerateTimestampScreen: Failed to load alignment models',
        err
      );
      setAvailableModels([]);
      setPadModelIds([]);
      setPadModelsPath(null);
      setBundledAlignmentFolders([]);
      setDownloadedAlignmentIds([]);
      setSelectedModelId(null);
    } finally {
      setLoadingModels(false);
    }
  }, [initializedModelId]);

  useEffect(() => {
    loadAvailableModels().catch(() => {
      // ignore initial loading errors
    });
  }, [loadAvailableModels]);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Alignment) {
        return;
      }
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });

    return unsubscribe;
  }, [loadAvailableModels]);

  const selectedMode = useMemo(
    () =>
      MODE_OPTIONS.find((option) => option.value === mode) ?? {
        value: 'proportional',
        label: 'proportional',
        description: 'Proportional timing',
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

  const shouldWarnNonWav = useMemo(() => {
    if (!selectedAudioName) {
      return false;
    }
    return !selectedAudioName.toLowerCase().endsWith('.wav');
  }, [selectedAudioName]);

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
    setErrorSource(null);
    try {
      const picked = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });
      const file = Array.isArray(picked) ? picked[0] : picked;
      const uri = file?.uri ?? (file as { fileUri?: string })?.fileUri ?? '';
      if (!uri) {
        setErrorSource('generate');
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
      setErrorSource('generate');
    }
  };

  const handleInitializeModel = async () => {
    if (!selectedModelId) {
      setErrorSource('init');
      setError('Please select a subtitle model first.');
      return;
    }

    setError(null);
    setErrorSource(null);
    setInitializingModel(true);
    setInitResult(null);

    try {
      const detection = await detectAlignmentModel(
        getAlignmentModelPathConfig(selectedModelId, {
          padModelIds,
          padModelsPath,
          bundledFolders: bundledAlignmentFolders,
          downloadedIds: new Set(downloadedAlignmentIds),
        }),
        { modelType: 'auto' as AlignmentModelType }
      );

      const modelPath = detection.paths?.model?.trim();
      if (!detection.success || !modelPath) {
        throw new Error(
          detection.error ||
            'Alignment model detection failed: no model.onnx path found.'
        );
      }

      setInitializedModelId(selectedModelId);
      setInitializedModelPath(modelPath);
      setDetectedModelType(
        detection.modelType ?? detection.detectedModels[0]?.type ?? null
      );
      setInitResult(
        `Initialized: ${getModelDisplayName(
          selectedModelId
        )}\nModel file: ${modelPath}`
      );
      setResult(null);
    } catch (err) {
      setErrorSource('init');
      setError(
        err instanceof Error ? err.message : 'Failed to initialize model'
      );
    } finally {
      setInitializingModel(false);
    }
  };

  const handleGenerateTimestamps = async () => {
    if (!initializedModelPath) {
      setErrorSource('generate');
      setError('Please initialize a subtitle model first.');
      return;
    }

    if (!selectedAudioUri) {
      setErrorSource('generate');
      setError('Please choose an audio file first.');
      return;
    }

    const text = transcriptText.trim();
    if (!text) {
      setErrorSource('generate');
      setError('Please enter transcript text.');
      return;
    }

    setRunning(true);
    setError(null);
    setErrorSource(null);
    setResult(null);

    let cleanupPath: string | null = null;
    let textBufferId: string | null = null;
    let audioBufferId: string | null = null;
    try {
      let audioPath = normalizeUriToPath(selectedAudioUri);
      if (selectedAudioUri.startsWith('content://')) {
        audioPath = await copyContentUriToCache(
          selectedAudioUri,
          `timestamp_input_${Date.now()}.wav`
        );
        cleanupPath = audioPath;
      }

      const proportionalGranularity: 'sentence' | 'word' =
        granularity === 'character' ? 'sentence' : granularity;

      const textBuffer = await createOfflineTextBufferFromText(text);
      textBufferId = textBuffer.bufferId;

      const audioBuffer = await createOfflineAudioBufferFromFile(audioPath);
      audioBufferId = audioBuffer.bufferId;

      const subtitleResult =
        mode === 'accurate'
          ? await alignTextToAudio(textBuffer, audioBuffer, {
              mode: 'accurate',
              granularity,
              alignmentModelPath: initializedModelPath,
            })
          : await alignTextToAudio(textBuffer, audioBuffer, {
              mode: 'proportional',
              granularity: proportionalGranularity,
            });
      setResult(subtitleResult);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate timestamps';
      setError(message);
      setErrorSource('generate');
    } finally {
      if (textBufferId) {
        await releasePipelineTextBuffer(textBufferId).catch(() => {
          // ignore cleanup errors
        });
      }
      if (audioBufferId) {
        await releasePipelineAudioBuffer(audioBufferId).catch(() => {
          // ignore cleanup errors
        });
      }
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
            <Text style={styles.sectionTitle}>1. Initialize Model</Text>
            <Text style={styles.sectionDescription}>
              Select an alignment model from bundled assets (assets/models/),
              Play Asset Delivery, app documents, or downloads, then validate
              with autodetect before generation.
            </Text>

            {(selectedModelId || initializedModelId) && (
              <View style={styles.currentModelContainer}>
                <Text style={styles.currentModelText}>
                  {initializedModelId
                    ? `Initialized: ${getModelDisplayName(initializedModelId)}`
                    : `Selected: ${
                        selectedModelId
                          ? getModelDisplayName(selectedModelId)
                          : ''
                      }`}
                </Text>
                {detectedModelType && initializedModelId && (
                  <Text style={styles.currentModelMetaText}>
                    Detected type: {detectedModelType}
                  </Text>
                )}
              </View>
            )}

            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>
                  Loading alignment models...
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningBannerText}>
                  No alignment models found. Add a wav2vec2 model under
                  assets/models/, use PAD or documents/models, or download one
                  (category: alignment).
                </Text>
              </View>
            ) : (
              <View style={styles.modelButtons}>
                {availableModels.map((model) => {
                  const isSelected = selectedModelId === model.id;
                  const isInitialized = initializedModelId === model.id;
                  return (
                    <TouchableOpacity
                      key={model.id}
                      style={[
                        styles.modelSelectButton,
                        isSelected && styles.modelSelectButtonActive,
                        isInitialized && styles.modelSelectButtonInitialized,
                        initializingModel && styles.buttonDisabled,
                      ]}
                      onPress={() => setSelectedModelId(model.id)}
                      disabled={initializingModel}
                    >
                      <Text
                        style={[
                          styles.modelSelectButtonTitle,
                          isSelected && styles.modelSelectButtonTitleActive,
                        ]}
                      >
                        {model.label}
                      </Text>
                      <Text style={styles.modelSelectButtonId}>{model.id}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                styles.applyButton,
                initializingModel && styles.buttonDisabled,
              ]}
              onPress={handleInitializeModel}
              disabled={
                initializingModel ||
                !selectedModelId ||
                availableModels.length === 0
              }
            >
              {initializingModel ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Use model</Text>
              )}
            </TouchableOpacity>

            {initResult && !(error && errorSource === 'init') && (
              <View style={styles.initResultCard}>
                <Text style={styles.initResultText}>{initResult}</Text>
              </View>
            )}

            {error && errorSource === 'init' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Select Audio File</Text>
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
            <Text style={styles.sectionTitle}>3. Transcript Text</Text>
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
            <Text style={styles.sectionTitle}>4. Options</Text>
            <Text style={styles.sectionDescription}>
              Set subtitle mode and granularity (character is accurate-only).
            </Text>

            <View style={styles.modelSummaryCard}>
              <Text style={styles.modelSummaryLabel}>Initialized model</Text>
              <Text style={styles.modelSummaryValue}>
                {initializedModelId
                  ? getModelDisplayName(initializedModelId)
                  : 'Not initialized'}
              </Text>
              {initializedModelPath && (
                <Text style={styles.modelSummaryPath}>
                  {initializedModelPath}
                </Text>
              )}
            </View>

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

            {error && errorSource === 'generate' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>5. Result</Text>
            {result ? (
              <>
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
              </>
            ) : (
              <Text style={styles.emptyText}>
                No result yet. Initialize a model and run generation.
              </Text>
            )}
          </View>
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
