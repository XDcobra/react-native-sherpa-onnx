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
  Share,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
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
  detectSttModel,
  sttSupportsHotwords,
  type STTModelType,
  type SttModelOptions,
  type SttRecognitionResult,
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
  const [transcriptionResult, setTranscriptionResult] =
    useState<SttRecognitionResult | null>(null);
  const [tokensExpanded, setTokensExpanded] = useState(false);
  const [timestampsExpanded, setTimestampsExpanded] = useState(false);
  const [durationsExpanded, setDurationsExpanded] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [soundPlayer, setSoundPlayer] = useState<any>(null);

  const [cpuCoreCount, setCpuCoreCount] = useState(2);
  const [sttThreadOption, setSttThreadOption] = useState<
    'saver' | 'standard' | 'balanced' | 'maximum'
  >('standard');
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [showModelTypePicker, setShowModelTypePicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [modelTypeOption, setModelTypeOption] = useState<string>('auto');
  const [debug, setDebug] = useState(false);
  const [hotwordsFiles, setHotwordsFiles] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [hotwordsScore, setHotwordsScore] = useState('');
  const [hotwordsSectionExpanded, setHotwordsSectionExpanded] = useState(false);
  const [modelingUnit, setModelingUnit] = useState<
    '' | 'cjkchar' | 'bpe' | 'cjkchar+bpe'
  >('');
  const [bpeVocabFile, setBpeVocabFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [provider, setProvider] = useState('');
  const [ruleFstPaths, setRuleFstPaths] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [ruleFarPaths, setRuleFarPaths] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [dither, setDither] = useState('');
  const [sttModelOptions, setSttModelOptions] = useState<SttModelOptions>({});
  /** Model type detected for the currently selected folder (before init). Set by detectSttModel when user selects a model. */
  const [detectedTypeForSelectedFolder, setDetectedTypeForSelectedFolder] =
    useState<STTModelType | null>(null);
  const [detectingModelType, setDetectingModelType] = useState(false);

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

  // Model-specific options: only after we have a type (from init or from native detection). No heuristic fallback.
  // While detectingModelType, we show a full-screen overlay and effectiveModelTypeForOptions is null.
  const effectiveModelTypeForOptions =
    selectedModelForInit != null && detectingModelType
      ? null
      : currentModelFolder != null &&
        selectedModelForInit === currentModelFolder
      ? selectedModelType
      : selectedModelForInit != null
      ? detectedTypeForSelectedFolder ??
        (modelTypeOption !== 'auto' ? (modelTypeOption as STTModelType) : null)
      : modelTypeOption !== 'auto'
      ? (modelTypeOption as STTModelType)
      : null;

  /** Hotwords are only supported for transducer models; hide options for Whisper, Paraformer, etc. */
  const showHotwordsOptions = useMemo(
    () =>
      effectiveModelTypeForOptions != null &&
      sttSupportsHotwords(effectiveModelTypeForOptions),
    [effectiveModelTypeForOptions]
  );

  // Clear hotwords (and related options) when user selects a model that doesn't support them.
  useEffect(() => {
    if (
      effectiveModelTypeForOptions != null &&
      !sttSupportsHotwords(effectiveModelTypeForOptions) &&
      (hotwordsFiles.length > 0 || bpeVocabFile != null)
    ) {
      setHotwordsFiles([]);
      setBpeVocabFile(null);
    }
  }, [effectiveModelTypeForOptions, hotwordsFiles.length, bpeVocabFile]);

  // When user selects a model folder (before init), run native detection to get model type for model-specific options.
  useEffect(() => {
    if (!selectedModelForInit) {
      setDetectedTypeForSelectedFolder(null);
      setDetectingModelType(false);
      return;
    }
    const folder = selectedModelForInit;
    const useFilePath =
      downloadedModelIds.includes(folder) || padModelIds.includes(folder);
    const modelPath = useFilePath
      ? padModelIds.includes(folder) && padModelsPath
        ? getFileModelPath(folder, ModelCategory.Stt, padModelsPath)
        : getFileModelPath(folder, ModelCategory.Stt)
      : getAssetModelPath(folder);
    const modelTypeValue =
      modelTypeOption === 'auto'
        ? undefined
        : (modelTypeOption as STTModelType);

    setDetectingModelType(true);
    setDetectedTypeForSelectedFolder(null);
    detectSttModel(modelPath, {
      modelType: modelTypeValue,
    })
      .then((result) => {
        if (selectedModelForInit !== folder) return;
        if (result.success) {
          const primary = result.modelType ?? result.detectedModels[0]?.type;
          setDetectedTypeForSelectedFolder(
            primary ? (primary as STTModelType) : null
          );
        } else {
          setDetectedTypeForSelectedFolder(null);
        }
      })
      .catch(() => {
        if (selectedModelForInit !== folder) return;
        setDetectedTypeForSelectedFolder(null);
      })
      .finally(() => {
        if (selectedModelForInit === folder) {
          setDetectingModelType(false);
        }
      });
  }, [
    selectedModelForInit,
    downloadedModelIds,
    padModelIds,
    padModelsPath,
    modelTypeOption,
  ]);

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    getCpuCoreCount().then(setCpuCoreCount);
  }, []);

  // Cleanup: Release STT resources only when leaving the screen (unmount).
  // Do not depend on currentModelFolder: when switching models, handleInitialize
  // already calls unloadSTT() before re-init. If cleanup ran on currentModelFolder
  // change, it would call unloadSTT() after the new init and break transcription.
  useEffect(() => {
    return () => {
      console.log('STTScreen: Cleaning up STT resources');
      unloadSTT().catch((err) => {
        console.error('STTScreen: Failed to unload STT:', err);
      });
    };
  }, []);

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

      const modelTypeValue =
        modelTypeOption === 'auto'
          ? undefined
          : (modelTypeOption as STTModelType);
      const hotwordsScoreTrim = hotwordsScore.trim();
      const ditherTrim = dither.trim();

      // Only pass hotwords when the model we're initializing supports them (transducer / nemo_transducer).
      const modelTypeForInit: STTModelType | null =
        currentModelFolder != null && modelFolder === currentModelFolder
          ? selectedModelType
          : detectedTypeForSelectedFolder ??
            (modelTypeOption !== 'auto'
              ? (modelTypeOption as STTModelType)
              : null);
      const passHotwords =
        modelTypeForInit != null && sttSupportsHotwords(modelTypeForInit);

      const result = await initializeSTT({
        modelPath,
        numThreads: sttNumThreads,
        modelType: modelTypeValue,
        debug,
        hotwordsFile: passHotwords
          ? hotwordsFiles[0]?.path ?? undefined
          : undefined,
        hotwordsScore:
          passHotwords && hotwordsScoreTrim !== ''
            ? parseFloat(hotwordsScoreTrim)
            : undefined,
        modelingUnit:
          passHotwords && modelingUnit.trim() !== ''
            ? (modelingUnit as 'cjkchar' | 'bpe' | 'cjkchar+bpe')
            : undefined,
        bpeVocab: passHotwords ? bpeVocabFile?.path ?? undefined : undefined,
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
        modelOptions:
          Object.keys(sttModelOptions).length > 0 ? sttModelOptions : undefined,
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

        // Auto-select first detected model (use result.modelType when available for consistency)
        const loadedType =
          (result as { modelType?: string }).modelType ??
          normalizedDetected[0]?.type;
        if (loadedType) {
          setSelectedModelType(loadedType as STTModelType);
        } else if (normalizedDetected.length === 1 && normalizedDetected[0]) {
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
        `Initialization failed: ${errorMessage}\n\nThe error has been reported. We will address it as soon as possible in the next app update.`
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
      setTranscriptionResult(result);
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

      // NeMo streaming transducer: decoder expects cache_last_time etc.; offline decode doesn't provide them.
      if (
        typeof errorMessage === 'string' &&
        (errorMessage.includes('cache_last_time') ||
          (errorMessage.includes('Missing Input') &&
            errorMessage.toLowerCase().includes('cache')))
      ) {
        errorMessage =
          'This model appears to be a NeMo streaming transducer (e.g. "streaming fast conformer"). File transcription currently requires a non-streaming NeMo transducer model. Please use a model exported for offline/non-streaming use, or choose another STT model.';
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

  const handlePickBpeVocabFile = async () => {
    try {
      const res = await DocumentPicker.pick({
        allowMultiSelection: false,
        type: ['*/*'],
      });
      const files = normalizePickedFiles(res);
      if (files.length > 0) {
        setBpeVocabFile(files[0] ?? null);
      }
    } catch (err: any) {
      if (
        (DocumentPicker as any).isCancel?.(err) ||
        err?.code === 'DOCUMENT_PICKER_CANCELED' ||
        err?.name === 'DocumentPickerCanceled'
      )
        return;
      console.warn('BPE vocab pick error:', err);
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
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
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
                        isInitialized && styles.modelButtonInitialized,
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
                <Text style={styles.optionsStepLabel}>
                  2. Configure options
                </Text>
                <Text style={styles.optionsStepHint}>
                  Set preferences below before tapping "Apply options & use
                  model".
                </Text>
                <View style={styles.optionsSection}>
                  <TouchableOpacity
                    style={styles.optionsHeader}
                    onPress={() => setOptionsExpanded((prev) => !prev)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.optionsHeaderLeft}>
                      <Ionicons
                        name="settings-outline"
                        size={24}
                        color="#007AFF"
                        style={styles.iconInline}
                      />
                      <Text style={styles.optionsHeaderTitle}>
                        {optionsExpanded ? 'Hide options' : 'Open options'}
                      </Text>
                    </View>
                    <Ionicons
                      name={optionsExpanded ? 'chevron-up' : 'chevron-down'}
                      size={24}
                      color="#007AFF"
                    />
                  </TouchableOpacity>
                  {optionsExpanded && (
                    <View style={styles.optionsContent}>
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
                      {showHotwordsOptions && (
                        <View style={styles.hotwordsSection}>
                          <TouchableOpacity
                            style={styles.hotwordsSectionHeader}
                            onPress={() =>
                              setHotwordsSectionExpanded((e) => !e)
                            }
                            activeOpacity={0.7}
                          >
                            <Text style={styles.hotwordsSectionTitle}>
                              Hotword options (optional)
                            </Text>
                            <Ionicons
                              name={
                                hotwordsSectionExpanded
                                  ? 'chevron-up'
                                  : 'chevron-down'
                              }
                              size={22}
                              color="#8E8E93"
                            />
                          </TouchableOpacity>
                          {hotwordsSectionExpanded && (
                            <View style={styles.hotwordsSectionContent}>
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
                                <Text style={styles.addFilesButtonText}>
                                  Add files
                                </Text>
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
                              <Text style={styles.inputLabel}>
                                Modeling unit (optional)
                              </Text>
                              <View style={styles.optionsRow}>
                                {(
                                  [
                                    ['', 'Default'],
                                    ['cjkchar', 'cjkchar'],
                                    ['bpe', 'bpe'],
                                    ['cjkchar+bpe', 'cjkchar+bpe'],
                                  ] as const
                                ).map(([value, label]) => (
                                  <TouchableOpacity
                                    key={value || 'default'}
                                    style={[
                                      styles.optionsChip,
                                      modelingUnit === value &&
                                        styles.optionsChipActive,
                                    ]}
                                    onPress={() =>
                                      setModelingUnit(
                                        value as
                                          | ''
                                          | 'cjkchar'
                                          | 'bpe'
                                          | 'cjkchar+bpe'
                                      )
                                    }
                                  >
                                    <Text
                                      style={[
                                        styles.optionsChipText,
                                        modelingUnit === value &&
                                          styles.optionsChipTextActive,
                                      ]}
                                    >
                                      {label}
                                    </Text>
                                  </TouchableOpacity>
                                ))}
                              </View>
                              <Text style={styles.inputLabel}>
                                BPE vocab file (optional)
                              </Text>
                              <Text style={styles.inputHint}>
                                For bpe / cjkchar+bpe. Use sentencepiece
                                bpe.vocab, not the hotwords file.
                              </Text>
                              {!bpeVocabFile && (
                                <TouchableOpacity
                                  style={styles.addFilesButton}
                                  onPress={handlePickBpeVocabFile}
                                >
                                  <Ionicons
                                    name="add-circle-outline"
                                    size={20}
                                    color="#007AFF"
                                    style={styles.iconInline}
                                  />
                                  <Text style={styles.addFilesButtonText}>
                                    Select bpe.vocab
                                  </Text>
                                </TouchableOpacity>
                              )}
                              {bpeVocabFile && (
                                <View style={styles.pickedFilesList}>
                                  <View style={styles.pickedFileRow}>
                                    <Text
                                      style={styles.pickedFileName}
                                      numberOfLines={1}
                                      ellipsizeMode="middle"
                                    >
                                      {bpeVocabFile.name}
                                    </Text>
                                    <TouchableOpacity
                                      hitSlop={{
                                        top: 10,
                                        bottom: 10,
                                        left: 10,
                                        right: 10,
                                      }}
                                      onPress={() => setBpeVocabFile(null)}
                                      style={styles.pickedFileRemove}
                                    >
                                      <Ionicons
                                        name="close-circle"
                                        size={22}
                                        color="#8E8E93"
                                      />
                                    </TouchableOpacity>
                                  </View>
                                </View>
                              )}
                            </View>
                          )}
                        </View>
                      )}
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

                      {/* Model-specific options: only for types that have options in this block (whisper, sense_voice, canary, funasr_nano). Transducer options are in "Hotword options" above. */}
                      {effectiveModelTypeForOptions != null &&
                        (effectiveModelTypeForOptions === 'whisper' ||
                          effectiveModelTypeForOptions === 'sense_voice' ||
                          effectiveModelTypeForOptions === 'canary' ||
                          effectiveModelTypeForOptions === 'funasr_nano') && (
                          <View style={styles.modelOptionsSection}>
                            <Text style={styles.subsectionTitle}>
                              {`Model-specific options (${effectiveModelTypeForOptions})`}
                            </Text>

                            {effectiveModelTypeForOptions === 'whisper' && (
                              <>
                                <Text style={styles.inputLabel}>
                                  Language (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.whisper?.language ?? ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      whisper: {
                                        ...prev.whisper,
                                        language: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="e.g. en, de"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>Task</Text>
                                <View style={styles.optionsRow}>
                                  {(['transcribe', 'translate'] as const).map(
                                    (t) => (
                                      <TouchableOpacity
                                        key={t}
                                        style={[
                                          styles.optionsChip,
                                          (sttModelOptions.whisper?.task ??
                                            'transcribe') === t &&
                                            styles.optionsChipActive,
                                        ]}
                                        onPress={() =>
                                          setSttModelOptions((prev) => ({
                                            ...prev,
                                            whisper: {
                                              ...prev.whisper,
                                              task: t,
                                            },
                                          }))
                                        }
                                      >
                                        <Text
                                          style={[
                                            styles.optionsChipText,
                                            (sttModelOptions.whisper?.task ??
                                              'transcribe') === t &&
                                              styles.optionsChipTextActive,
                                          ]}
                                        >
                                          {t}
                                        </Text>
                                      </TouchableOpacity>
                                    )
                                  )}
                                </View>
                                <Text style={styles.inputLabel}>
                                  Tail paddings (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.whisper?.tailPaddings !=
                                    null
                                      ? String(
                                          sttModelOptions.whisper.tailPaddings
                                        )
                                      : ''
                                  }
                                  onChangeText={(v) => {
                                    const n =
                                      v.trim() === ''
                                        ? undefined
                                        : parseInt(v, 10);
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      whisper: {
                                        ...prev.whisper,
                                        tailPaddings:
                                          n !== undefined && !isNaN(n)
                                            ? n
                                            : undefined,
                                      },
                                    }));
                                  }}
                                  keyboardType="numeric"
                                  placeholder="e.g. 1000"
                                  placeholderTextColor="#8E8E93"
                                />
                                <>
                                  <Text style={styles.inputLabel}>
                                    Token timestamps (Android)
                                  </Text>
                                  <View style={styles.optionsRow}>
                                    {[false, true].map((val) => (
                                      <TouchableOpacity
                                        key={String(val)}
                                        style={[
                                          styles.optionsChip,
                                          (sttModelOptions.whisper
                                            ?.enableTokenTimestamps ??
                                            false) === val &&
                                            styles.optionsChipActive,
                                        ]}
                                        onPress={() =>
                                          setSttModelOptions((prev) => ({
                                            ...prev,
                                            whisper: {
                                              ...prev.whisper,
                                              enableTokenTimestamps: val,
                                            },
                                          }))
                                        }
                                      >
                                        <Text
                                          style={[
                                            styles.optionsChipText,
                                            (sttModelOptions.whisper
                                              ?.enableTokenTimestamps ??
                                              false) === val &&
                                              styles.optionsChipTextActive,
                                          ]}
                                        >
                                          {val ? 'On' : 'Off'}
                                        </Text>
                                      </TouchableOpacity>
                                    ))}
                                  </View>
                                  <Text style={styles.inputLabel}>
                                    Segment timestamps (Android)
                                  </Text>
                                  <View style={styles.optionsRow}>
                                    {[false, true].map((val) => (
                                      <TouchableOpacity
                                        key={String(val)}
                                        style={[
                                          styles.optionsChip,
                                          (sttModelOptions.whisper
                                            ?.enableSegmentTimestamps ??
                                            false) === val &&
                                            styles.optionsChipActive,
                                        ]}
                                        onPress={() =>
                                          setSttModelOptions((prev) => ({
                                            ...prev,
                                            whisper: {
                                              ...prev.whisper,
                                              enableSegmentTimestamps: val,
                                            },
                                          }))
                                        }
                                      >
                                        <Text
                                          style={[
                                            styles.optionsChipText,
                                            (sttModelOptions.whisper
                                              ?.enableSegmentTimestamps ??
                                              false) === val &&
                                              styles.optionsChipTextActive,
                                          ]}
                                        >
                                          {val ? 'On' : 'Off'}
                                        </Text>
                                      </TouchableOpacity>
                                    ))}
                                  </View>
                                </>
                              </>
                            )}

                            {effectiveModelTypeForOptions === 'sense_voice' && (
                              <>
                                <Text style={styles.inputLabel}>
                                  Language (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.senseVoice?.language ?? ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      senseVoice: {
                                        ...prev.senseVoice,
                                        language: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="e.g. en"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>Use ITN</Text>
                                <View style={styles.optionsRow}>
                                  {[false, true].map((val) => (
                                    <TouchableOpacity
                                      key={String(val)}
                                      style={[
                                        styles.optionsChip,
                                        (sttModelOptions.senseVoice?.useItn ??
                                          true) === val &&
                                          styles.optionsChipActive,
                                      ]}
                                      onPress={() =>
                                        setSttModelOptions((prev) => ({
                                          ...prev,
                                          senseVoice: {
                                            ...prev.senseVoice,
                                            useItn: val,
                                          },
                                        }))
                                      }
                                    >
                                      <Text
                                        style={[
                                          styles.optionsChipText,
                                          (sttModelOptions.senseVoice?.useItn ??
                                            true) === val &&
                                            styles.optionsChipTextActive,
                                        ]}
                                      >
                                        {val ? 'Yes' : 'No'}
                                      </Text>
                                    </TouchableOpacity>
                                  ))}
                                </View>
                              </>
                            )}

                            {effectiveModelTypeForOptions === 'canary' && (
                              <>
                                <Text style={styles.inputLabel}>
                                  Source language (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={sttModelOptions.canary?.srcLang ?? ''}
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      canary: {
                                        ...prev.canary,
                                        srcLang: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="e.g. en"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>
                                  Target language (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={sttModelOptions.canary?.tgtLang ?? ''}
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      canary: {
                                        ...prev.canary,
                                        tgtLang: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="e.g. en"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>
                                  Use punctuation
                                </Text>
                                <View style={styles.optionsRow}>
                                  {[false, true].map((val) => (
                                    <TouchableOpacity
                                      key={String(val)}
                                      style={[
                                        styles.optionsChip,
                                        (sttModelOptions.canary?.usePnc ??
                                          true) === val &&
                                          styles.optionsChipActive,
                                      ]}
                                      onPress={() =>
                                        setSttModelOptions((prev) => ({
                                          ...prev,
                                          canary: {
                                            ...prev.canary,
                                            usePnc: val,
                                          },
                                        }))
                                      }
                                    >
                                      <Text
                                        style={[
                                          styles.optionsChipText,
                                          (sttModelOptions.canary?.usePnc ??
                                            true) === val &&
                                            styles.optionsChipTextActive,
                                        ]}
                                      >
                                        {val ? 'Yes' : 'No'}
                                      </Text>
                                    </TouchableOpacity>
                                  ))}
                                </View>
                              </>
                            )}

                            {effectiveModelTypeForOptions === 'funasr_nano' && (
                              <>
                                <Text style={styles.inputLabel}>
                                  System prompt (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.funasrNano?.systemPrompt ??
                                    ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      funasrNano: {
                                        ...prev.funasrNano,
                                        systemPrompt: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="You are a helpful assistant."
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>
                                  User prompt (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.funasrNano?.userPrompt ?? ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      funasrNano: {
                                        ...prev.funasrNano,
                                        userPrompt: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="语音转写："
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>
                                  Max new tokens (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.funasrNano?.maxNewTokens !=
                                    null
                                      ? String(
                                          sttModelOptions.funasrNano
                                            .maxNewTokens
                                        )
                                      : ''
                                  }
                                  onChangeText={(v) => {
                                    const n =
                                      v.trim() === ''
                                        ? undefined
                                        : parseInt(v, 10);
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      funasrNano: {
                                        ...prev.funasrNano,
                                        maxNewTokens:
                                          n !== undefined && !isNaN(n) && n > 0
                                            ? n
                                            : undefined,
                                      },
                                    }));
                                  }}
                                  keyboardType="numeric"
                                  placeholder="512"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>
                                  Language (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.funasrNano?.language ?? ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      funasrNano: {
                                        ...prev.funasrNano,
                                        language: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="e.g. en"
                                  placeholderTextColor="#8E8E93"
                                />
                                <Text style={styles.inputLabel}>ITN</Text>
                                <View style={styles.optionsRow}>
                                  {[false, true].map((val) => (
                                    <TouchableOpacity
                                      key={String(val)}
                                      style={[
                                        styles.optionsChip,
                                        (sttModelOptions.funasrNano?.itn ??
                                          true) === val &&
                                          styles.optionsChipActive,
                                      ]}
                                      onPress={() =>
                                        setSttModelOptions((prev) => ({
                                          ...prev,
                                          funasrNano: {
                                            ...prev.funasrNano,
                                            itn: val,
                                          },
                                        }))
                                      }
                                    >
                                      <Text
                                        style={[
                                          styles.optionsChipText,
                                          (sttModelOptions.funasrNano?.itn ??
                                            true) === val &&
                                            styles.optionsChipTextActive,
                                        ]}
                                      >
                                        {val ? 'Yes' : 'No'}
                                      </Text>
                                    </TouchableOpacity>
                                  ))}
                                </View>
                                <Text style={styles.inputLabel}>
                                  Hotwords (optional)
                                </Text>
                                <TextInput
                                  style={styles.parameterInput}
                                  value={
                                    sttModelOptions.funasrNano?.hotwords ?? ''
                                  }
                                  onChangeText={(v) =>
                                    setSttModelOptions((prev) => ({
                                      ...prev,
                                      funasrNano: {
                                        ...prev.funasrNano,
                                        hotwords: v || undefined,
                                      },
                                    }))
                                  }
                                  placeholder="word1 word2"
                                  placeholderTextColor="#8E8E93"
                                />
                              </>
                            )}
                          </View>
                        )}
                    </View>
                  )}
                </View>
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.applyButton,
                    (loading || detectingModelType) && styles.buttonDisabled,
                  ]}
                  onPress={() =>
                    handleInitialize(
                      selectedModelForInit ?? currentModelFolder ?? ''
                    )
                  }
                  disabled={
                    loading ||
                    detectingModelType ||
                    (!selectedModelForInit && !currentModelFolder)
                  }
                >
                  {detectingModelType ? (
                    <View style={styles.applyButtonContent}>
                      <ActivityIndicator
                        size="small"
                        color="#FFFFFF"
                        style={styles.applyButtonSpinner}
                      />
                      <Text style={styles.buttonText}>
                        Detecting model type…
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.buttonText}>
                      Apply options & use model
                    </Text>
                  )}
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

          {detectedModels.length > 1 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>2. Select Model Type</Text>
              <Text style={styles.hint}>
                Multiple model types were detected. Select which one to use for
                transcription.
              </Text>

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
                      {getModelDisplayName(
                        model.modelDir.replace(/^.*[/\\]/, '') || model.modelDir
                      )}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!selectedModelType && (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    Please select a model type above
                  </Text>
                </View>
              )}
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {detectedModels.length > 1
                ? '3. Transcribe Audio'
                : '2. Transcribe Audio'}
            </Text>
            <Text style={styles.hint}>
              Select an audio source and transcribe it using the selected model.
            </Text>

            {!selectedModelType && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  {!currentModelFolder
                    ? 'Please initialize a model directory first'
                    : 'Please select a model type first'}
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
              </>
            )}

            {selectedModelType &&
              transcriptionResult &&
              (audioSourceType === 'example' || audioSourceType === 'own') && (
                <View style={styles.resultSection}>
                  <View style={styles.resultLabelRow}>
                    <Text style={styles.resultLabel}>Transcription:</Text>
                    <View style={styles.resultLabelActions}>
                      <TouchableOpacity
                        style={styles.copyIconButton}
                        onPress={() => {
                          const t = transcriptionResult.text ?? '';
                          if (t) Clipboard.setString(t);
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons
                          name="copy-outline"
                          size={20}
                          color="#2e7d32"
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.copyIconButton}
                        onPress={() => {
                          const t = transcriptionResult.text ?? '';
                          if (t) {
                            Share.share({
                              message: t,
                              title: 'Transcription',
                            });
                          }
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons
                          name="share-outline"
                          size={20}
                          color="#2e7d32"
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <Text style={styles.resultText} selectable>
                    {transcriptionResult.text ?? ''}
                  </Text>
                  {(transcriptionResult.lang ||
                    transcriptionResult.emotion ||
                    transcriptionResult.event) && (
                    <View style={styles.metaRow}>
                      {transcriptionResult.lang ? (
                        <Text style={styles.metaText}>
                          Lang: {transcriptionResult.lang}
                        </Text>
                      ) : null}
                      {transcriptionResult.emotion ? (
                        <Text style={styles.metaText}>
                          Emotion: {transcriptionResult.emotion}
                        </Text>
                      ) : null}
                      {transcriptionResult.event ? (
                        <Text style={styles.metaText}>
                          Event: {transcriptionResult.event}
                        </Text>
                      ) : null}
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.expandHeader}
                    onPress={() => setTokensExpanded((e) => !e)}
                  >
                    <Ionicons
                      name={tokensExpanded ? 'chevron-down' : 'chevron-forward'}
                      size={18}
                      color="#2e7d32"
                    />
                    <Text style={styles.expandHeaderText}>
                      Tokens ({(transcriptionResult.tokens ?? []).length})
                    </Text>
                  </TouchableOpacity>
                  {tokensExpanded && (
                    <View style={styles.expandContent}>
                      <View style={styles.expandActionRow}>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.tokens ?? [];
                            Clipboard.setString(
                              Array.isArray(arr)
                                ? JSON.stringify(arr)
                                : String(arr)
                            );
                          }}
                        >
                          <Ionicons
                            name="copy-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Copy</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.tokens ?? [];
                            const str = Array.isArray(arr)
                              ? JSON.stringify(arr)
                              : String(arr);
                            Share.share({
                              message: str,
                              title: 'Tokens',
                            });
                          }}
                        >
                          <Ionicons
                            name="share-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Share</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.expandListItem}>
                        {(transcriptionResult.tokens ?? []).join(', ')}
                      </Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.expandHeader}
                    onPress={() => setTimestampsExpanded((e) => !e)}
                  >
                    <Ionicons
                      name={
                        timestampsExpanded ? 'chevron-down' : 'chevron-forward'
                      }
                      size={18}
                      color="#2e7d32"
                    />
                    <Text style={styles.expandHeaderText}>
                      Timestamps (
                      {(transcriptionResult.timestamps ?? []).length})
                    </Text>
                  </TouchableOpacity>
                  {timestampsExpanded && (
                    <View style={styles.expandContent}>
                      <View style={styles.expandActionRow}>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.timestamps ?? [];
                            Clipboard.setString(
                              Array.isArray(arr)
                                ? JSON.stringify(arr)
                                : String(arr)
                            );
                          }}
                        >
                          <Ionicons
                            name="copy-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Copy</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.timestamps ?? [];
                            const str = Array.isArray(arr)
                              ? JSON.stringify(arr)
                              : String(arr);
                            Share.share({
                              message: str,
                              title: 'Timestamps',
                            });
                          }}
                        >
                          <Ionicons
                            name="share-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Share</Text>
                        </TouchableOpacity>
                      </View>
                      {(transcriptionResult.timestamps ?? []).length > 0 && (
                        <ScrollView
                          style={styles.expandListWrap}
                          nestedScrollEnabled
                          showsVerticalScrollIndicator
                        >
                          {(transcriptionResult.timestamps ?? []).map(
                            (item, i) => (
                              <Text
                                key={`ts-${i}`}
                                style={styles.expandListItem}
                              >
                                [{String(item)}]
                              </Text>
                            )
                          )}
                        </ScrollView>
                      )}
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.expandHeader}
                    onPress={() => setDurationsExpanded((e) => !e)}
                  >
                    <Ionicons
                      name={
                        durationsExpanded ? 'chevron-down' : 'chevron-forward'
                      }
                      size={18}
                      color="#2e7d32"
                    />
                    <Text style={styles.expandHeaderText}>
                      Durations ({(transcriptionResult.durations ?? []).length})
                    </Text>
                  </TouchableOpacity>
                  {durationsExpanded && (
                    <View style={styles.expandContent}>
                      <View style={styles.expandActionRow}>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.durations ?? [];
                            Clipboard.setString(
                              Array.isArray(arr)
                                ? JSON.stringify(arr)
                                : String(arr)
                            );
                          }}
                        >
                          <Ionicons
                            name="copy-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Copy</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.expandActionBtn}
                          onPress={() => {
                            const arr = transcriptionResult.durations ?? [];
                            const str = Array.isArray(arr)
                              ? JSON.stringify(arr)
                              : String(arr);
                            Share.share({
                              message: str,
                              title: 'Durations',
                            });
                          }}
                        >
                          <Ionicons
                            name="share-outline"
                            size={18}
                            color="#2e7d32"
                            style={styles.expandActionIcon}
                          />
                          <Text style={styles.expandActionLabel}>Share</Text>
                        </TouchableOpacity>
                      </View>
                      {(transcriptionResult.durations ?? []).length > 0 && (
                        <ScrollView
                          style={styles.expandListWrap}
                          nestedScrollEnabled
                          showsVerticalScrollIndicator
                        >
                          {(transcriptionResult.durations ?? []).map(
                            (item, i) => (
                              <Text
                                key={`d-${i}`}
                                style={styles.expandListItem}
                              >
                                [{String(item)}]
                              </Text>
                            )
                          )}
                        </ScrollView>
                      )}
                    </View>
                  )}
                  <View style={styles.resultButtonRow}>
                    <TouchableOpacity
                      style={styles.resultActionButton}
                      onPress={() => {
                        const json = JSON.stringify(
                          transcriptionResult,
                          null,
                          2
                        );
                        Clipboard.setString(json);
                      }}
                    >
                      <Ionicons
                        name="copy-outline"
                        size={18}
                        color="#2e7d32"
                        style={styles.resultActionIcon}
                      />
                      <Text style={styles.resultActionText}>
                        Copy all as JSON
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.resultActionButton}
                      onPress={() => {
                        const json = JSON.stringify(
                          transcriptionResult,
                          null,
                          2
                        );
                        Share.share({
                          message: json,
                          title: 'Export all as JSON',
                        });
                      }}
                    >
                      <Ionicons
                        name="document-text-outline"
                        size={18}
                        color="#2e7d32"
                        style={styles.resultActionIcon}
                      />
                      <Text style={styles.resultActionText}>
                        Export all as JSON
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
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
    backgroundColor: '#FFFFFF',
  },
  body: {
    flex: 1,
  },
  scrollView: {
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
  applyButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  applyButtonSpinner: {
    marginRight: 2,
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
  resultSection: {
    marginTop: 30,
    padding: 20,
    backgroundColor: '#e8f5e9',
    borderRadius: 8,
  },
  resultLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  resultLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
  },
  resultLabelActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  resultText: {
    fontSize: 16,
    color: '#1b5e20',
  },
  copyIconButton: {
    padding: 4,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 8,
    marginBottom: 4,
  },
  metaText: {
    fontSize: 13,
    color: '#2e7d32',
  },
  expandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 6,
  },
  expandHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
  },
  expandContent: {
    marginLeft: 8,
    marginTop: 4,
  },
  expandActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  expandActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  expandActionIcon: {
    marginRight: 4,
  },
  expandActionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
  },
  expandListWrap: {
    height: 200,
    marginLeft: 0,
  },
  expandList: {
    flexGrow: 0,
  },
  expandListItem: {
    fontSize: 13,
    color: '#1b5e20',
    paddingVertical: 2,
  },
  resultButtonRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 12,
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(46, 125, 50, 0.3)',
  },
  resultActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexShrink: 1,
  },
  resultActionIcon: {
    marginRight: 4,
  },
  resultActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2e7d32',
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
  modelButtonInitialized: {
    borderColor: '#34C759',
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
  modelOptionsSection: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#eee',
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
  inputHint: {
    fontSize: 12,
    color: '#6d6d72',
    marginBottom: 8,
  },
  hotwordsSection: {
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#FAFAFA',
  },
  hotwordsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  hotwordsSectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  hotwordsSectionContent: {
    paddingHorizontal: 14,
    paddingTop: 16,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: '#e8e8e8',
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
  optionsStepLabel: {
    marginTop: 20,
    marginBottom: 4,
    fontSize: 17,
    fontWeight: '700',
    color: '#007AFF',
  },
  optionsStepHint: {
    marginBottom: 10,
    fontSize: 13,
    color: '#6d6d72',
    lineHeight: 18,
  },
  optionsSection: {
    marginBottom: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#007AFF',
    backgroundColor: '#F0F7FF',
    overflow: 'hidden',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  optionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: '#E3F2FD',
  },
  optionsHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  optionsHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#007AFF',
    marginLeft: 8,
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
