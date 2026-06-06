import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { StreamingPunctuationCustomPathKey } from 'react-native-sherpa-onnx/punctuation';
import { getCustomModelPathRequirements } from 'react-native-sherpa-onnx/detect';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { FileSourceSlotPicker } from './FileSourceSlotPicker';
import { labelForStreamingPunctuationCustomPathKey } from '../../utils/punctuationCustomInitLabels';

export type PunctuationStreamingCustomInitFormState = {
  fileSources: Partial<Record<StreamingPunctuationCustomPathKey, FileSource>>;
};

type PunctuationStreamingCustomInitFormProps = {
  value: PunctuationStreamingCustomInitFormState;
  onChange: (next: PunctuationStreamingCustomInitFormState) => void;
  selectedCatalogModelId: string | null;
  onFillFromSelectedModel: () => void;
  onPrepareScatteredTest: () => void;
  fillLoading?: boolean;
  disabled?: boolean;
  fillHint?: string | null;
};

export function PunctuationStreamingCustomInitForm({
  value,
  onChange,
  selectedCatalogModelId,
  onFillFromSelectedModel,
  onPrepareScatteredTest,
  fillLoading = false,
  disabled = false,
  fillHint = null,
}: PunctuationStreamingCustomInitFormProps) {
  const [schema, setSchema] = useState<{
    required: string[];
    optional: string[];
  }>({ required: [], optional: [] });
  const [schemaLoading, setSchemaLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSchemaLoading(true);
    getCustomModelPathRequirements('punctuation', 'cnn_bilstm')
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

  const slotKeys = useMemo(() => {
    const requiredSet = new Set(schema.required);
    const seen = new Set<string>();
    const keys: Array<{
      key: StreamingPunctuationCustomPathKey;
      required: boolean;
    }> = [];
    for (const key of schema.required) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push({
          key: key as StreamingPunctuationCustomPathKey,
          required: true,
        });
      }
    }
    for (const key of schema.optional) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push({
          key: key as StreamingPunctuationCustomPathKey,
          required: requiredSet.has(key),
        });
      }
    }
    return keys;
  }, [schema]);

  const setFileSource = (
    key: StreamingPunctuationCustomPathKey,
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
      <Text style={styles.subheading}>Custom paths (cnn_bilstm)</Text>
      {schemaLoading ? (
        <ActivityIndicator style={styles.loader} />
      ) : (
        slotKeys.map(({ key, required }) => (
          <FileSourceSlotPicker
            key={key}
            label={labelForStreamingPunctuationCustomPathKey(key)}
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
