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
  ONLINE_STT_MODEL_TYPES,
  type OnlineSTTModelType,
  type StreamingSttCustomPathKey,
} from 'react-native-sherpa-onnx/stt';
import {
  getCustomModelPathRequirements,
  type CustomModelPathRequirements,
} from 'react-native-sherpa-onnx/detect';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';
import { labelForStreamingSttCustomPathKey } from '../../utils/streamingCustomInitLabels';

const STREAMING_CUSTOM_MODEL_TYPES = ONLINE_STT_MODEL_TYPES.filter(
  (type): type is OnlineSTTModelType => type !== 'wenet_ctc'
);

export type StreamingSttCustomInitFormState = {
  modelType: OnlineSTTModelType;
  fileSources: Partial<Record<StreamingSttCustomPathKey, FileSource>>;
};

type StreamingSttCustomInitFormProps = {
  value: StreamingSttCustomInitFormState;
  onChange: (next: StreamingSttCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

export function StreamingSttCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: StreamingSttCustomInitFormProps) {
  const [schema, setSchema] = useState<CustomModelPathRequirements>({
    fields: [],
  });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements('stt_streaming', value.modelType)
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
        key: field.key as StreamingSttCustomPathKey,
        required: field.required,
      })),
    [schema.fields]
  );

  const setModelType = (modelType: OnlineSTTModelType) => {
    onChange({ modelType, fileSources: {} });
  };

  const setFileSource = (
    key: StreamingSttCustomPathKey,
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
      <Text style={styles.subheading}>Streaming model type</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.typeRow}
      >
        {STREAMING_CUSTOM_MODEL_TYPES.map((type) => (
          <TouchableOpacity
            key={type}
            style={[
              styles.typeChip,
              value.modelType === type && styles.typeChipActive,
            ]}
            onPress={() => setModelType(type)}
            disabled={disabled || fillLoading}
          >
            <Text
              style={[
                styles.typeChipText,
                value.modelType === type && styles.typeChipTextActive,
              ]}
            >
              {type}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.fillRow}>
        <TouchableOpacity
          style={[
            styles.fillButton,
            (!selectedCatalogModelId || disabled || fillLoading) &&
              styles.fillButtonDisabled,
          ]}
          onPress={onFillFromSelectedModel}
          disabled={!selectedCatalogModelId || disabled || fillLoading}
        >
          {fillLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.fillButtonText}>Fill from selected model</Text>
          )}
        </TouchableOpacity>
      </View>
      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}

      <Text style={styles.subheading}>Model files</Text>
      {schemaLoading ? (
        <ActivityIndicator size="small" />
      ) : (
        slotKeys.map(({ key, required }) => (
          <FileSourceSlotPicker
            key={key}
            label={labelForStreamingSttCustomPathKey(key)}
            required={required}
            value={value.fileSources[key]}
            onChange={(source) => setFileSource(key, source)}
            disabled={disabled || fillLoading}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  subheading: {
    fontSize: 14,
    fontWeight: '600',
    color: '#161616',
  },
  typeRow: {
    gap: 8,
    paddingVertical: 4,
  },
  typeChip: {
    borderWidth: 1,
    borderColor: '#c6c6c6',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  typeChipActive: {
    borderColor: '#0F62FE',
    backgroundColor: '#edf5ff',
  },
  typeChipText: {
    fontSize: 13,
    color: '#525252',
  },
  typeChipTextActive: {
    color: '#0F62FE',
    fontWeight: '600',
  },
  fillRow: {
    flexDirection: 'row',
  },
  fillButton: {
    backgroundColor: '#393939',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 40,
    justifyContent: 'center',
  },
  fillButtonDisabled: {
    opacity: 0.5,
  },
  fillButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  fillHint: {
    fontSize: 12,
    color: '#525252',
  },
});
