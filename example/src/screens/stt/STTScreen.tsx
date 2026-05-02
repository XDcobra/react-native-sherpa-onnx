import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
  Share,
} from 'react-native';
import { styles } from './STTScreen.styles';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  listDownloadedModels,
  ModelCategory,
  onModelsListUpdated,
} from 'react-native-sherpa-onnx/download';
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';
import {
  createSTT,
  detectSttModel,
  type STTModelType,
} from 'react-native-sherpa-onnx/stt';
import type { SttEngine } from 'react-native-sherpa-onnx/stt';
import { getSttCache, setSttCache, clearSttCache } from '../../engineCache';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../../modelConfig';
import { getAudioFilesForModel } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineTextBuffer,
  getPipelineTextBufferInfo,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTokensSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferDurationsSlice,
  getOfflineTextBufferLang,
  getOfflineTextBufferEmotion,
  getOfflineTextBufferEvent,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type { OfflineTextBufferInfo } from 'react-native-sherpa-onnx/textbuffer';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';
import {
  OfflineAudioBufferWidget,
  type OfflineAudioBufferInfo,
} from '../../components/OfflineAudioBufferWidget';
import {
  SegmentationPolicyControls,
  buildSegmentationOption,
  type SegmentationControlConfig,
} from '../../components/SegmentationPolicyControls';

const PAD_PACK_NAME = 'sherpa_models';

type SttTranscriptionResult = {
  text: string;
  tokens: string[];
  timestamps: number[];
  lang: string;
  emotion: string;
  event: string;
  durations: number[];
  bufferId?: string;
};

type SttOfflineTextBufferState = SttTranscriptionResult & {
  bufferId: string;
  createdAt: number;
};

let gSttOfflineInputBuffer: OfflineAudioBufferInfo | null = null;
let gSttOfflineTextBuffers: SttOfflineTextBufferState[] = [];

