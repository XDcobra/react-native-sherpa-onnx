import { useState, useEffect, useMemo } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  TextInput,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  resolveModelPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import RNFS from 'react-native-fs';
import {
  listDownloadedModelsByCategory,
  ModelCategory,
} from 'react-native-sherpa-onnx/download';
import {
  getSizeHint,
  getQualityHint,
  RECOMMENDED_MODEL_IDS,
} from '../../utils/recommendedModels';
import { getCpuCoreCount } from '../../cpuInfo';
import {
  initializeSTT,
  unloadSTT,
  transcribeFile,
  type STTModelType,
} from 'react-native-sherpa-onnx/stt';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../../modelConfig';
import { getAudioFilesForModel, type AudioFileInfo } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';

const PAD_PACK_NAME = 'sherpa_models';

export default function STTScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [padModelsPath, setPadModelsPath] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [selectedModelForInit, setSelectedModelForInit] = useState<
    string | null
  >(null);
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: STTModelType; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] =
    useState<STTModelType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioSourceType, setAudioSourceType] = useState<
    'example' | 'own' | null
  >(null);
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(
    null
  );
  const [customAudioPath, setCustomAudioPath] = useState<string | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string | null>(null);
  const [transcriptionResult, setTranscriptionResult] = useState<string | null>(
    null
  );
  const [transcribing, setTranscribing] = useState(false);
  const [soundPlayer, setSoundPlayer] = useState<any>(null);

  const [cpuCoreCount, setCpuCoreCount] = useState(2);
  const [sttThreadOption, setSttThreadOption] = useState<
    'saver' | 'standard' | 'balanced' | 'maximum'
  >('standard');
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [showModelTypePicker, setShowModelTypePicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [preferInt8, setPreferInt8] = useState<'default' | 'true' | 'false'>(
    'default'
  );
  const [modelTypeOption, setModelTypeOption] = useState<string>('auto');
  const [debug, setDebug] = useState(false);
  const [hotwordsFiles, setHotwordsFiles] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [hotwordsScore, setHotwordsScore] = useState('');
  const [provider, setProvider] = useState('');
  const [ruleFstPaths, setRuleFstPaths] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [ruleFarPaths, setRuleFarPaths] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [dither, setDither] = useState('');

  const sttThreadOptions = useMemo(() => {
    const max = Math.max(1, cpuCoreCount);
    const options: Array<{
      id: 'saver' | 'standard' | 'balanced' | 'maximum';
      label: string;
      threads: number;
    }> = [{ id: 'saver', label: 'Saver (1 thread)', threads: 1 }];
    if (max >= 2) {
      options.push({
        id: 'standard',
        label: 'Standard (2 threads)',
        threads: 2,
      });
    }
    options.push({
      id: 'balanced',
      label: `Balanced (${Math.max(1, Math.floor(max / 2))} threads)`,
      threads: Math.max(1, Math.floor(max / 2)),
    });
    options.push({
      id: 'maximum',
      label: `Maximum (${Math.max(1, max - 1)} threads)`,
      threads: Math.max(1, max - 1),
    });
    return options;
  }, [cpuCoreCount]);

  const sttNumThreads = useMemo(() => {
    const option = sttThreadOptions.find((o) => o.id === sttThreadOption);
    return option?.threads ?? (cpuCoreCount >= 2 ? 2 : 1);
  }, [sttThreadOptions, sttThreadOption, cpuCoreCount]);

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    getCpuCoreCount().then(setCpuCoreCount);
  }, []);

  // Cleanup: Release STT resources when leaving the screen
  useEffect(() => {
    return () => {
      if (currentModelFolder !== null) {
        console.log('STTScreen: Cleaning up STT resources');
        unloadSTT().catch((err) => {
          console.error('STTScreen: Failed to unload STT:', err);
        });
      }
    };
  }, [currentModelFolder]);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const downloadedModels = await listDownloadedModelsByCategory(
        ModelCategory.Stt
      );
      const downloadedIds = downloadedModels
        .map((model) => model.id)
        .filter(Boolean);

      const assetModels = await listAssetModels();
      const sttFolders = assetModels
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${RNFS.DocumentDirectoryPath}/models`;
        const padPath = padPathFromNative ?? fallbackPath;
        const padResults = await listModelsAtPath(padPath);
        padFolders = (padResults || [])
          .filter((m) => m.hint === 'stt')
          .map((m) => m.folder);
        if (padFolders.length > 0) {
          resolvedPadPath = padPath;
          console.log(
            'STTScreen: Found PAD/filesystem STT models:',
            padFolders,
            'at',
            padPath
          );
        }
      } catch (e) {
        console.warn('STTScreen: PAD/listModelsAtPath failed', e);
        padFolders = [];
      }
      setPadModelsPath(resolvedPadPath);

      // Merge: prefer downloaded, then PAD folders, then bundled asset folders (avoid duplicates)
      const combined = [
        ...downloadedIds,
        ...padFolders.filter((f) => !downloadedIds.includes(f)),
        ...sttFolders.filter(
          (f) => !downloadedIds.includes(f) && !padFolders.includes(f)
        ),
      ];

      setPadModelIds(padFolders);

      if (downloadedIds.length > 0) {
        console.log('STTScreen: Found downloaded models:', downloadedIds);
      }
      if (sttFolders.length > 0) {
        console.log('STTScreen: Found asset models:', sttFolders);
      }

      setDownloadedModelIds(downloadedIds);
      setAvailableModels(combined);

      if (combined.length === 0) {
        const hasRecommendedModels =
          (RECOMMENDED_MODEL_IDS[ModelCategory.Stt] || []).length > 0;

        if (hasRecommendedModels) {
          setError(
            'No STT models found. Consider downloading one of the recommended models in the Model Management screen.'
          );
          console.log(
            'STTScreen: No models available. Recommended models available for download.'
          );
        } else {
          setError('No STT models found. See STT_MODEL_SETUP.md');
        }
      }
    } catch (err) {
      console.error('STTScreen: Failed to load models:', err);
      setError('Failed to load available models');
      setDownloadedModelIds([]);
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setError(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);

    try {
      // Unload previous model if any
      if (currentModelFolder) {
        await unloadSTT();
      }

      // Initialize new model: PAD models use padModelsPath as base; downloaded use default STT path; assets use getAssetModelPath
      const useFilePath =
        downloadedModelIds.includes(modelFolder) ||
        padModelIds.includes(modelFolder);

      const modelPath = useFilePath
        ? padModelIds.includes(modelFolder) && padModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Stt, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Stt)
        : getAssetModelPath(modelFolder);

      const preferInt8Value =
        preferInt8 === 'true'
          ? true
          : preferInt8 === 'false'
          ? false
          : undefined;
      const modelTypeValue =
        modelTypeOption === 'auto'
          ? undefined
          : (modelTypeOption as STTModelType);
      const hotwordsScoreTrim = hotwordsScore.trim();
      const ditherTrim = dither.trim();

      const result = await initializeSTT({
        modelPath,
        numThreads: sttNumThreads,
        preferInt8: preferInt8Value,
        modelType: modelTypeValue,
        debug,
        hotwordsFile: hotwordsFiles[0]?.path ?? undefined,
        hotwordsScore:
          hotwordsScoreTrim !== '' ? parseFloat(hotwordsScoreTrim) : undefined,
        provider: provider.trim() || undefined,
        ruleFsts:
          ruleFstPaths.length > 0
            ? ruleFstPaths.map((f) => f.path).join(',')
            : undefined,
        ruleFars:
          ruleFarPaths.length > 0
            ? ruleFarPaths.map((f) => f.path).join(',')
            : undefined,
        dither: ditherTrim !== '' ? parseFloat(ditherTrim) : undefined,
      });

      if (result.success && result.detectedModels.length > 0) {
        const normalizedDetected = result.detectedModels.map((model) => ({
          ...model,
          type: model.type as STTModelType,
        }));
        setDetectedModels(normalizedDetected);
        setCurrentModelFolder(modelFolder);

        const detectedTypes = normalizedDetected.map((m) => m.type).join(', ');
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected models: ${detectedTypes}`
        );

        // Auto-select first detected model
        if (normalizedDetected.length === 1 && normalizedDetected[0]) {
          setSelectedModelType(normalizedDetected[0].type);
        }
      } else {
        setError('No models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
      }

      // Reset audio selection when changing models
      setAudioSourceType(null);
      setSelectedAudio(null);
      setCustomAudioPath(null);
      setCustomAudioName(null);
      setTranscriptionResult(null);
    } catch (err) {
      // Log full error details for debugging
      console.error('Initialization error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        // Include error code if available (React Native error objects)
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
        // Include stack trace in console
        if (err.stack) {
          console.error('Stack trace:', err.stack);
        }
      } else if (typeof err === 'object' && err !== null) {
        // Handle React Native error objects
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setError(errorMessage);
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nNote: Models must be provided separately. See MODEL_SETUP.md for details.\n\nCheck Logcat (Android) or Console (iOS) for detailed logs.`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleTranscribe = async () => {
    if (!currentModelFolder) {
      setError('Please select a model first');
      return;
    }

    // If a custom audio file was chosen, prefer it
    if (!selectedAudio && !customAudioPath) {
      setError('Please select an audio file (example or local WAV)');
      return;
    }

    setTranscribing(true);
    setError(null);
    setTranscriptionResult(null);

    try {
      let pathToTranscribe: string;

      if (customAudioPath) {
        pathToTranscribe = customAudioPath;
      } else {
        // Resolve audio file path (using auto detection - tries asset first, then file system)
        const audioPathConfig = autoModelPath(selectedAudio!.id);
        pathToTranscribe = await resolveModelPath(audioPathConfig);
      }

      // Transcribe the audio file (pathToTranscribe may be an asset path or file URI)
      const result = await transcribeFile(pathToTranscribe);
      setTranscriptionResult(result.text ?? '');
    } catch (err) {
      console.error('Transcription error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
      } else if (typeof err === 'object' && err !== null) {
        const errorObj = err as any;
        errorMessage =
          errorObj.message ||
          errorObj.userInfo?.NSLocalizedDescription ||
          JSON.stringify(err);
        if (errorObj.code) {
          errorMessage = `[${errorObj.code}] ${errorMessage}`;
        }
      }

      setError(errorMessage);
    } finally {
      setTranscribing(false);
    }
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setTranscriptionResult(null);

    try {
      const res = await DocumentPicker.pick({
        type: [DocumentPicker.types.audio],
      });

      // res may be an array or single object depending on version/config
      const file = Array.isArray(res) ? res[0] : res;
      const uri = file.uri || file.name;
      const name = file.name || uri?.split('/')?.pop() || 'local.wav';

      if (!uri) {
        setError('Could not get file URI from picker result');
        return;
      }

      setCustomAudioPath(uri);
      setCustomAudioName(name);
      // clear example selection when choosing a local file
      setSelectedAudio(null);
    } catch (err: any) {
      const isCancel =
        (DocumentPicker &&
          typeof (DocumentPicker as any).isCancel === 'function' &&
          (DocumentPicker as any).isCancel(err)) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled' ||
        (typeof err?.message === 'string' &&
          err.message.toLowerCase().includes('cancel'));
      if (isCancel) {
        // user cancelled, ignore
        return;
      }
      console.error('File pick error:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const normalizePickedFiles = (
    res: unknown
  ): Array<{ path: string; name: string }> => {
    const arr = Array.isArray(res) ? res : res ? [res] : [];
    return arr
      .map((f: any) => {
        const path = f?.uri ?? f?.fileUri ?? f?.path ?? '';
        const name = f?.name ?? (path ? path.split('/').pop() ?? '' : '');
        return path ? { path, name } : null;
      })
      .filter((x): x is { path: string; name: string } => x != null);
  };

  const handlePickHotwordsFiles = async () => {
    try {
      const res = await DocumentPicker.pick({
        allowMultiSelection: true,
        type: ['*/*'],
      });
      const files = normalizePickedFiles(res);
      if (files.length > 0) {
        setHotwordsFiles((prev) => [...prev, ...files]);
      }
    } catch (err: any) {
      if (
        (DocumentPicker as any).isCancel?.(err) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled'
      )
        return;
      console.warn('Hotwords pick error:', err);
    }
  };

  const handlePickRuleFsts = async () => {
    try {
      const res = await DocumentPicker.pick({
        allowMultiSelection: true,
        type: ['*/*'],
      });
      const files = normalizePickedFiles(res);
      if (files.length > 0) {
        setRuleFstPaths((prev) => [...prev, ...files]);
      }
    } catch (err: any) {
      if (
        (DocumentPicker as any).isCancel?.(err) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled'
      )
        return;
      console.warn('Rule FSTs pick error:', err);
    }
  };

  const handlePickRuleFars = async () => {
    try {
      const res = await DocumentPicker.pick({
        allowMultiSelection: true,
        type: ['*/*'],
      });
      const files = normalizePickedFiles(res);
      if (files.length > 0) {
        setRuleFarPaths((prev) => [...prev, ...files]);
      }
    } catch (err: any) {
      if (
        (DocumentPicker as any).isCancel?.(err) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled'
      )
        return;
      console.warn('Rule FARs pick error:', err);
    }
  };

  const handlePlayAudio = () => {
    if (!customAudioPath) return;

    try {
      // Try to use react-native-sound if available

      const Sound = require('react-native-sound');
      Sound.setCategory('Playback');

      // Stop previous player if any
      if (soundPlayer) {
        soundPlayer.stop();
        soundPlayer.release();
      }

      const player = new Sound(customAudioPath, '', (soundErr: any) => {
        if (soundErr) {
          console.error('Failed to load sound', soundErr);
          Alert.alert('Error', 'Failed to load audio file');
          return;
        }
        // Play the audio
        player.play((success: boolean) => {
          if (!success) {
            Alert.alert('Error', 'Playback failed');
          }
          player.release();
        });
      });

      setSoundPlayer(player);
    } catch {
      Alert.alert(
        'Audio Playback Not Available',
        'Please install react-native-sound to play audio files:\n\ncd example\nnpm install react-native-sound'
      );
    }
  };

  // Get available audio files for current model
  const availableAudioFiles = currentModelFolder
    ? getAudioFilesForModel(currentModelFolder)
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize Model</Text>
            <Text style={styles.hint}>
              Select a model and options, then tap "Apply options & use model".
              Changing options requires re-initializing.
            </Text>

            <Text style={styles.inputLabel}>Threads</Text>
            <TouchableOpacity
              style={styles.dropdownTrigger}
              onPress={() => setShowThreadPicker(true)}
            >
              <View style={styles.dropdownTriggerLeft}>
                <Ionicons
                  name="hardware-chip-outline"
                  size={22}
                  color="#8E8E93"
                  style={styles.iconInline}
                />
                <Text style={styles.dropdownTriggerText}>
                  {sttThreadOptions.find((o) => o.id === sttThreadOption)
                    ?.label ?? 'Standard (2 threads)'}
                </Text>
              </View>
              <Ionicons name="chevron-down" size={20} color="#8E8E93" />
            </TouchableOpacity>
            <Modal
              visible={showThreadPicker}
              transparent
              animationType="fade"
              onRequestClose={() => setShowThreadPicker(false)}
            >
              <Pressable
                style={styles.dropdownBackdrop}
                onPress={() => setShowThreadPicker(false)}
              >
                <View style={styles.dropdownMenu}>
                  {sttThreadOptions.map((opt) => (
                    <TouchableOpacity
                      key={opt.id}
                      style={[
                        styles.dropdownItem,
                        sttThreadOption === opt.id && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setSttThreadOption(opt.id);
                        setShowThreadPicker(false);
                      }}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          sttThreadOption === opt.id &&
                            styles.dropdownItemTextActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                      {sttThreadOption === opt.id && (
                        <Ionicons name="checkmark" size={20} color="#007AFF" />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              </Pressable>
            </Modal>

            <View style={styles.separator} />

            {(currentModelFolder || selectedModelForInit) && (
              <View style={styles.currentModelContainer}>
                <Text style={styles.currentModelText}>
                  {currentModelFolder
                    ? `Initialized: ${getModelDisplayName(currentModelFolder)}`
                    : `Selected: ${
                        selectedModelForInit
                          ? getModelDisplayName(selectedModelForInit)
                          : ''
                      }`}
                </Text>
              </View>
            )}

            {loadingModels ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.loadingText}>
                  Discovering available models...
                </Text>
              </View>
            ) : availableModels.length === 0 ? (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No models found in assets/models/ folder. Please add STT
                  models first. See STT_MODEL_SETUP.md for details.
                </Text>
              </View>
            ) : (
              <View style={styles.modelButtons}>
                {availableModels.map((modelFolder) => {
                  const isSelected = selectedModelForInit === modelFolder;
                  const isInitialized = currentModelFolder === modelFolder;
                  return (
                    <TouchableOpacity
                      key={modelFolder}
                      style={[
                        styles.modelButton,
                        isSelected && styles.modelButtonActive,
                        loading && styles.buttonDisabled,
                      ]}
                      onPress={() => setSelectedModelForInit(modelFolder)}
                      disabled={loading}
                    >
                      <Text
                        style={[
                          styles.modelButtonText,
                          isSelected && styles.modelButtonTextActive,
                        ]}
                      >
                        {getModelDisplayName(modelFolder)}
                        {isInitialized ? ' ✓' : ''}
                      </Text>
                      {(() => {
                        const sizeHintInfo = getSizeHint(modelFolder);
                        const qualityHintInfo = getQualityHint(modelFolder);

                        return (
                          <View style={styles.modelHintRow}>
                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={sizeHintInfo.iconName as any}
                                size={12}
                                color={sizeHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {sizeHintInfo.tier}
                              </Text>
                            </View>

                            <View style={styles.modelHintGroup}>
                              <Ionicons
                                name={qualityHintInfo.iconName as any}
                                size={12}
                                color={qualityHintInfo.iconColor}
                              />
                              <Text style={styles.modelHintText}>
                                {qualityHintInfo.text.split(',')[0]}
                              </Text>
                            </View>
                          </View>
                        );
                      })()}
                      <Text style={styles.modelFolderText}>{modelFolder}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {(selectedModelForInit || currentModelFolder) && (
              <>
                <View style={styles.optionsSection}>
                  <TouchableOpacity
                    style={styles.optionsHeader}
                    onPress={() => setOptionsExpanded((prev) => !prev)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.optionsHeaderLeft}>
                      <Ionicons
                        name="options-outline"
                        size={22}
                        color="#8E8E93"
                        style={styles.iconInline}
                      />
                      <Text style={styles.optionsHeaderTitle}>
                        Options for this model
                      </Text>
                    </View>
                    <Ionicons
                      name={optionsExpanded ? 'chevron-up' : 'chevron-down'}
                      size={24}
                      color="#8E8E93"
                    />
                  </TouchableOpacity>
                  {optionsExpanded && (
                    <View style={styles.optionsContent}>
                      <Text style={styles.inputLabel}>Prefer int8</Text>
                      <View style={styles.optionsRow}>
                        {(['default', 'true', 'false'] as const).map((val) => (
                          <TouchableOpacity
                            key={val}
                            style={[
                              styles.optionsChip,
                              preferInt8 === val && styles.optionsChipActive,
                            ]}
                            onPress={() => setPreferInt8(val)}
                          >
                            <Text
                              style={[
                                styles.optionsChipText,
                                preferInt8 === val &&
                                  styles.optionsChipTextActive,
                              ]}
                            >
                              {val === 'default'
                                ? 'Default'
                                : val === 'true'
                                ? 'Yes'
                                : 'No'}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <Text style={styles.inputLabel}>Model type</Text>
                      <TouchableOpacity
                        style={styles.dropdownTrigger}
                        onPress={() => setShowModelTypePicker(true)}
                      >
                        <Text style={styles.dropdownTriggerText}>
                          {modelTypeOption}
                        </Text>
                        <Ionicons
                          name="chevron-down"
                          size={20}
                          color="#8E8E93"
                        />
                      </TouchableOpacity>
                      <Modal
                        visible={showModelTypePicker}
                        transparent
                        animationType="fade"
                        onRequestClose={() => setShowModelTypePicker(false)}
                      >
                        <Pressable
                          style={styles.dropdownBackdrop}
                          onPress={() => setShowModelTypePicker(false)}
                        >
                          <View
                            style={[
                              styles.dropdownMenu,
                              styles.dropdownMenuTall,
                            ]}
                          >
                            <ScrollView style={styles.dropdownScroll}>
                              {[
                                'auto',
                                'transducer',
                                'nemo_transducer',
                                'paraformer',
                                'nemo_ctc',
                                'zipformer_ctc',
                                'ctc',
                                'whisper',
                                'wenet_ctc',
                                'sense_voice',
                                'funasr_nano',
                                'fire_red_asr',
                                'moonshine',
                                'dolphin',
                                'canary',
                                'omnilingual',
                                'medasr',
                                'telespeech_ctc',
                              ].map((opt) => (
                                <TouchableOpacity
                                  key={opt}
                                  style={[
                                    styles.dropdownItem,
                                    modelTypeOption === opt &&
                                      styles.dropdownItemActive,
                                  ]}
                                  onPress={() => {
                                    setModelTypeOption(opt);
                                    setShowModelTypePicker(false);
                                  }}
                                >
                                  <Text
                                    style={[
                                      styles.dropdownItemText,
                                      modelTypeOption === opt &&
                                        styles.dropdownItemTextActive,
                                    ]}
                                  >
                                    {opt}
                                  </Text>
                                  {modelTypeOption === opt && (
                                    <Ionicons
                                      name="checkmark"
                                      size={20}
                                      color="#007AFF"
                                    />
                                  )}
                                </TouchableOpacity>
                              ))}
                            </ScrollView>
                          </View>
                        </Pressable>
                      </Modal>
                      {__DEV__ && (
                        <>
                          <Text style={styles.inputLabel}>Debug</Text>
                          <View style={styles.optionsRow}>
                            <TouchableOpacity
                              style={[
                                styles.optionsChip,
                                !debug && styles.optionsChipActive,
                              ]}
                              onPress={() => setDebug(false)}
                            >
                              <Text
                                style={[
                                  styles.optionsChipText,
                                  !debug && styles.optionsChipTextActive,
                                ]}
                              >
                                Off
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[
                                styles.optionsChip,
                                debug && styles.optionsChipActive,
                              ]}
                              onPress={() => setDebug(true)}
                            >
                              <Text
                                style={[
                                  styles.optionsChipText,
                                  debug && styles.optionsChipTextActive,
                                ]}
                              >
                                On
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </>
                      )}
                      <Text style={styles.inputLabel}>
                        Hotword files (optional)
                      </Text>
                      <TouchableOpacity
                        style={styles.addFilesButton}
                        onPress={handlePickHotwordsFiles}
                      >
                        <Ionicons
                          name="add-circle-outline"
                          size={20}
                          color="#007AFF"
                          style={styles.iconInline}
                        />
                        <Text style={styles.addFilesButtonText}>Add files</Text>
                      </TouchableOpacity>
                      {hotwordsFiles.length > 0 && (
                        <View style={styles.pickedFilesList}>
                          {hotwordsFiles.map((f, idx) => (
                            <View
                              key={`${f.path}-${idx}`}
                              style={styles.pickedFileRow}
                            >
                              <Text
                                style={styles.pickedFileName}
                                numberOfLines={1}
                                ellipsizeMode="middle"
                              >
                                {f.name}
                              </Text>
                              <TouchableOpacity
                                hitSlop={{
                                  top: 10,
                                  bottom: 10,
                                  left: 10,
                                  right: 10,
                                }}
                                onPress={() =>
                                  setHotwordsFiles((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                style={styles.pickedFileRemove}
                              >
                                <Ionicons
                                  name="close-circle"
                                  size={22}
                                  color="#8E8E93"
                                />
                              </TouchableOpacity>
                            </View>
                          ))}
                        </View>
                      )}
                      <Text style={styles.inputLabel}>
                        Hotwords score (optional)
                      </Text>
                      <TextInput
                        style={styles.parameterInput}
                        value={hotwordsScore}
                        onChangeText={setHotwordsScore}
                        keyboardType="decimal-pad"
                        placeholder="e.g. 1.5"
                        placeholderTextColor="#8E8E93"
                      />
                      <Text style={styles.inputLabel}>Provider (optional)</Text>
                      <TextInput
                        style={styles.parameterInput}
                        value={provider}
                        onChangeText={setProvider}
                        placeholder="e.g. cpu"
                        placeholderTextColor="#8E8E93"
                      />
                      <Text style={styles.inputLabel}>
                        Rule FSTs (optional)
                      </Text>
                      <TouchableOpacity
                        style={styles.addFilesButton}
                        onPress={handlePickRuleFsts}
                      >
                        <Ionicons
                          name="add-circle-outline"
                          size={20}
                          color="#007AFF"
                          style={styles.iconInline}
                        />
                        <Text style={styles.addFilesButtonText}>Add files</Text>
                      </TouchableOpacity>
                      {ruleFstPaths.length > 0 && (
                        <View style={styles.pickedFilesList}>
                          {ruleFstPaths.map((f, idx) => (
                            <View
                              key={`${f.path}-${idx}`}
                              style={styles.pickedFileRow}
                            >
                              <Text
                                style={styles.pickedFileName}
                                numberOfLines={1}
                                ellipsizeMode="middle"
                              >
                                {f.name}
                              </Text>
                              <TouchableOpacity
                                hitSlop={{
                                  top: 10,
                                  bottom: 10,
                                  left: 10,
                                  right: 10,
                                }}
                                onPress={() =>
                                  setRuleFstPaths((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                style={styles.pickedFileRemove}
                              >
                                <Ionicons
                                  name="close-circle"
                                  size={22}
                                  color="#8E8E93"
                                />
                              </TouchableOpacity>
                            </View>
                          ))}
                        </View>
                      )}
                      <Text style={styles.inputLabel}>
                        Rule FARs (optional)
                      </Text>
                      <TouchableOpacity
                        style={styles.addFilesButton}
                        onPress={handlePickRuleFars}
                      >
                        <Ionicons
                          name="add-circle-outline"
                          size={20}
                          color="#007AFF"
                          style={styles.iconInline}
                        />
                        <Text style={styles.addFilesButtonText}>Add files</Text>
                      </TouchableOpacity>
                      {ruleFarPaths.length > 0 && (
                        <View style={styles.pickedFilesList}>
                          {ruleFarPaths.map((f, idx) => (
                            <View
                              key={`${f.path}-${idx}`}
                              style={styles.pickedFileRow}
                            >
                              <Text
                                style={styles.pickedFileName}
                                numberOfLines={1}
                                ellipsizeMode="middle"
                              >
                                {f.name}
                              </Text>
                              <TouchableOpacity
                                hitSlop={{
                                  top: 10,
                                  bottom: 10,
                                  left: 10,
                                  right: 10,
                                }}
                                onPress={() =>
                                  setRuleFarPaths((prev) =>
                                    prev.filter((_, i) => i !== idx)
                                  )
                                }
                                style={styles.pickedFileRemove}
                              >
                                <Ionicons
                                  name="close-circle"
                                  size={22}
                                  color="#8E8E93"
                                />
                              </TouchableOpacity>
                            </View>
                          ))}
                        </View>
                      )}
                      <Text style={styles.inputLabel}>Dither (optional)</Text>
                      <TextInput
                        style={styles.parameterInput}
                        value={dither}
                        onChangeText={setDither}
                        keyboardType="decimal-pad"
                        placeholder="e.g. 0"
                        placeholderTextColor="#8E8E93"
                      />
                    </View>
                  )}
                </View>
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.applyButton,
                    loading && styles.buttonDisabled,
                  ]}
                  onPress={() =>
                    handleInitialize(
                      selectedModelForInit ?? currentModelFolder ?? ''
                    )
                  }
                  disabled={
                    loading || (!selectedModelForInit && !currentModelFolder)
                  }
                >
                  <Text style={styles.buttonText}>
                    Apply options & use model
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {initResult && (
              <View
                style={[styles.resultContainer, error && styles.errorContainer]}
              >
                <Text style={[styles.resultLabel, error && styles.errorLabel]}>
                  {error ? 'Error' : 'Result'}:
                </Text>
                <Text style={[styles.resultText, error && styles.errorText]}>
                  {initResult}
                </Text>
              </View>
            )}
          </View>

          {error && !initResult && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorLabel}>Error:</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Select Model Type</Text>
            <Text style={styles.hint}>
              If multiple model types were detected, select which one to use for
              transcription.
            </Text>

            {!currentModelFolder && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Please initialize a model directory first
                </Text>
              </View>
            )}

            {currentModelFolder && detectedModels.length === 0 && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  No models detected. Please try another directory.
                </Text>
              </View>
            )}

            {detectedModels.length > 0 && (
              <View style={styles.detectedModelsContainer}>
                {detectedModels.map((model, index) => (
                  <TouchableOpacity
                    key={`${model.type}-${index}`}
                    style={[
                      styles.detectedModelButton,
                      selectedModelType === model.type &&
                        styles.detectedModelButtonActive,
                    ]}
                    onPress={() => setSelectedModelType(model.type)}
                  >
                    <Text
                      style={[
                        styles.detectedModelButtonText,
                        selectedModelType === model.type &&
                          styles.detectedModelButtonTextActive,
                      ]}
                    >
                      {model.type.toUpperCase()}
                    </Text>
                    <Text style={styles.detectedModelPath}>
                      {model.modelDir}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {currentModelFolder &&
              detectedModels.length > 0 &&
              !selectedModelType && (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    Please select a model type above
                  </Text>
                </View>
              )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Transcribe Audio</Text>
            <Text style={styles.hint}>
              Select an audio source and transcribe it using the selected model.
            </Text>

            {!selectedModelType && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Please select a model type first
                </Text>
              </View>
            )}

            {selectedModelType && !audioSourceType && (
              <>
                <Text style={styles.subsectionTitle}>Choose Audio Source:</Text>
                <View style={styles.sourceChoiceRow}>
                  <TouchableOpacity
                    style={[
                      styles.sourceChoiceButton,
                      styles.flex1,
                      styles.mr12,
                    ]}
                    onPress={() => setAudioSourceType('example')}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="folder-outline"
                        size={18}
                        style={styles.iconInline}
                      />
                      <Text style={styles.sourceChoiceButtonText}>
                        Example Audio
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.sourceChoiceButton, styles.flex1]}
                    onPress={() => setAudioSourceType('own')}
                  >
                    <View style={styles.rowCenter}>
                      <Ionicons
                        name="musical-notes"
                        size={18}
                        style={styles.iconInline}
                      />
                      <Text style={styles.sourceChoiceButtonText}>
                        Select Your Own Audio
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {selectedModelType &&
              audioSourceType === 'example' &&
              availableAudioFiles.length > 0 && (
                <>
                  <Text style={styles.subsectionTitle}>Select Audio File:</Text>
                  <View style={styles.audioFilesContainer}>
                    {availableAudioFiles.map((audioFile) => (
                      <TouchableOpacity
                        key={audioFile.id}
                        style={[
                          styles.audioFileButton,
                          selectedAudio?.id === audioFile.id &&
                            styles.audioFileButtonActive,
                        ]}
                        onPress={() => setSelectedAudio(audioFile)}
                      >
                        <Text
                          style={[
                            styles.audioFileButtonText,
                            selectedAudio?.id === audioFile.id &&
                              styles.audioFileButtonTextActive,
                          ]}
                        >
                          {audioFile.name}
                        </Text>
                        <Text style={styles.audioFileDescription}>
                          {audioFile.description}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {selectedAudio && (
                    <TouchableOpacity
                      style={[
                        styles.button,
                        (transcribing || loading) && styles.buttonDisabled,
                      ]}
                      onPress={handleTranscribe}
                      disabled={transcribing || loading}
                    >
                      {transcribing ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.buttonText}>Transcribe Audio</Text>
                      )}
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.mt15]}
                    onPress={() => {
                      setAudioSourceType(null);
                      setSelectedAudio(null);
                      setTranscriptionResult(null);
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>
                      ← Change Audio Source
                    </Text>
                  </TouchableOpacity>

                  {transcriptionResult && (
                    <View style={styles.resultContainer}>
                      <Text style={styles.resultLabel}>Transcription:</Text>
                      <Text style={styles.resultText}>
                        {transcriptionResult}
                      </Text>
                    </View>
                  )}
                </>
              )}

            {selectedModelType && audioSourceType === 'own' && (
              <>
                <Text style={styles.subsectionTitle}>
                  Select Local WAV File:
                </Text>
                <TouchableOpacity
                  style={[styles.button, loading && styles.buttonDisabled]}
                  onPress={handlePickLocalFile}
                  disabled={loading}
                >
                  <View style={styles.rowCenter}>
                    <Ionicons
                      name="folder-open-outline"
                      size={16}
                      style={styles.iconInline}
                    />
                    <Text style={styles.buttonText}>Choose Local WAV</Text>
                  </View>
                </TouchableOpacity>

                {customAudioName && (
                  <View style={styles.selectedFileContainer}>
                    <Text style={styles.selectedFileLabel}>Selected file:</Text>
                    <Text style={styles.selectedFileName}>
                      {customAudioName}
                    </Text>

                    <TouchableOpacity
                      style={[styles.playButton]}
                      onPress={handlePlayAudio}
                    >
                      <View style={styles.rowAlignCenter}>
                        <Ionicons
                          name="play"
                          size={16}
                          style={styles.iconInline}
                        />
                        <Text style={styles.playButtonText}>Play Audio</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                )}

                {customAudioPath && (
                  <TouchableOpacity
                    style={[
                      styles.button,
                      (transcribing || loading) && styles.buttonDisabled,
                      styles.mt12,
                    ]}
                    onPress={handleTranscribe}
                    disabled={transcribing || loading}
                  >
                    {transcribing ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>Transcribe Audio</Text>
                    )}
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.secondaryButton, styles.mt15]}
                  onPress={() => {
                    setAudioSourceType(null);
                    setCustomAudioPath(null);
                    setCustomAudioName(null);
                    setTranscriptionResult(null);
                    if (soundPlayer) {
                      soundPlayer.stop();
                      soundPlayer.release();
                      setSoundPlayer(null);
                    }
                  }}
                >
                  <Text style={styles.secondaryButtonText}>
                    ← Change Audio Source
                  </Text>
                </TouchableOpacity>

                {transcriptionResult && (
                  <View style={styles.resultContainer}>
                    <Text style={styles.resultLabel}>Transcription:</Text>
                    <Text style={styles.resultText}>{transcriptionResult}</Text>
                  </View>
                )}
              </>
            )}

            {selectedModelType &&
              audioSourceType === 'example' &&
              availableAudioFiles.length === 0 && (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    No audio files available for this model
                  </Text>
                </View>
              )}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  body: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
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
  hint: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyButton: {
    marginTop: 16,
  },
  buttonDisabled: {
    backgroundColor: '#999',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  resultContainer: {
    marginTop: 30,
    padding: 20,
    backgroundColor: '#e8f5e9',
    borderRadius: 8,
  },
  resultLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
    marginBottom: 8,
  },
  resultText: {
    fontSize: 16,
    color: '#1b5e20',
  },
  errorContainer: {
    marginTop: 30,
    padding: 20,
    backgroundColor: '#ffebee',
    borderRadius: 8,
  },
  errorLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#c62828',
    marginBottom: 8,
  },
  errorText: {
    fontSize: 16,
    color: '#b71c1c',
  },
  currentModelContainer: {
    marginBottom: 15,
    padding: 10,
    backgroundColor: '#e3f2fd',
    borderRadius: 6,
  },
  currentModelText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1976d2',
    textAlign: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  loadingText: {
    marginTop: 15,
    fontSize: 14,
    color: '#666',
  },
  modelButtons: {
    gap: 12,
    marginTop: 10,
  },
  modelButton: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  modelButtonActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  modelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  modelButtonTextActive: {
    color: '#007AFF',
  },
  modelFolderText: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 4,
  },
  subsectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    marginTop: 15,
    marginBottom: 10,
  },
  audioFilesContainer: {
    marginTop: 10,
    marginBottom: 15,
  },
  audioFileButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    marginBottom: 10,
  },
  audioFileButtonActive: {
    backgroundColor: '#e3f2fd',
    borderColor: '#2196f3',
  },
  audioFileButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 4,
  },
  audioFileButtonTextActive: {
    color: '#1976d2',
  },
  audioFileDescription: {
    fontSize: 12,
    color: '#999',
  },
  warningContainer: {
    marginTop: 15,
    padding: 12,
    backgroundColor: '#fff3cd',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ffc107',
  },
  warningText: {
    fontSize: 14,
    color: '#856404',
    textAlign: 'center',
  },
  sourceChoiceButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sourceChoiceButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
  },
  sourceChoiceRow: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  flex1: {
    flex: 1,
  },
  mr12: {
    marginRight: 12,
  },
  mt15: {
    marginTop: 15,
  },
  mt12: {
    marginTop: 12,
  },
  secondaryButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  selectedFileContainer: {
    marginTop: 20,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  selectedFileLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
  },
  selectedFileName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  playButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  playButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  iconInline: {
    marginRight: 8,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAlignCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detectedModelsSection: {
    marginTop: 20,
  },
  detectedModelsContainer: {
    marginTop: 10,
  },
  detectedModelButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    marginBottom: 10,
  },
  detectedModelButtonActive: {
    backgroundColor: '#e3f2fd',
    borderColor: '#2196f3',
  },
  detectedModelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
    marginBottom: 4,
  },
  detectedModelButtonTextActive: {
    color: '#1976d2',
  },
  detectedModelPath: {
    fontSize: 12,
    color: '#999',
  },
  modelHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    marginTop: 4,
    gap: 8,
  },
  modelHintGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 12,
  },
  modelHintText: {
    fontSize: 11,
    color: '#666',
    marginTop: 0,
    fontStyle: 'italic',
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 8,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  dropdownTriggerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  dropdownTriggerText: {
    fontSize: 16,
    color: '#333',
    fontWeight: '500',
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdownMenu: {
    backgroundColor: '#fff',
    borderRadius: 12,
    minWidth: 220,
    paddingVertical: 8,
  },
  dropdownMenuTall: {
    maxHeight: 360,
  },
  dropdownScroll: {
    maxHeight: 320,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  dropdownItemActive: {
    backgroundColor: '#e3f2fd',
  },
  dropdownItemText: {
    fontSize: 16,
    color: '#333',
  },
  dropdownItemTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  optionsSection: {
    marginTop: 8,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    overflow: 'hidden',
  },
  optionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#f5f5f5',
  },
  optionsHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  optionsHeaderTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginLeft: 4,
  },
  optionsContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  optionsChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionsChipActive: {
    backgroundColor: '#e3f2fd',
    borderColor: '#007AFF',
  },
  optionsChipText: {
    fontSize: 14,
    color: '#666',
    fontWeight: '500',
  },
  optionsChipTextActive: {
    color: '#007AFF',
  },
  parameterInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#333',
    marginBottom: 12,
  },
  addFilesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: '#F2F2F7',
    alignSelf: 'flex-start',
  },
  addFilesButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
    marginLeft: 6,
  },
  pickedFilesList: {
    marginBottom: 12,
    gap: 4,
  },
  pickedFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#F2F2F7',
    borderRadius: 6,
  },
  pickedFileName: {
    fontSize: 13,
    color: '#333',
    flex: 1,
  },
  pickedFileRemove: {
    padding: 4,
    marginLeft: 8,
  },
  separator: {
    height: 1,
    backgroundColor: '#e0e0e0',
    marginTop: 8,
    marginBottom: 12,
    borderRadius: 1,
  },
});
