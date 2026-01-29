import { useState, useEffect } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from '@react-native-documents/picker';
import {
  autoModelPath,
  resolveModelPath,
  listAssetModels,
} from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  unloadSTT,
  transcribeFile,
} from 'react-native-sherpa-onnx/stt';
import { getModelDisplayName } from '../../modelConfig';
import { getAudioFilesForModel, type AudioFileInfo } from '../../audioConfig';

export default function STTScreen() {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModelFolder, setCurrentModelFolder] = useState<string | null>(
    null
  );
  const [detectedModels, setDetectedModels] = useState<
    Array<{ type: string; modelDir: string }>
  >([]);
  const [selectedModelType, setSelectedModelType] = useState<string | null>(
    null
  );
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

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
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
      const models = await listAssetModels();
      const sttFolders = models
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const ttsFolders = models
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const unknownFolders = models.filter((model) => model.hint === 'unknown');

      console.log('STTScreen: Found model folders:', models);
      setAvailableModels(sttFolders);
      if (sttFolders.length === 0) {
        setError(
          ttsFolders.length > 0
            ? 'No STT models found. Only TTS models detected in assets/models/. See STT_MODEL_SETUP.md'
            : unknownFolders.length > 0
            ? 'No STT models found. Some models have unknown type hints. See STT_MODEL_SETUP.md'
            : 'No STT models found in assets. See STT_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('STTScreen: Failed to list models:', err);
      setError('Failed to list available models');
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

      // Resolve model path
      const modelPath = await resolveModelPath({
        type: 'asset',
        path: `models/${modelFolder}`,
      });

      // Initialize new model
      const result = await initializeSTT({
        modelPath: { type: 'file', path: modelPath },
      });

      if (result.success && result.detectedModels.length > 0) {
        setDetectedModels(result.detectedModels);
        setCurrentModelFolder(modelFolder);

        const detectedTypes = result.detectedModels
          .map((m) => m.type)
          .join(', ');
        setInitResult(
          `Initialized: ${getModelDisplayName(
            modelFolder
          )}\nDetected models: ${detectedTypes}`
        );

        // Auto-select first detected model
        if (result.detectedModels.length === 1 && result.detectedModels[0]) {
          setSelectedModelType(result.detectedModels[0].type);
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
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Initialize Model</Text>
          <Text style={styles.hint}>
            Select a model to initialize. Available models are discovered
            automatically from your assets folder.
          </Text>

          {currentModelFolder && (
            <View style={styles.currentModelContainer}>
              <Text style={styles.currentModelText}>
                Current: {getModelDisplayName(currentModelFolder)}
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
                No models found in assets/models/ folder. Please add STT models
                first. See STT_MODEL_SETUP.md for details.
              </Text>
            </View>
          ) : (
            <View style={styles.modelButtons}>
              {availableModels.map((modelFolder) => (
                <TouchableOpacity
                  key={modelFolder}
                  style={[
                    styles.modelButton,
                    currentModelFolder === modelFolder &&
                      styles.modelButtonActive,
                    loading && styles.buttonDisabled,
                  ]}
                  onPress={() => handleInitialize(modelFolder)}
                  disabled={loading}
                >
                  <Text
                    style={[
                      styles.modelButtonText,
                      currentModelFolder === modelFolder &&
                        styles.modelButtonTextActive,
                    ]}
                  >
                    {getModelDisplayName(modelFolder)}
                  </Text>
                  <Text style={styles.modelFolderText}>{modelFolder}</Text>
                </TouchableOpacity>
              ))}
            </View>
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
                  <Text style={styles.detectedModelPath}>{model.modelDir}</Text>
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
                  style={[styles.sourceChoiceButton, styles.flex1, styles.mr12]}
                  onPress={() => setAudioSourceType('example')}
                >
                  <Text style={styles.sourceChoiceButtonText}>
                    📁 Example Audio
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sourceChoiceButton, styles.flex1]}
                  onPress={() => setAudioSourceType('own')}
                >
                  <Text style={styles.sourceChoiceButtonText}>
                    🎵 Select Your Own Audio
                  </Text>
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
                    <Text style={styles.resultText}>{transcriptionResult}</Text>
                  </View>
                )}
              </>
            )}

          {selectedModelType && audioSourceType === 'own' && (
            <>
              <Text style={styles.subsectionTitle}>Select Local WAV File:</Text>
              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handlePickLocalFile}
                disabled={loading}
              >
                <Text style={styles.buttonText}>📂 Choose Local WAV</Text>
              </TouchableOpacity>

              {customAudioName && (
                <View style={styles.selectedFileContainer}>
                  <Text style={styles.selectedFileLabel}>Selected file:</Text>
                  <Text style={styles.selectedFileName}>{customAudioName}</Text>

                  <TouchableOpacity
                    style={[styles.playButton]}
                    onPress={handlePlayAudio}
                  >
                    <Text style={styles.playButtonText}>▶️ Play Audio</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 30,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 10,
  },
  hint: {
    fontSize: 12,
    color: '#666',
    marginBottom: 15,
    fontStyle: 'italic',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
    justifyContent: 'flex-start',
  },
  modelButton: {
    width: '29%',
    flexGrow: 0,
    flexShrink: 1,
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    alignItems: 'center',
    minWidth: 100,
  },
  modelButtonActive: {
    backgroundColor: '#e8f5e9',
    borderColor: '#4caf50',
  },
  modelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  modelButtonTextActive: {
    color: '#2e7d32',
  },
  modelFolderText: {
    fontSize: 10,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
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
});
