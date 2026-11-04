import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import {
  InitModeSelector,
  ModelFolderGrid,
  SttCustomInitForm,
} from './modelInit';
import type { useSttModelInit } from '../hooks/useSttModelInit';

type SttInit = ReturnType<typeof useSttModelInit>;

type Props = {
  stt: SttInit;
  sectionStart?: number;
  showScatteredTest?: boolean;
};

export function SttModelInitPanel({
  stt,
  sectionStart = 1,
  showScatteredTest = true,
}: Props) {
  const n1 = sectionStart;
  const n2 = sectionStart + 1;
  const showTypePicker = stt.detectedModels.length > 1;

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{n1}. Initialize Model</Text>
        <InitModeSelector
          value={stt.initMode}
          onChange={stt.setInitMode}
          disabled={stt.loading || stt.customFillLoading}
        />
        <Text style={styles.sectionDescription}>
          {stt.initMode === 'auto'
            ? 'Select a model folder, then tap "Use model" for auto-detection.'
            : 'Choose model type and pick files (or Fill from a catalog folder), then Initialize.'}
        </Text>

        {(stt.initializedSummary || stt.selectedModelForInit) && (
          <View style={styles.currentModelContainer}>
            <Text style={styles.currentModelText}>
              {stt.initializedSummary
                ? `Initialized: ${stt.initializedSummary}`
                : `Selected: ${
                    stt.selectedModelForInit
                      ? getModelDisplayName(stt.selectedModelForInit)
                      : ''
                  }`}
            </Text>
          </View>
        )}

        <ModelFolderGrid
          entries={stt.catalogEntries}
          selectedId={stt.selectedModelForInit}
          initializedId={stt.currentModelFolder}
          onSelect={stt.setSelectedModelForInit}
          loading={stt.loadingModels}
          disabled={stt.loading || stt.customFillLoading}
          emptyMessage="No models found. Add bundled, downloaded, or PAD STT models."
        />

        {stt.initMode === 'custom' ? (
          <SttCustomInitForm
            value={stt.customInitForm}
            onChange={stt.setCustomInitForm}
            selectedCatalogModelId={stt.selectedModelForInit}
            onFillFromSelectedModel={stt.fillFromSelectedModel}
            onPrepareScatteredTest={stt.prepareScatteredTest}
            fillLoading={stt.customFillLoading}
            disabled={stt.loading}
            fillHint={stt.customFillHint}
            showScatteredTest={showScatteredTest}
          />
        ) : null}

        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.applyButton,
            (stt.loading || stt.customFillLoading) && styles.buttonDisabled,
          ]}
          onPress={() => {
            stt.applySelectedModel();
          }}
          disabled={
            stt.loading ||
            stt.customFillLoading ||
            (stt.initMode === 'auto'
              ? !stt.selectedModelForInit && !stt.currentModelFolder
              : false)
          }
        >
          <View style={styles.applyButtonContent}>
            {stt.loading ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                style={styles.applyButtonSpinner}
              />
            ) : null}
            <Text style={styles.primaryButtonText}>
              {stt.initMode === 'custom' ? 'Initialize custom' : 'Use model'}
            </Text>
          </View>
        </TouchableOpacity>

        {stt.initResult && !stt.error ? (
          <View style={styles.resultContainer}>
            <Text style={styles.resultText}>{stt.initResult}</Text>
          </View>
        ) : null}

        {stt.error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorLabel}>Error:</Text>
            <Text style={styles.errorText}>{stt.error}</Text>
          </View>
        ) : null}
      </View>

      {stt.detectedModels.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{n2}. Select Model Type</Text>
          {showTypePicker ? (
            <>
              <Text style={styles.sectionDescription}>
                Multiple model types were detected. Select which one to use for
                transcription.
              </Text>
              <View style={styles.detectedModelsContainer}>
                {stt.detectedModels.map((model, index) => (
                  <TouchableOpacity
                    key={`${model.type}-${index}`}
                    style={[
                      styles.detectedModelButton,
                      stt.selectedModelType === model.type &&
                        styles.detectedModelButtonActive,
                    ]}
                    onPress={() => stt.setSelectedModelType(model.type)}
                  >
                    <Text
                      style={[
                        styles.detectedModelButtonText,
                        stt.selectedModelType === model.type &&
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
              {!stt.selectedModelType ? (
                <View style={styles.warningContainer}>
                  <Text style={styles.warningText}>
                    Please select a model type above
                  </Text>
                </View>
              ) : null}
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
                Auto-selected: {stt.selectedModelType}
              </Text>
            </View>
          )}
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
  errorContainer: {
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  errorLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#C62828',
    marginBottom: 4,
  },
  errorText: {
    fontSize: 14,
    color: '#C62828',
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
    marginBottom: 8,
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
  detectedModelPath: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 4,
  },
  autoSelectedText: {
    fontSize: 14,
    color: '#34C759',
    fontWeight: '500',
  },
  rowAlignCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconInline: {
    marginRight: 6,
  },
  warningContainer: {
    backgroundColor: '#FFF3CD',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  warningText: {
    fontSize: 14,
    color: '#856404',
  },
});
