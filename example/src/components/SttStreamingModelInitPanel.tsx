import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getModelDisplayName } from '../modelConfig';
import { InitModeSelector, StreamingSttCustomInitForm } from './modelInit';
import { EngineModeModelSelector } from './EngineModeModelSelector';
import type { useSttStreamingModelInit } from '../hooks/useSttStreamingModelInit';

const STT_STREAMING_MODE_HINT =
  'Streaming mode lists models with isStreaming=true from detectSttModel. Live Overload uses offline STT weights with mandatory segmentation on the same live audio/text buffers.';

type SttStreamingInit = ReturnType<typeof useSttStreamingModelInit>;

type Props = {
  stt: SttStreamingInit;
  sectionStart?: number;
  disabled?: boolean;
};

export function SttStreamingModelInitPanel({
  stt,
  sectionStart = 1,
  disabled = false,
}: Props) {
  const n1 = sectionStart;
  const busy = disabled || stt.loading || stt.customFillLoading;
  const modelIds = stt.catalogEntries.map((entry) => entry.id);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{n1}. Initialize model</Text>
      <Text style={styles.sectionDescription}>
        Build the streaming or Live Overload STT engine once; pipeline runs
        reuse it until Rebuild or Release.
      </Text>

      <EngineModeModelSelector
        label="STT Engine"
        engineMode={stt.engineMode}
        onEngineModeChange={stt.setEngineMode}
        models={modelIds}
        selectedModel={stt.selectedModelForInit}
        onModelSelect={stt.setSelectedModelForInit}
        isModelStreamingCapable={(m) => stt.streamingModelIdSet.has(m)}
        isModelOfflineCapable={(m) => stt.offlineCapableModelIdSet.has(m)}
        loading={stt.loadingModels}
        disabled={busy}
        streamingHintOverride={STT_STREAMING_MODE_HINT}
        mandatorySegmentationHint="Live Overload requires mandatory segmentation to commit speech segments before transcription."
      />

      {stt.engineMode === 'streaming' ? (
        <>
          <InitModeSelector
            value={stt.initMode}
            onChange={stt.setInitMode}
            disabled={busy}
          />
          <Text style={styles.sectionDescription}>
            {stt.initMode === 'auto'
              ? 'Select a streaming-capable folder, then Use model.'
              : 'Choose model type, pick ONNX files (or Fill from catalog), then Initialize custom.'}
          </Text>
        </>
      ) : (
        <Text style={styles.sectionDescription}>
          Live Overload uses offline STT weights. Select an offline-capable
          model, then Use model.
        </Text>
      )}

      {(stt.initializedSummary ||
        stt.currentModelFolder ||
        stt.selectedModelForInit) && (
        <View style={styles.currentModelContainer}>
          <Text style={styles.currentModelText}>
            {stt.initializedSummary
              ? `Initialized: ${stt.initializedSummary}`
              : stt.currentModelFolder
              ? `Loaded: ${getModelDisplayName(stt.currentModelFolder)}`
              : `Selected: ${
                  stt.selectedModelForInit
                    ? getModelDisplayName(stt.selectedModelForInit)
                    : ''
                }`}
          </Text>
        </View>
      )}

      {stt.engineMode === 'streaming' && stt.initMode === 'custom' ? (
        <StreamingSttCustomInitForm
          value={stt.customInitForm}
          onChange={stt.setCustomInitForm}
          selectedCatalogModelId={stt.selectedModelForInit}
          onFillFromSelectedModel={() => {
            stt.fillFromSelectedModel().catch(() => {});
          }}
          fillLoading={stt.customFillLoading}
          disabled={busy}
          fillHint={stt.customFillHint}
        />
      ) : null}

      <TouchableOpacity
        style={[
          styles.primaryButton,
          styles.applyButton,
          busy && styles.buttonDisabled,
        ]}
        onPress={() => {
          stt.applySelectedModel();
        }}
        disabled={
          busy ||
          (stt.engineMode === 'offline' || stt.initMode === 'auto'
            ? !stt.selectedModelForInit && !stt.currentModelFolder
            : false)
        }
      >
        <View style={styles.applyButtonContent}>
          {stt.loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
          )}
          <Text style={styles.primaryButtonText}>
            {stt.isEngineInitialized
              ? stt.engineMode === 'streaming' && stt.initMode === 'custom'
                ? 'Rebuild custom'
                : 'Rebuild model'
              : stt.engineMode === 'streaming' && stt.initMode === 'custom'
              ? 'Initialize custom'
              : 'Use model'}
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.secondaryButton,
          (!stt.isEngineInitialized || busy) && styles.buttonDisabled,
        ]}
        onPress={() => {
          stt.releaseEngine().catch(() => {});
        }}
        disabled={!stt.isEngineInitialized || busy}
      >
        <Text style={styles.secondaryButtonText}>Release engine</Text>
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
  secondaryButton: {
    marginTop: 10,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#1D4ED8',
    fontSize: 15,
    fontWeight: '600',
  },
  applyButton: {
    marginTop: 16,
  },
  applyButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
});
