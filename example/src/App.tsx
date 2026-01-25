import { useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import {
  testSherpaInit,
  autoModelPath,
  resolveModelPath,
} from 'react-native-sherpa-onnx';
import {
  initializeSTT,
  unloadSTT,
  transcribeFile,
} from 'react-native-sherpa-onnx/stt';
import { getModelPath, MODELS, type ModelId } from './modelConfig';
import { getAudioFilesForModel, type AudioFileInfo } from './audioConfig';

export default function App() {
  const [testResult, setTestResult] = useState<string | null>(null);
  const [initResult, setInitResult] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState<ModelId | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<AudioFileInfo | null>(
    null
  );
  const [transcriptionResult, setTranscriptionResult] = useState<string | null>(
    null
  );
  const [transcribing, setTranscribing] = useState(false);

  const handleTest = async () => {
    setLoading(true);
    setError(null);
    setTestResult(null);

    try {
      const result = await testSherpaInit();
      setTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleInitialize = async (modelId: ModelId) => {
    setLoading(true);
    setError(null);
    setInitResult(null);

    try {
      const modelPathConfig = getModelPath(modelId);

      // Unload previous model if any
      if (currentModel) {
        await unloadSTT();
      }

      // Initialize new model
      await initializeSTT({
        modelPath: modelPathConfig,
      });

      const modelName =
        modelId === MODELS.ZIPFORMER_EN
          ? 'English (Zipformer)'
          : modelId === MODELS.PARAFORMER_ZH
          ? 'Chinese (Paraformer)'
          : modelId === MODELS.NEMO_CTC_EN
          ? 'English (NeMo CTC)'
          : modelId === MODELS.WHISPER_EN
          ? 'English (Whisper)'
          : modelId === MODELS.WENET_CTC_ZH_EN_CANTONESE
          ? 'Chinese/English/Cantonese (WeNet CTC)'
          : modelId === MODELS.SENSE_VOICE_ZH_EN_JA_KO_YUE
          ? 'Chinese/English/Japanese/Korean/Yue (SenseVoice)'
          : 'FunASR Nano';

      setCurrentModel(modelId);
      setInitResult(`Initialized: ${modelName}`);
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
    if (!selectedAudio || !currentModel) {
      setError('Please select a model and audio file first');
      return;
    }

    setTranscribing(true);
    setError(null);
    setTranscriptionResult(null);

    try {
      // Resolve audio file path (using auto detection - tries asset first, then file system)
      const audioPathConfig = autoModelPath(selectedAudio.id);
      const resolvedAudioPath = await resolveModelPath(audioPathConfig);

      // Transcribe the audio file
      const result = await transcribeFile(resolvedAudioPath);
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

  // Get available audio files for current model
  const availableAudioFiles = currentModel
    ? getAudioFilesForModel(currentModel)
    : [];

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      style={styles.scrollView}
    >
      <View style={styles.container}>
        <Text style={styles.title}>Sherpa-ONNX Test</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Library Test</Text>
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleTest}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Test Sherpa Init</Text>
            )}
          </TouchableOpacity>

          {testResult && (
            <View style={styles.resultContainer}>
              <Text style={styles.resultLabel}>Result:</Text>
              <Text style={styles.resultText}>{testResult}</Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. Initialize Model</Text>
          <Text style={styles.hint}>
            Select a model to initialize. Models must be provided separately.
          </Text>

          {currentModel && (
            <View style={styles.currentModelContainer}>
              <Text style={styles.currentModelText}>
                Current:{' '}
                {currentModel === MODELS.ZIPFORMER_EN ||
                currentModel === MODELS.NEMO_CTC_EN ||
                currentModel === MODELS.WHISPER_EN
                  ? 'English'
                  : currentModel === MODELS.WENET_CTC_ZH_EN_CANTONESE
                  ? 'Chinese/English/Cantonese'
                  : 'Chinese'}
              </Text>
            </View>
          )}

          <View style={styles.modelButtons}>
            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.ZIPFORMER_EN &&
                  styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.ZIPFORMER_EN)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.ZIPFORMER_EN &&
                    styles.modelButtonTextActive,
                ]}
              >
                English (Zipformer)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.PARAFORMER_ZH &&
                  styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.PARAFORMER_ZH)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.PARAFORMER_ZH &&
                    styles.modelButtonTextActive,
                ]}
              >
                中文 (Paraformer)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.NEMO_CTC_EN && styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.NEMO_CTC_EN)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.NEMO_CTC_EN &&
                    styles.modelButtonTextActive,
                ]}
              >
                English (NeMo CTC)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.WHISPER_EN && styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.WHISPER_EN)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.WHISPER_EN &&
                    styles.modelButtonTextActive,
                ]}
              >
                English (Whisper)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.WENET_CTC_ZH_EN_CANTONESE &&
                  styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.WENET_CTC_ZH_EN_CANTONESE)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.WENET_CTC_ZH_EN_CANTONESE &&
                    styles.modelButtonTextActive,
                ]}
              >
                中英粤 (WeNet CTC)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.SENSE_VOICE_ZH_EN_JA_KO_YUE &&
                  styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() =>
                handleInitialize(MODELS.SENSE_VOICE_ZH_EN_JA_KO_YUE)
              }
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.SENSE_VOICE_ZH_EN_JA_KO_YUE &&
                    styles.modelButtonTextActive,
                ]}
              >
                多语言 (SenseVoice)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modelButton,
                currentModel === MODELS.FUNASR_NANO_INT8 &&
                  styles.modelButtonActive,
                loading && styles.buttonDisabled,
              ]}
              onPress={() => handleInitialize(MODELS.FUNASR_NANO_INT8)}
              disabled={loading}
            >
              <Text
                style={[
                  styles.modelButtonText,
                  currentModel === MODELS.FUNASR_NANO_INT8 &&
                    styles.modelButtonTextActive,
                ]}
              >
                FunASR Nano
              </Text>
            </TouchableOpacity>
          </View>

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
          <Text style={styles.sectionTitle}>3. Transcribe Audio</Text>
          <Text style={styles.hint}>
            Select an audio file and transcribe it using the initialized model.
          </Text>

          {!currentModel && (
            <View style={styles.warningContainer}>
              <Text style={styles.warningText}>
                Please initialize a model first
              </Text>
            </View>
          )}

          {currentModel && availableAudioFiles.length > 0 && (
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

              {transcriptionResult && (
                <View style={styles.resultContainer}>
                  <Text style={styles.resultLabel}>Transcription:</Text>
                  <Text style={styles.resultText}>{transcriptionResult}</Text>
                </View>
              )}
            </>
          )}

          {currentModel && availableAudioFiles.length === 0 && (
            <View style={styles.warningContainer}>
              <Text style={styles.warningText}>
                No audio files available for this model
              </Text>
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContent: {
    flexGrow: 1,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: 20,
    paddingTop: 60,
  },
  section: {
    width: '100%',
    maxWidth: 400,
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    color: '#333',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 8,
    minWidth: 200,
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
    width: '100%',
    maxWidth: 400,
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
    width: '100%',
    maxWidth: 400,
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
  modelButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8, // Reduced gap to ensure 3 buttons fit per row
    marginTop: 10,
    justifyContent: 'flex-start',
  },
  modelButton: {
    width: '29%', // 3 buttons per row: (29% * 3) = 87%, leaving 13% for gaps (2 × 8px ≈ 16px on 400px container)
    flexGrow: 0,
    flexShrink: 1,
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    alignItems: 'center',
    minWidth: 100, // Minimum width to prevent buttons from being too small
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
});
