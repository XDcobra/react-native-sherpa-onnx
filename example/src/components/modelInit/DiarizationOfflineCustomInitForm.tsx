import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';

export type DiarizationOfflineCustomInitFormState = {
  segmentationSource?: FileSource;
  embeddingSource?: FileSource;
};

type DiarizationOfflineCustomInitFormProps = {
  value: DiarizationOfflineCustomInitFormState;
  onChange: (next: DiarizationOfflineCustomInitFormState) => void;
  selectedSegCatalogModelId: string | null;
  selectedEmbCatalogModelId: string | null;
  onFillSegmentationFromCatalog?: () => void;
  onFillEmbeddingFromCatalog?: () => void;
  onPrepareScatteredTest?: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

export function DiarizationOfflineCustomInitForm({
  value,
  onChange,
  selectedSegCatalogModelId,
  selectedEmbCatalogModelId,
  onFillSegmentationFromCatalog,
  onFillEmbeddingFromCatalog,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: DiarizationOfflineCustomInitFormProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.subheading}>Custom paths (offline)</Text>
      <FileSourceSlotPicker
        label="Pyannote / Reverb segmentation model (.onnx)"
        value={value.segmentationSource}
        onChange={(source) =>
          onChange({ ...value, segmentationSource: source })
        }
        disabled={disabled}
        required
      />
      <FileSourceSlotPicker
        label="Speaker embedding model (.onnx)"
        value={value.embeddingSource}
        onChange={(source) => onChange({ ...value, embeddingSource: source })}
        disabled={disabled}
        required
      />
      <View style={styles.actions}>
        {onFillSegmentationFromCatalog ? (
          <TouchableOpacity
            style={[
              styles.actionButton,
              (!selectedSegCatalogModelId || fillLoading || disabled) &&
                styles.actionDisabled,
            ]}
            disabled={!selectedSegCatalogModelId || fillLoading || disabled}
            onPress={onFillSegmentationFromCatalog}
          >
            <Text style={styles.actionText}>Fill seg from catalog</Text>
          </TouchableOpacity>
        ) : null}
        {onFillEmbeddingFromCatalog ? (
          <TouchableOpacity
            style={[
              styles.actionButton,
              (!selectedEmbCatalogModelId || fillLoading || disabled) &&
                styles.actionDisabled,
            ]}
            disabled={!selectedEmbCatalogModelId || fillLoading || disabled}
            onPress={onFillEmbeddingFromCatalog}
          >
            <Text style={styles.actionText}>Fill emb from catalog</Text>
          </TouchableOpacity>
        ) : null}
        {onPrepareScatteredTest ? (
          <TouchableOpacity
            style={[styles.actionButton, disabled && styles.actionDisabled]}
            disabled={disabled}
            onPress={onPrepareScatteredTest}
          >
            <Text style={styles.actionText}>Scattered test</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 12, gap: 8 },
  subheading: { fontSize: 14, fontWeight: '600', color: '#333' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  actionButton: {
    backgroundColor: '#555',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionDisabled: { opacity: 0.45 },
  actionText: { color: '#fff', fontSize: 13 },
  fillHint: { fontSize: 12, color: '#666', marginTop: 4 },
});