export default function STTScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [padModelIds, setPadModelIds] = useState<string[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
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
  const [errorSource, setErrorSource] = useState<'init' | 'transcribe' | null>(
    null
  );
  const [transcriptionResult, setTranscriptionResult] =
    useState<SttTranscriptionResult | null>(null);
  const [offlineTextBuffers, setOfflineTextBuffers] = useState<
    SttOfflineTextBufferState[]
  >(gSttOfflineTextBuffers);
  const [tokensExpanded, setTokensExpanded] = useState(false);
  const [timestampsExpanded, setTimestampsExpanded] = useState(false);
  const [durationsExpanded, setDurationsExpanded] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [offlineInputBuffer, setOfflineInputBuffer] =
    useState<OfflineAudioBufferInfo | null>(gSttOfflineInputBuffer);
  const [segConfig, setSegConfig] = useState<SegmentationControlConfig>({
    mode: 'off',
  });

  const sttEngineRef = useRef<SttEngine | null>(null);
  const STT_NUM_THREADS = 2;

  const availableAudioFiles = useMemo(
    () => (currentModelFolder ? getAudioFilesForModel(currentModelFolder) : []),
    [currentModelFolder]
  );

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  useEffect(() => {
    const unsubscribe = onModelsListUpdated((category) => {
      if (category !== ModelCategory.Stt) return;
      loadAvailableModels().catch(() => {
        // ignore refresh errors
      });
    });
    return unsubscribe;
  }, []);

  // Restore persisted instance state when entering the screen (no cleanup on unmount)
  useEffect(() => {
    const cached = getSttCache();
    if (cached.engine != null && cached.modelFolder != null) {
      sttEngineRef.current = cached.engine;
      setCurrentModelFolder(cached.modelFolder);
      setSelectedModelForInit(cached.modelFolder);
      setDetectedModels(cached.detectedModels);
      setSelectedModelType(cached.selectedModelType);
      setInitResult(
        `Initialized: ${getModelDisplayName(
          cached.modelFolder
        )}\nDetected models: ${cached.detectedModels
          .map((m) => m.type)
          .join(', ')}`
      );
    }
  }, []);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    setErrorSource(null);
    try {
      const assetModels = await listAssetModels();
      const sttFolders = assetModels
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const downloadedModels = await listDownloadedModels(ModelCategory.Stt);
      const downloadedFolders = downloadedModels.map((model) => model.id);

      // PAD (Play Asset Delivery) or filesystem models: prefer real PAD path, fallback to DocumentDirectoryPath/models
      let padFolders: string[] = [];
      let resolvedPadPath: string | null = null;
      try {
        const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
        const fallbackPath = `${DocumentDirectoryPath}/models`;
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

      // Merge: PAD folders, then bundled asset folders (no duplicates)
      const combined = [
        ...padFolders,
        ...sttFolders.filter((f) => !padFolders.includes(f)),
        ...downloadedFolders.filter(
          (f) => !padFolders.includes(f) && !sttFolders.includes(f)
        ),
      ];

      setPadModelIds(padFolders);
      setDownloadedModelIds(downloadedFolders);
      if (sttFolders.length > 0) {
        console.log('STTScreen: Found asset models:', sttFolders);
      }
      setAvailableModels(combined);

      if (combined.length === 0) {
        setErrorSource('init');
        setError(
          'No STT models found. Use bundled assets, downloaded models, or PAD models. See STT_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('STTScreen: Failed to load models:', err);
      setErrorSource('init');
      setError('Failed to load available models');
      setAvailableModels([]);
    } finally {
      setLoadingModels(false);
    }
  };

  const resolveSttModelPath = (modelFolder: string) => {
    if (padModelIds.includes(modelFolder)) {
      return padModelsPath
        ? getFileModelPath(modelFolder, ModelCategory.Stt, padModelsPath)
        : getFileModelPath(modelFolder, ModelCategory.Stt);
    }
    if (downloadedModelIds.includes(modelFolder)) {
      return getFileModelPath(modelFolder, ModelCategory.Stt);
    }
    return getAssetModelPath(modelFolder);
  };

  const appendOfflineTextBuffer = useCallback(
    (result: SttOfflineTextBufferState) => {
      setOfflineTextBuffers((prev) => {
        const next = [
          ...prev.filter((item) => item.bufferId !== result.bufferId),
          result,
        ];
        gSttOfflineTextBuffers = next;
        return next;
      });
    },
    []
  );

  const removeOfflineTextBuffer = useCallback(async (bufferId: string) => {
    await releasePipelineTextBuffer(bufferId).catch(() => {});
    let nextBuffers: SttOfflineTextBufferState[] = [];
    setOfflineTextBuffers((prev) => {
      nextBuffers = prev.filter((item) => item.bufferId !== bufferId);
      gSttOfflineTextBuffers = nextBuffers;
      return nextBuffers;
    });
    setTranscriptionResult((prev) => {
      if (prev?.bufferId !== bufferId) return prev;
      if (nextBuffers.length === 0) return null;
      const latest = nextBuffers[nextBuffers.length - 1];
      return latest ?? null;
    });
  }, []);

  const handleInitialize = async (modelFolder: string) => {
    setLoading(true);
    setError(null);
    setErrorSource(null);
    setInitResult(null);
    setDetectedModels([]);
    setSelectedModelType(null);

    try {
      // Release previous engine if switching to another model
      const previous = sttEngineRef.current;
      if (previous) {
        await previous.destroy();
        sttEngineRef.current = null;
        clearSttCache();
      }

      const modelPath = resolveSttModelPath(modelFolder);

      const engine = await createSTT({
        modelPath,
        numThreads: STT_NUM_THREADS,
      });

      const detectResult = await detectSttModel(
        await toDetectSource(modelPath)
      );
      if (!detectResult.success || !detectResult.detectedModels?.length) {
        await engine.destroy();
        setErrorSource('init');
        setError('No models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
        return;
      }

      const normalizedDetected = detectResult.detectedModels.map((model) => ({
        ...model,
        type: model.type as STTModelType,
      }));
      const loadedType =
        (detectResult.modelType as STTModelType) ?? normalizedDetected[0]?.type;

      sttEngineRef.current = engine;
      setDetectedModels(normalizedDetected);
      setCurrentModelFolder(modelFolder);
      setSelectedModelForInit(modelFolder);
      if (loadedType) {
        setSelectedModelType(loadedType);
      } else if (normalizedDetected.length === 1 && normalizedDetected[0]) {
        setSelectedModelType(normalizedDetected[0].type);
      }

      const detectedTypes = normalizedDetected.map((m) => m.type).join(', ');
      setInitResult(
        `Initialized: ${getModelDisplayName(
          modelFolder
        )}\nDetected models: ${detectedTypes}`
      );

      setSttCache(
        engine,
        modelFolder,
        normalizedDetected,
        loadedType ?? normalizedDetected[0]?.type ?? null
      );

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

      setErrorSource('init');
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
      setErrorSource('transcribe');
      setError('Please select a model first');
      return;
    }

    if (!offlineInputBuffer) {
      setErrorSource('transcribe');
      setError(
        'Please select an audio source and create an OfflineAudioBuffer first'
      );
      return;
    }

    setTranscribing(true);
    setError(null);
    setErrorSource(null);
    setTranscriptionResult(null);

    try {
      const engine = sttEngineRef.current;
      if (!engine) {
        setErrorSource('transcribe');
        setError('STT engine not initialized');
        return;
      }

      const textRef = await createEmptyOfflineTextBuffer();
      const textBufferId = textRef.bufferId;
      let keepTextBuffer = false;
      try {
        const segOption = buildSegmentationOption(segConfig);
        await engine.transcribe(offlineInputBuffer.bufferId as any, textRef, {
          segmentation: segOption,
        });

        const rawInfo = await getPipelineTextBufferInfo(textBufferId);
        const info = rawInfo as OfflineTextBufferInfo;
        const [text, tokens, timestamps, durations, lang, emotion, event] =
          await Promise.all([
            info.utf16Length > 0
              ? getOfflineTextBufferTextSlice(textBufferId, 0, info.utf16Length)
              : Promise.resolve(''),
            info.tokenCount > 0
              ? getOfflineTextBufferTokensSlice(
                  textBufferId,
                  0,
                  info.tokenCount
                )
              : Promise.resolve([]),
            info.timestampCount > 0
              ? getOfflineTextBufferTimestampsSlice(
                  textBufferId,
                  0,
                  info.timestampCount
                )
              : Promise.resolve([]),
            info.durationCount > 0
              ? getOfflineTextBufferDurationsSlice(
                  textBufferId,
                  0,
                  info.durationCount
                )
              : Promise.resolve([]),
            info.hasLang
              ? getOfflineTextBufferLang(textBufferId)
              : Promise.resolve(''),
            info.hasEmotion
              ? getOfflineTextBufferEmotion(textBufferId)
              : Promise.resolve(''),
            info.hasEvent
              ? getOfflineTextBufferEvent(textBufferId)
              : Promise.resolve(''),
          ]);

        const nextResult: SttOfflineTextBufferState = {
          text,
          tokens,
          timestamps,
          durations,
          lang,
          emotion,
          event,
          bufferId: textBufferId,
          createdAt: Date.now(),
        };
        setTranscriptionResult(nextResult);
        appendOfflineTextBuffer(nextResult);
        keepTextBuffer = true;
      } finally {
        if (!keepTextBuffer) {
          await releasePipelineTextBuffer(textBufferId).catch(() => {});
        }
      }
    } catch (err) {
      const msg =
        (err instanceof Error ? err.message : (err as any)?.message) ?? '';
      if (msg.includes('cache_last_time')) {
        const friendly =
          'This model appears to be a NeMo streaming transducer (e.g. "streaming fast conformer"). File transcription currently requires a non-streaming NeMo transducer model. Please use a model exported for offline/non-streaming use, or choose another STT model.';
        Alert.alert('Transcription not supported', friendly);
        setErrorSource('transcribe');
        setError(friendly);
        return;
      }

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

      setErrorSource('transcribe');
      setError(errorMessage);
    } finally {
      setTranscribing(false);
    }
  };

  const handleFree = async () => {
    const engine = sttEngineRef.current;
    if (!engine) return;
    try {
      await engine.destroy();
    } catch (err) {
      console.error('STTScreen: Failed to destroy STT:', err);
    }
    sttEngineRef.current = null;
    clearSttCache();
    setCurrentModelFolder(null);
    setSelectedModelForInit(null);
    setDetectedModels([]);
    setSelectedModelType(null);
    setInitResult(null);
    const prevBuf = gSttOfflineInputBuffer;
    gSttOfflineInputBuffer = null;
    setOfflineInputBuffer(null);
    if (prevBuf?.bufferId) {
      await releasePipelineAudioBuffer(prevBuf.bufferId).catch(() => {});
    }
    setTranscriptionResult(null);
    const textBuffersToRelease = gSttOfflineTextBuffers;
    gSttOfflineTextBuffers = [];
    setOfflineTextBuffers([]);
    for (const item of textBuffersToRelease) {
      await releasePipelineTextBuffer(item.bufferId).catch(() => {});
    }
    setError(null);
    setErrorSource(null);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.body}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          style={styles.scrollView}
          keyboardShouldPersistTaps="handled"
        >
          {currentModelFolder != null && (
            <TouchableOpacity
              style={styles.freeButton}
              onPress={handleFree}
              disabled={loading}
            >
              <Text style={styles.freeButtonText}>Release model</Text>
            </TouchableOpacity>
          )}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>1. Initialize Model</Text>
            <Text style={styles.hint}>
              Select a model, then tap "Use model".
            </Text>

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
                  No models found. Please add STT models as bundled assets,
                  downloaded models, or PAD models. See STT_MODEL_SETUP.md for
                  details.
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

            <>
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
                {loading ? (
                  <View style={styles.applyButtonContent}>
                    <ActivityIndicator
                      size="small"
                      color="#FFFFFF"
                      style={styles.applyButtonSpinner}
                    />
                    <Text style={styles.buttonText}>Initializing…</Text>
                  </View>
                ) : (
                  <Text style={styles.buttonText}>Use model</Text>
                )}
              </TouchableOpacity>
            </>

            {initResult && !(error && errorSource === 'init') && (
              <View style={styles.resultContainer}>
                <Text style={styles.resultLabel}>Result:</Text>
                <Text style={styles.resultText}>{initResult}</Text>
              </View>
            )}

            {error && errorSource === 'init' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>

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
              Select an audio source, create an OfflineAudioBuffer once, and
              transcribe it using the selected model.
            </Text>
            <Text style={styles.hint}>
              SDK note: remember to release pipeline buffers when they are no
              longer needed to avoid memory leaks.
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

            {selectedModelType && (
              <OfflineAudioBufferWidget
                audioFiles={availableAudioFiles}
                disabled={transcribing || loading}
                onBufferReady={(info) => {
                  gSttOfflineInputBuffer = info;
                  setOfflineInputBuffer(info);
                  setTranscriptionResult(null);
                  setError(null);
                  setErrorSource(null);
                }}
                onBufferReleased={() => {
                  gSttOfflineInputBuffer = null;
                  setOfflineInputBuffer(null);
                }}
              />
            )}

            {selectedModelType && offlineInputBuffer && (
              <>
                <SegmentationPolicyControls
                  variant="speech-offline"
                  value={segConfig}
                  onChange={setSegConfig}
                  disabled={transcribing || loading}
                />
                <TouchableOpacity
                  style={[
                    styles.button,
                    styles.mt12,
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
              </>
            )}

            {selectedModelType &&
              (transcriptionResult != null ||
                offlineTextBuffers.length > 0) && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>
                    {detectedModels.length > 1 ? '4. Result' : '3. Result'}
                  </Text>
                  <Text style={styles.hint}>
                    Transcription output is stored in OfflineTextBuffers. Remove
                    buffers you no longer need to release memory.
                  </Text>
                  <View style={styles.resultSection}>
                    {transcriptionResult ? (
                      <>
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
                            {transcriptionResult.bufferId ? (
                              <TouchableOpacity
                                style={styles.copyIconButton}
                                onPress={() => {
                                  removeOfflineTextBuffer(
                                    transcriptionResult.bufferId as string
                                  ).catch(() => {});
                                }}
                                hitSlop={{
                                  top: 8,
                                  bottom: 8,
                                  left: 8,
                                  right: 8,
                                }}
                              >
                                <Ionicons
                                  name="trash-outline"
                                  size={20}
                                  color="#b71c1c"
                                />
                              </TouchableOpacity>
                            ) : null}
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
                            name={
                              tokensExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
                            }
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
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
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
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
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
                              timestampsExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
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
                                  const arr =
                                    transcriptionResult.timestamps ?? [];
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
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.timestamps ?? [];
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
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
                              </TouchableOpacity>
                            </View>
                            {(transcriptionResult.timestamps ?? []).length >
                              0 && (
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
                              durationsExpanded
                                ? 'chevron-down'
                                : 'chevron-forward'
                            }
                            size={18}
                            color="#2e7d32"
                          />
                          <Text style={styles.expandHeaderText}>
                            Durations (
                            {(transcriptionResult.durations ?? []).length})
                          </Text>
                        </TouchableOpacity>
                        {durationsExpanded && (
                          <View style={styles.expandContent}>
                            <View style={styles.expandActionRow}>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.durations ?? [];
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
                                <Text style={styles.expandActionLabel}>
                                  Copy
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.expandActionBtn}
                                onPress={() => {
                                  const arr =
                                    transcriptionResult.durations ?? [];
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
                                <Text style={styles.expandActionLabel}>
                                  Share
                                </Text>
                              </TouchableOpacity>
                            </View>
                            {(transcriptionResult.durations ?? []).length >
                              0 && (
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
                      </>
                    ) : (
                      <Text style={styles.liveResultPlaceholder}>
                        No active transcription selected.
                      </Text>
                    )}
                  </View>

                  {offlineTextBuffers.length > 0 && (
                    <View style={styles.textBufferList}>
                      <Text style={styles.textBufferListTitle}>
                        Active OfflineTextBuffer
                      </Text>
                      {offlineTextBuffers.map((item) => (
                        <View key={item.bufferId} style={styles.textBufferItem}>
                          <View style={styles.textBufferItemHeader}>
                            <TouchableOpacity
                              style={styles.flex1}
                              onPress={() => setTranscriptionResult(item)}
                            >
                              <Text style={styles.textBufferItemLabel}>
                                {item.text?.trim()
                                  ? item.text.trim().slice(0, 64)
                                  : 'Empty transcription'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.copyIconButton}
                              onPress={() => {
                                removeOfflineTextBuffer(item.bufferId).catch(
                                  () => {}
                                );
                              }}
                              hitSlop={{
                                top: 8,
                                bottom: 8,
                                left: 8,
                                right: 8,
                              }}
                            >
                              <Ionicons
                                name="trash-outline"
                                size={18}
                                color="#b71c1c"
                              />
                            </TouchableOpacity>
                          </View>
                          <Text style={styles.bufferIdText} selectable>
                            {item.bufferId}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}

            {error && errorSource === 'transcribe' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
      <ScreenIntroModal screenId="STT" />
    </SafeAreaView>
  );
}
