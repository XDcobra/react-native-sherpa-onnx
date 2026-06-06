import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { AlignmentCustomPathKey } from 'react-native-sherpa-onnx/alignment';
import {
  getCustomModelPathRequirements,
  type CustomModelPathRequirements,
} from 'react-native-sherpa-onnx/detect';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';
import { labelForAlignmentCustomPathKey } from '../../utils/alignmentCustomInitLabels';

export type AlignmentCustomInitFormState = {
  fileSources: Partial<Record<AlignmentCustomPathKey, FileSource>>;
};

type AlignmentCustomInitFormProps = {
  value: AlignmentCustomInitFormState;
  onChange: (next: AlignmentCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  onPrepareScatteredTest: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

export function AlignmentCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: AlignmentCustomInitFormProps) {
  const [schema, setSchema] = useState<CustomModelPathRequirements>({
    fields: [],
  });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements('alignment', 'wav2vec2')
      .then((requirements) => {
        if (!cancelled) {
          setSchema(requirements);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSchemaLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const slotKeys = useMemo(
    () =>
      schema.fields.map((field) => ({
        key: field.key as AlignmentCustomPathKey,
        required: field.required,
      })),
    [schema.fields]
  );

  const setFileSource = (
    key: AlignmentCustomPathKey,
    source: FileSource | undefined
  ) => {
    const next = { ...value.fileSources };
    if (source) {
      next[key] = source;
    } else {
      delete next[key];
    }
    onChange({ fileSources: next });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.subheading}>Custom paths (wav2vec2)</Text>
      {schemaLoading ? (
        <ActivityIndicator style={styles.loader} />
      ) : (
        slotKeys.map(({ key, required }) => (
          <FileSourceSlotPicker
            key={key}
            label={labelForAlignmentCustomPathKey(key)}
            value={value.fileSources[key]}
            onChange={(source) => setFileSource(key, source)}
            disabled={disabled}
            required={required}
          />
        ))
      )}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[
            styles.actionButton,
            (!selectedCatalogModelId || fillLoading || disabled) &&
              styles.actionDisabled,
          ]}
          disabled={!selectedCatalogModelId || fillLoading || disabled}
          onPress={onFillFromSelectedModel}
        >
          {fillLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.actionText}>Fill from selected catalog</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionButton, disabled && styles.actionDisabled]}
          disabled={disabled}
          onPress={onPrepareScatteredTest}
        >
          <Text style={styles.actionText}>Scattered test</Text>
        </TouchableOpacity>
      </View>
      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 12, gap: 8 },
  subheading: { fontSize: 14, fontWeight: '600', color: '#333' },
  loader: { marginVertical: 8 },
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
