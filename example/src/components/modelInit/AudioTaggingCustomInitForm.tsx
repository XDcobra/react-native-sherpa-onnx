import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  type AudioTaggingCustomPathKey,
  type AudioTaggingModelType,
} from 'react-native-sherpa-onnx/audio-tagging';
import {
  getCustomModelPathRequirements,
  type CustomModelPathRequirements,
} from 'react-native-sherpa-onnx/detect';
import { ModelCategory } from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';

const AUDIO_TAGGING_MODEL_TYPES: readonly AudioTaggingModelType[] = [
  'ced',
  'zipformer',
];

export type AudioTaggingCustomInitFormState = {
  modelType: AudioTaggingModelType;
  fileSources: Partial<Record<AudioTaggingCustomPathKey, FileSource>>;
};

type AudioTaggingCustomInitFormProps = {
  value: AudioTaggingCustomInitFormState;
  onChange: (next: AudioTaggingCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  onPrepareScatteredTest: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

const PATH_LABELS: Record<AudioTaggingCustomPathKey, string> = {
  model: 'Model ONNX',
  labels: 'Labels CSV',
};

export function AudioTaggingCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: AudioTaggingCustomInitFormProps) {
  const [schema, setSchema] = useState<CustomModelPathRequirements>({
    fields: [],
  });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements(ModelCategory.AudioTagging, value.modelType)
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
  }, [value.modelType]);

  const slotKeys = useMemo(
    () =>
      schema.fields.map((field) => ({
        key: field.key as AudioTaggingCustomPathKey,
        required: field.required,
      })),
    [schema.fields]
  );

  const setModelType = (modelType: AudioTaggingModelType) => {
    if (modelType === value.modelType) {
      return;
    }
    onChange({ modelType, fileSources: {} });
  };

  const setFileSource = (
    key: AudioTaggingCustomPathKey,
    source: FileSource | undefined
  ) => {
    const next = { ...value.fileSources };
    if (source) {
      next[key] = source;
    } else {
      delete next[key];
    }
    onChange({ ...value, fileSources: next });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.subheading}>Audio tagging model type</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.typeRow}
      >
        {AUDIO_TAGGING_MODEL_TYPES.map((type) => {
          const active = value.modelType === type;
          return (
            <TouchableOpacity
              key={type}
              style={[styles.typeChip, active && styles.typeChipActive]}
              onPress={() => setModelType(type)}
              disabled={disabled || fillLoading}
            >
              <Text
                style={[
                  styles.typeChipText,
                  active && styles.typeChipTextActive,
                ]}
              >
                {type}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.helperRow}>
        <TouchableOpacity
          style={[
            styles.helperButton,
            (!selectedCatalogModelId || fillLoading || disabled) &&
              styles.helperButtonDisabled,
          ]}
          onPress={onFillFromSelectedModel}
          disabled={!selectedCatalogModelId || fillLoading || disabled}
        >
          {fillLoading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.helperButtonText}>
              Fill from selected model
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.helperButtonSecondary,
            disabled && styles.helperButtonDisabled,
          ]}
          onPress={onPrepareScatteredTest}
          disabled={disabled || fillLoading}
        >
          <Text style={styles.helperButtonSecondaryText}>
            Scattered test (clear slots)
          </Text>
        </TouchableOpacity>
      </View>

      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}

      <Text style={styles.subheading}>Model files</Text>
      <Text style={styles.hint}>
        Dedicated AudioSet pack: model ONNX + class_labels_indices.csv. Use Fill
        to pre-populate from the catalog selection.
      </Text>

      {schemaLoading ? (
        <ActivityIndicator
          size="small"
          color="#5856D6"
          style={styles.schemaLoader}
        />
      ) : null}

      {slotKeys.map(({ key, required }) => (
        <FileSourceSlotPicker
          key={key}
          label={PATH_LABELS[key] ?? key}
          value={value.fileSources[key]}
          onChange={(source) => setFileSource(key, source)}
          disabled={disabled || fillLoading}
          required={required}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 4,
  },
  subheading: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginTop: 8,
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 8,
    lineHeight: 17,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  typeChipActive: {
    backgroundColor: '#EEF4FF',
    borderColor: '#93C5FD',
  },
  typeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  typeChipTextActive: {
    color: '#1D4ED8',
  },
  helperRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  helperButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 140,
    alignItems: 'center',
  },
  helperButtonSecondary: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  helperButtonDisabled: {
    opacity: 0.45,
  },
  helperButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  helperButtonSecondaryText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 13,
  },
  fillHint: {
    fontSize: 12,
    color: '#4B5563',
    marginTop: 4,
    marginBottom: 4,
    lineHeight: 17,
  },
  schemaLoader: {
    marginVertical: 8,
  },
});
