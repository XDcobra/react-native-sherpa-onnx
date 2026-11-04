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
  PunctuationOfflineCustomInitForm,
} from './modelInit';
import type { usePunctuationModelInit } from '../hooks/usePunctuationModelInit';

type PunctInit = ReturnType<typeof usePunctuationModelInit>;

type Props = {
  punctuation: PunctInit;
  sectionStart?: number;
  /** Extra disable (e.g. punctuate in progress). */
  disabled?: boolean;
};

export function PunctuationModelInitPanel({
  punctuation: p,
  sectionStart = 1,
  disabled = false,
}: Props) {
  const n1 = sectionStart;
  const n2 = sectionStart + 1;
  const busy = disabled || p.loading || p.customFillLoading;

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {n1}. Initialize punctuation model
        </Text>
        <InitModeSelector
          value={p.initMode}
          onChange={p.setInitMode}
          disabled={busy}
        />
        <Text style={styles.sectionDescription}>
          {p.initMode === 'auto'
            ? 'Select an offline CT-Transformer catalog folder, then Use model.'
            : 'Pick the CT-Transformer ONNX (or Fill from catalog), then Initialize custom.'}
        </Text>

        {(p.initializedSummary || p.selectedModelForInit) && (
          <View style={styles.currentModelContainer}>
            <Text style={styles.currentModelText}>
              {p.initializedSummary
                ? `Initialized: ${p.initializedSummary}`
                : `Selected: ${
                    p.selectedModelForInit
                      ? getModelDisplayName(p.selectedModelForInit)
                      : ''
                  }`}
            </Text>
          </View>
        )}

        <ModelFolderGrid
          entries={p.catalogEntries}
          selectedId={p.selectedModelForInit}
          initializedId={p.currentModelFolder}
          onSelect={p.setSelectedModelForInit}
          loading={p.loadingModels}
          disabled={busy}
          emptyMessage="No offline CT-Transformer punctuation models found. Install under punctuation (Download manager) or add a matching asset / PAD path."
        />

        {p.initMode === 'custom' ? (
          <PunctuationOfflineCustomInitForm
            value={p.customInitForm}
            onChange={p.setCustomInitForm}
            selectedCatalogModelId={p.selectedModelForInit}
            onFillFromSelectedModel={() => {
              p.fillFromSelectedModel().catch(() => {});
            }}
            onPrepareScatteredTest={p.prepareScatteredTest}
            fillLoading={p.customFillLoading}
            disabled={busy}
            fillHint={p.customFillHint}
          />
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{n2}. Engine options</Text>
        <Text style={styles.smallLabel}>init modelType (offline CT)</Text>
        <View style={styles.chipRow}>
          {(['auto', 'ct_transformer'] as const).map((m) => (
            <TouchableOpacity
              key={m}
              style={[
                styles.chip,
                p.modelTypeInit === m && styles.chipSelected,
              ]}
              onPress={() => p.setModelTypeInit(m)}
              disabled={busy}
            >
              <Text style={styles.chipText}>{m}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.smallLabel}>numThreads</Text>
        <TextInput
          style={styles.optionInput}
          keyboardType="number-pad"
          value={p.numThreads}
          onChangeText={p.setNumThreads}
          placeholder="2"
          editable={!busy}
        />
        <Text style={styles.smallLabel}>provider</Text>
        <TextInput
          style={styles.optionInput}
          value={p.provider}
          onChangeText={p.setProvider}
          autoCapitalize="none"
          placeholder="cpu"
          editable={!busy}
        />
        <View style={styles.debugRow}>
          <Text style={styles.smallLabel}>debug (native) </Text>
          <TouchableOpacity
            onPress={() => p.setDebugPunct(!p.debugPunct)}
            accessibilityRole="button"
            disabled={busy}
          >
            <Ionicons
              name={p.debugPunct ? 'checkbox' : 'square-outline'}
              size={24}
              color={p.debugPunct ? '#007AFF' : '#8E8E93'}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            styles.applyButton,
            busy && styles.buttonDisabled,
          ]}
          onPress={() => {
            p.applySelectedModel();
          }}
          disabled={
            busy ||
            (p.initMode === 'auto'
              ? !p.selectedModelForInit && !p.currentModelFolder
              : false)
          }
        >
          <View style={styles.applyButtonContent}>
            {p.loading ? (
              <ActivityIndicator
                size="small"
                color="#FFFFFF"
                style={styles.applyButtonSpinner}
              />
            ) : null}
            <Text style={styles.primaryButtonText}>
              {p.initMode === 'custom' ? 'Initialize custom' : 'Use model'}
            </Text>
          </View>
        </TouchableOpacity>

        {p.loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Initializing model...</Text>
          </View>
        ) : null}

        {p.initResult && !p.error ? (
          <View style={styles.resultContainer}>
            <Text style={styles.resultText}>{p.initResult}</Text>
          </View>
        ) : null}

        {p.error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorLabel}>Error:</Text>
            <Text style={styles.errorText}>{p.error}</Text>
          </View>
        ) : null}
      </View>
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
  smallLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3A3A3C',
    marginBottom: 6,
    marginTop: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  chip: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: '#E3F2FD',
    borderColor: '#007AFF',
  },
  chipText: {
    fontSize: 13,
    color: '#000000',
    fontWeight: '500',
  },
  optionInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#000000',
  },
  debugRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 4,
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
