import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  ModelFolderGrid,
  TtsCustomInitForm,
} from './modelInit';
import type { useTtsModelInit } from '../hooks/useTtsModelInit';

const INPUT_PLACEHOLDER_COLOR = '#8E8E93';

type TtsInit = ReturnType<typeof useTtsModelInit>;

type Props = {
  tts: TtsInit;
  sectionStart?: number;
  showScatteredTest?: boolean;
};

export function TtsModelInitPanel({
  tts,
  sectionStart = 1,
  showScatteredTest = true,
}: Props) {
  const n1 = sectionStart;
  const n2 = sectionStart + 1;

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{n1}. Initialize TTS Model</Text>
        <InitModeSelector
          value={tts.initMode}
          onChange={tts.setInitMode}
          disabled={tts.loading || tts.customFillLoading}
        />
        <Text style={styles.sectionDescription}>
          {tts.initMode === 'auto'
            ? 'Select a model folder, then tap "Use model" for auto-detection.'
            : 'Choose model type and pick files (or Fill from a catalog folder), then Initialize.'}
        </Text>

        {(tts.initializedSummary || tts.selectedModelForInit) && (
          <View style={styles.currentModelContainer}>
            <Text style={styles.currentModelText}>
              {tts.initializedSummary
                ? `Initialized: ${tts.initializedSummary}`
                : `Selected: ${
                    tts.selectedModelForInit
                      ? getModelDisplayName(tts.selectedModelForInit)
                      : ''
                  }`}
            </Text>
          </View>
        )}

        <ModelFolderGrid
          entries={tts.catalogEntries}
          selectedId={tts.selectedModelForInit}
          initializedId={tts.currentModelFolder}
          onSelect={tts.setSelectedModelForInit}
          loading={tts.loadingModels}
          disabled={tts.loading || tts.customFillLoading}
          emptyMessage="No TTS models found. See TTS_MODEL_SETUP.md"
        />

        {tts.initMode === 'custom' ? (
          <TtsCustomInitForm
            value={tts.customInitForm}
            onChange={tts.setCustomInitForm}
            selectedCatalogModelId={tts.selectedModelForInit}
            onFillFromSelectedModel={tts.fillFromSelectedModel}
            onPrepareScatteredTest={tts.prepareScatteredTest}
            fillLoading={tts.customFillLoading}
            disabled={tts.loading}
            fillHint={tts.customFillHint}
            showScatteredTest={showScatteredTest}
          />
        ) : null}

        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.applyButton,
            (tts.loading || tts.customFillLoading) && styles.buttonDisabled,
          ]}
          onPress={() => {
            tts.applySelectedModel();
          }}
          disabled={
            tts.loading ||
            tts.customFillLoading ||
            (tts.initMode === 'auto'
              ? !tts.selectedModelForInit && !tts.currentModelFolder
              : false)
          }
        >
          <View style={styles.applyButtonContent}>
            {tts.loading ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                style={styles.applyButtonSpinner}
              />
            ) : null}
            <Text style={styles.primaryButtonText}>
              {tts.initMode === 'custom' ? 'Initialize custom' : 'Use model'}
            </Text>
          </View>
        </TouchableOpacity>

        {tts.loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Initializing model...</Text>
          </View>
        )}

        {tts.initResult ? (
          <View style={styles.resultContainer}>
            <Text style={styles.resultText}>{tts.initResult}</Text>
          </View>
        ) : null}
      </View>

      {tts.detectedModels.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{n2}. Select Model Type</Text>
          {tts.detectedModels.length > 1 ? (
            <>
              <Text style={styles.sectionDescription}>
                Multiple model types detected. Select one:
              </Text>
              <View style={styles.detectedModelsContainer}>
                {tts.detectedModels.map((model) => (
                  <TouchableOpacity
                    key={model.type}
                    style={[
                      styles.detectedModelButton,
                      tts.selectedModelType === model.type &&
                        styles.detectedModelButtonActive,
                    ]}
                    onPress={() => tts.setSelectedModelType(model.type)}
                  >
                    <Text
                      style={[
                        styles.detectedModelButtonText,
                        tts.selectedModelType === model.type &&
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
            <View style={styles.rowAlignCenter}>
              <Ionicons
                name="checkmark-circle"
                size={16}
                color="#34C759"
                style={styles.iconInline}
              />
              <Text style={styles.autoSelectedText}>
                Auto-selected: {tts.selectedModelType}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {tts.modelInfo ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Model Information</Text>
          <View style={styles.infoContainer}>
            <Text style={styles.infoText}>
              Sample Rate: {tts.modelInfo.sampleRate} Hz
            </Text>
            <Text style={styles.infoText}>
              Speakers: {tts.modelInfo.numSpeakers}
            </Text>
          </View>
        </View>
      ) : null}

      {tts.selectedModelType != null ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Synthesis options</Text>
          <Text style={styles.sectionDescription}>
            Speaker and speed apply to all models.
          </Text>
          <Text style={styles.inputLabel}>Speaker ID:</Text>
          <TextInput
            style={styles.synthesisOptionInput}
            value={tts.speakerId}
            onChangeText={tts.setSpeakerId}
            keyboardType="number-pad"
            placeholder="0"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
          />
          <Text style={styles.inputLabel}>Speed:</Text>
          <TextInput
            style={styles.synthesisOptionInput}
            value={tts.speed}
            onChangeText={tts.setSpeed}
            keyboardType="decimal-pad"
            placeholder="1.0"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
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
  currentModelContainer: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  currentModelText: {
    fontSize: 14,
    color: '#3A3A3C',
    fontWeight: '500',
  },
  primaryButton: {
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
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
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
  rowAlignCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconInline: {
    marginRight: 6,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000000',
    marginBottom: 8,
  },
  synthesisOptionInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#000000',
    marginBottom: 16,
  },
});
