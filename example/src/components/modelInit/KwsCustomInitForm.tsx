import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  getCustomModelPathRequirements,
  type CustomModelPathRequirements,
} from 'react-native-sherpa-onnx/detect';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';

export type KwsCustomPathKey =
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'keywords';

export type KwsCustomInitFormState = {
  modelType: 'transducer';
  fileSources: Partial<Record<KwsCustomPathKey, FileSource>>;
};

type KwsCustomInitFormProps = {
  value: KwsCustomInitFormState;
  onChange: (next: KwsCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

const KEY_LABELS: Record<KwsCustomPathKey, string> = {
  encoder: 'Encoder ONNX',
  decoder: 'Decoder ONNX',
  joiner: 'Joiner ONNX',
  tokens: 'tokens.txt',
  keywords: 'keywords.txt',
};

export function KwsCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: KwsCustomInitFormProps) {
  const [schema, setSchema] = useState<CustomModelPathRequirements>({
    fields: [],
  });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements('kws', value.modelType)
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
        key: field.key as KwsCustomPathKey,
        required: field.required,
      })),
    [schema.fields]
  );

  const setFileSource = (
    key: KwsCustomPathKey,
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
      <Text style={styles.note}>
        Custom mode initializes with explicit pack paths (initMode custom). Fill
        from a catalog model or pick each slot (encoder / decoder / joiner /
        tokens / keywords). Spotting keyword overrides still come from the
        Keywords textarea via spot keywords option.
      </Text>

      <TouchableOpacity
        style={[
          styles.fillButton,
          (disabled || fillLoading || !selectedCatalogModelId) &&
            styles.fillButtonDisabled,
        ]}
        onPress={onFillFromSelectedModel}
        disabled={disabled || fillLoading || !selectedCatalogModelId}
      >
        {fillLoading ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.fillButtonText}>
            Fill slots from selected catalog model
          </Text>
        )}
      </TouchableOpacity>
      {fillHint ? <Text style={styles.fillHint}>{fillHint}</Text> : null}

      {schemaLoading ? (
        <ActivityIndicator style={styles.schemaSpinner} />
      ) : (
        slotKeys.map(({ key, required }) => (
          <FileSourceSlotPicker
            key={key}
            label={KEY_LABELS[key] ?? key}
            value={value.fileSources[key]}
            onChange={(source) => setFileSource(key, source)}
            required={required}
            disabled={disabled || fillLoading}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    marginTop: 8,
  },
  note: {
    fontSize: 12,
    lineHeight: 17,
    color: '#636366',
  },
  fillButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  fillButtonDisabled: {
    opacity: 0.5,
  },
  fillButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
  },
  fillHint: {
    fontSize: 12,
    color: '#8E8E93',
  },
  schemaSpinner: {
    marginVertical: 12,
  },
});
