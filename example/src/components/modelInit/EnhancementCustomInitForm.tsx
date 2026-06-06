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
  ENHANCEMENT_MODEL_TYPES,
  type EnhancementConcreteModelType,
  type EnhancementCustomPathKey,
} from 'react-native-sherpa-onnx/enhancement';
import { getCustomModelPathRequirements } from 'react-native-sherpa-onnx/detect';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';
import { labelForEnhancementCustomPathKey } from '../../utils/enhancementCustomInitLabels';

export type EnhancementCustomInitFormState = {
  modelType: EnhancementConcreteModelType;
  fileSources: Partial<Record<EnhancementCustomPathKey, FileSource>>;
};

type EnhancementCustomInitFormProps = {
  value: EnhancementCustomInitFormState;
  onChange: (next: EnhancementCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  onPrepareScatteredTest: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

export function EnhancementCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: EnhancementCustomInitFormProps) {
  const [schema, setSchema] = useState<{
    required: string[];
    optional: string[];
  }>({ required: [], optional: [] });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements('enhancement', value.modelType)
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

  const slotKeys = useMemo(() => {
    const requiredSet = new Set(schema.required);
    const seen = new Set<string>();
    const keys: Array<{ key: EnhancementCustomPathKey; required: boolean }> =
      [];
    for (const key of schema.required) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push({ key: key as EnhancementCustomPathKey, required: true });
      }
    }
    for (const key of schema.optional) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push({
          key: key as EnhancementCustomPathKey,
          required: requiredSet.has(key),
        });
      }
    }
    return keys;
  }, [schema]);

  const setModelType = (modelType: EnhancementConcreteModelType) => {
    onChange({ modelType, fileSources: {} });
  };

  const setFileSource = (
    key: EnhancementCustomPathKey,
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
      <Text style={styles.subheading}>Enhancement model type</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.typeRow}
      >
        {ENHANCEMENT_MODEL_TYPES.map((type) => {
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

      <Text style={styles.subheading}>Model file</Text>
      <Text style={styles.hint}>
        Pick the denoiser ONNX file. Use Fill to pre-populate from the catalog
        selection, then override for scattered layouts.
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
          label={labelForEnhancementCustomPathKey(key)}
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
    fontSize: 15,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
    marginTop: 8,
  },
  hint: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 8,
  },
  schemaLoader: {
    marginVertical: 8,
  },
  typeRow: {
    gap: 8,
    paddingBottom: 4,
  },
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#C7C7CC',
    backgroundColor: '#F2F2F7',
  },
  typeChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  typeChipText: {
    fontSize: 12,
    color: '#3A3A3C',
  },
  typeChipTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  helperRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginVertical: 8,
  },
  helperButton: {
    backgroundColor: '#5856D6',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 160,
    alignItems: 'center',
  },
  helperButtonSecondary: {
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C7C7CC',
  },
  helperButtonDisabled: {
    opacity: 0.5,
  },
  helperButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  helperButtonSecondaryText: {
    color: '#3A3A3C',
    fontSize: 13,
    fontWeight: '500',
  },
  fillHint: {
    fontSize: 12,
    color: '#5856D6',
    marginBottom: 4,
  },
});
