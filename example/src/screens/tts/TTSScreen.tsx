import { useState, useEffect } from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  initializeTTS,
  generateSpeech,
  unloadTTS,
  getModelInfo,
} from 'react-native-sherpa-onnx/tts';
import { listAssetModels, resolveModelPath } from 'react-native-sherpa-onnx';
import { getModelDisplayName } from '../../modelConfig';

export default function TTSScreen() {
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
  const [inputText, setInputText] = useState<string>('Hello, world!');
  const [speakerId, setSpeakerId] = useState<string>('0');
  const [speed, setSpeed] = useState<string>('1.0');
  const [generatedAudio, setGeneratedAudio] = useState<{
    samples: number[];
    sampleRate: number;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modelInfo, setModelInfo] = useState<{
    sampleRate: number;
    numSpeakers: number;
  } | null>(null);

  // Load available models on mount
  useEffect(() => {
    loadAvailableModels();
  }, []);

  // Cleanup: Release TTS resources when leaving the screen
  useEffect(() => {
    return () => {
      if (currentModelFolder !== null) {
        console.log('TTSScreen: Cleaning up TTS resources');
        unloadTTS().catch((err) => {
          console.error('TTSScreen: Failed to unload TTS:', err);
        });
      }
    };
  }, [currentModelFolder]);

  const loadAvailableModels = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const models = await listAssetModels();
      const ttsFolders = models
        .filter((model) => model.hint === 'tts')
        .map((model) => model.folder);
      const sttFolders = models
        .filter((model) => model.hint === 'stt')
        .map((model) => model.folder);
      const unknownFolders = models.filter((model) => model.hint === 'unknown');

      console.log('TTSScreen: Found model folders:', models);
      setAvailableModels(ttsFolders);
      if (ttsFolders.length === 0) {
        setError(
          sttFolders.length > 0
            ? 'No TTS models found. Only STT models detected in assets/models/. See TTS_MODEL_SETUP.md'
            : unknownFolders.length > 0
            ? 'No TTS models found. Some models have unknown type hints. See TTS_MODEL_SETUP.md'
            : 'No TTS models found in assets. See TTS_MODEL_SETUP.md'
        );
      }
    } catch (err) {
      console.error('TTSScreen: Failed to list models:', err);
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
    setModelInfo(null);

    try {
      // Unload previous model if any
      if (currentModelFolder) {
        await unloadTTS();
      }

      // Resolve model path
      const modelPath = await resolveModelPath({
        type: 'asset',
        path: `models/${modelFolder}`,
      });

      console.log('TTSScreen: Resolved model path:', modelPath);

      // Initialize new model
      const result = await initializeTTS({
        modelPath,
        numThreads: 2,
        debug: false,
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

        // Get model info
        try {
          const info = await getModelInfo();
          setModelInfo(info);
        } catch (infoErr) {
          console.warn('Failed to get model info:', infoErr);
        }
      } else {
        setError('No models detected in the directory');
        setInitResult('Initialization failed: No compatible models found');
      }

      setGeneratedAudio(null);
    } catch (err) {
      console.error('TTS Initialization error:', err);

      let errorMessage = 'Unknown error';
      if (err instanceof Error) {
        errorMessage = err.message;
        if ('code' in err) {
          errorMessage = `[${err.code}] ${errorMessage}`;
        }
        if (err.stack) {
          console.error('Stack trace:', err.stack);
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
      setInitResult(
        `Initialization failed: ${errorMessage}\n\nNote: TTS models must be provided separately. See TTS_MODEL_SETUP.md for details.`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!currentModelFolder) {
      setError('Please initialize a model first');
      return;
    }

    if (!selectedModelType) {
      setError('Please select a model type first');
      return;
    }

    if (!inputText.trim()) {
      setError('Please enter text to synthesize');
      return;
    }

    setGenerating(true);
    setError(null);
    setGeneratedAudio(null);

    try {
      const sid = parseInt(speakerId, 10);
      const speedValue = parseFloat(speed);

      if (isNaN(sid) || sid < 0) {
        throw new Error('Invalid speaker ID');
      }

      if (isNaN(speedValue) || speedValue <= 0) {
        throw new Error('Invalid speed value');
      }

      const result = await generateSpeech(inputText, {
        sid,
        speed: speedValue,
      });

      setGeneratedAudio(result);
      Alert.alert(
        'Success',
        `Generated ${result.samples.length} samples at ${result.sampleRate} Hz`
      );
    } catch (err) {
      console.error('TTS Generation error:', err);

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
      setGenerating(false);
    }
  };

  const handleCleanup = async () => {
    try {
      await unloadTTS();
      setCurrentModelFolder(null);
      setInitResult(null);
      setDetectedModels([]);
      setSelectedModelType(null);
      setModelInfo(null);
      setGeneratedAudio(null);
      setError(null);
      Alert.alert('Success', 'TTS resources released');
    } catch (err) {
      console.error('Cleanup error:', err);
      Alert.alert('Error', 'Failed to release TTS resources');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.icon}>🔊</Text>
          <Text style={styles.title}>Text-to-Speech Demo</Text>
          <Text style={styles.subtitle}>
            Generate speech from text using offline TTS models
          </Text>
        </View>

        {/* Section 1: Initialize Model */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Initialize TTS Model</Text>
          <Text style={styles.sectionDescription}>
            Select a TTS model to load:
          </Text>

          {loadingModels ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#007AFF" />
              <Text style={styles.loadingText}>Loading models...</Text>
            </View>
          ) : availableModels.length === 0 ? (
            <View style={styles.resultContainer}>
              <Text style={styles.errorText}>
                No TTS models found. See TTS_MODEL_SETUP.md
              </Text>
            </View>
          ) : (
            <View style={styles.buttonGroup}>
              {availableModels.map((modelFolder) => (
                <TouchableOpacity
                  key={modelFolder}
                  style={[
                    styles.modelButton,
                    currentModelFolder === modelFolder &&
                      styles.modelButtonActive,
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
                  <Text style={styles.modelButtonSubtext}>{modelFolder}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {loading && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#007AFF" />
              <Text style={styles.loadingText}>Initializing model...</Text>
            </View>
          )}

          {initResult && (
            <View style={styles.resultContainer}>
              <Text style={styles.resultText}>{initResult}</Text>
            </View>
          )}
        </View>

        {/* Section 2: Select Model Type */}
        {detectedModels.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>2. Select Model Type</Text>
            {detectedModels.length > 1 ? (
              <>
                <Text style={styles.sectionDescription}>
                  Multiple model types detected. Select one:
                </Text>
                <View style={styles.detectedModelsContainer}>
                  {detectedModels.map((model) => (
                    <TouchableOpacity
                      key={model.type}
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
                        {model.type}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : (
              <Text style={styles.autoSelectedText}>
                ✓ Auto-selected: {selectedModelType}
              </Text>
            )}
          </View>
        )}

        {/* Section 3: Model Info */}
        {modelInfo && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Model Information</Text>
            <View style={styles.infoContainer}>
              <Text style={styles.infoText}>
                Sample Rate: {modelInfo.sampleRate} Hz
              </Text>
              <Text style={styles.infoText}>
                Speakers: {modelInfo.numSpeakers}
              </Text>
            </View>
          </View>
        )}

        {/* Section 4: Generate Speech */}
        {selectedModelType && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>3. Generate Speech</Text>

            <Text style={styles.inputLabel}>Text to Synthesize:</Text>
            <TextInput
              style={styles.textInput}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Enter text to synthesize..."
              multiline
              numberOfLines={3}
            />

            <View style={styles.parameterRow}>
              <View style={styles.parameterColumn}>
                <Text style={styles.inputLabel}>Speaker ID:</Text>
                <TextInput
                  style={styles.parameterInput}
                  value={speakerId}
                  onChangeText={setSpeakerId}
                  keyboardType="numeric"
                  placeholder="0"
                />
              </View>

              <View style={styles.parameterColumn}>
                <Text style={styles.inputLabel}>Speed:</Text>
                <TextInput
                  style={styles.parameterInput}
                  value={speed}
                  onChangeText={setSpeed}
                  keyboardType="decimal-pad"
                  placeholder="1.0"
                />
              </View>
            </View>

            <TouchableOpacity
              style={[
                styles.generateButton,
                generating && styles.buttonDisabled,
              ]}
              onPress={handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.generateButtonText}>Generate Speech</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Section 5: Results */}
        {generatedAudio && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Generated Audio</Text>
            <View style={styles.resultContainer}>
              <Text style={styles.resultText}>
                Samples: {generatedAudio.samples.length.toLocaleString()}
              </Text>
              <Text style={styles.resultText}>
                Sample Rate: {generatedAudio.sampleRate} Hz
              </Text>
              <Text style={styles.resultText}>
                Duration:{' '}
                {(
                  generatedAudio.samples.length / generatedAudio.sampleRate
                ).toFixed(2)}{' '}
                seconds
              </Text>
            </View>
            <Text style={styles.noteText}>
              Note: Audio playback will be implemented in a future update
            </Text>
          </View>
        )}

        {/* Error Display */}
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Cleanup Button */}
        {currentModelFolder && (
          <TouchableOpacity
            style={styles.cleanupButton}
            onPress={handleCleanup}
          >
            <Text style={styles.cleanupButtonText}>Release Resources</Text>
          </TouchableOpacity>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            💡 Tip: Models must be placed in assets/models/ directory
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  icon: {
    fontSize: 48,
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
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
  sectionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
  },
  buttonGroup: {
    gap: 12,
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
  modelButtonSubtext: {
    fontSize: 12,
    color: '#8E8E93',
  },
  loadingContainer: {
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#8E8E93',
  },
  resultContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  resultText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 4,
  },
  detectedModelsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  detectedModelButton: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  detectedModelButtonActive: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  detectedModelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000000',
  },
  detectedModelButtonTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  autoSelectedText: {
    fontSize: 14,
    color: '#34C759',
    fontWeight: '500',
  },
  infoContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
  },
  infoText: {
    fontSize: 14,
    color: '#000000',
    marginBottom: 4,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000000',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#000000',
    marginBottom: 16,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  parameterRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  parameterColumn: {
    flex: 1,
  },
  parameterInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#000000',
  },
  generateButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
  generateButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  noteText: {
    fontSize: 12,
    color: '#8E8E93',
    fontStyle: 'italic',
    marginTop: 8,
  },
  errorContainer: {
    backgroundColor: '#FFE5E5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 14,
    color: '#D32F2F',
  },
  cleanupButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  cleanupButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  footer: {
    alignItems: 'center',
    padding: 16,
  },
  footerText: {
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
  },
});
