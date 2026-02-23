import { useState, useEffect, useRef } from 'react';
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
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  getAssetPackPath,
  listAssetModels,
  resolveModelPath,
  listModelsAtPath,
} from 'react-native-sherpa-onnx';
import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';
import {
  createSTT,
  detectSttModel,
  type STTModelType,
  type SttRecognitionResult,
} from 'react-native-sherpa-onnx/stt';
import { getSttCache, setSttCache, clearSttCache } from '../../engineCache';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../../modelConfig';
import { getAudioFilesForModel, type AudioFileInfo } from '../../audioConfig';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { SttEngine } from 'react-native-sherpa-onnx/stt';

const PAD_PACK_NAME = 'sherpa_models';

export default function STTScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
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
  const [errorSource, setErrorSource] = useState<'init' | 'transcribe' | null>(
    null
  );
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

  const sttEngineRef = useRef<SttEngine | null>(null);
  const STT_NUM_THREADS = 2;

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
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
      ];

      setPadModelIds(padFolders);
      if (sttFolders.length > 0) {
        console.log('STTScreen: Found asset models:', sttFolders);
      }
      setAvailableModels(combined);

      if (combined.length === 0) {
        setErrorSource('init');
        setError(
          'No STT models found. Use bundled assets or PAD models. See STT_MODEL_SETUP.md'
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

      const useFilePath = padModelIds.includes(modelFolder);
      const modelPath = useFilePath
        ? padModelIds.includes(modelFolder) && padModelsPath
          ? getFileModelPath(modelFolder, ModelCategory.Stt, padModelsPath)
          : getFileModelPath(modelFolder, ModelCategory.Stt)
        : getAssetModelPath(modelFolder);

      const engine = await createSTT({
        modelPath,
        numThreads: STT_NUM_THREADS,
      });

      const detectResult = await detectSttModel(modelPath);
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

    // If a custom audio file was chosen, prefer it
    if (!selectedAudio && !customAudioPath) {
      setErrorSource('transcribe');
      setError('Please select an audio file (example or local WAV)');
      return;
    }

    setTranscribing(true);
    setError(null);
    setErrorSource(null);
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

      const engine = sttEngineRef.current;
      if (!engine) {
        setErrorSource('transcribe');
        setError('STT engine not initialized');
        return;
      }
      const result = await engine.transcribeFile(pathToTranscribe);
      setTranscriptionResult(result);
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
    setAudioSourceType(null);
    setSelectedAudio(null);
    setCustomAudioPath(null);
    setCustomAudioName(null);
    setTranscriptionResult(null);
    setError(null);
    setErrorSource(null);
  };

  const handlePickLocalFile = async () => {
    setError(null);
    setErrorSource(null);
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
        setErrorSource('transcribe');
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
      setErrorSource('transcribe');
      setError(err instanceof Error ? err.message : String(err));
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

            {error && errorSource === 'transcribe' && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorLabel}>Error:</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
