import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from '@react-native-documents/picker';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  describeFileSource,
  resolveAudioFileDisplayName,
  toFileSource,
} from '../../utils/fileSourceFromUri';

type FileSourceSlotPickerProps = {
  label: string;
  value?: FileSource;
  onChange: (source: FileSource | undefined) => void;
  disabled?: boolean;
  required?: boolean;
  pickTypes?: string[];
};

function isPickerCancelled(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return (
    (DocumentPicker as { isCancel?: (error: unknown) => boolean }).isCancel?.(
      err
    ) === true ||
    e?.name === 'DocumentPickerCanceled' ||
    e?.code === 'DOCUMENT_PICKER_CANCELED'
  );
}

export function FileSourceSlotPicker({
  label,
  value,
  onChange,
  disabled = false,
  required = false,
  pickTypes = [DocumentPicker.types.allFiles],
}: FileSourceSlotPickerProps) {
  const handlePick = async () => {
    try {
      const [picked] = await DocumentPicker.pick({
        type: pickTypes,
        allowMultiSelection: false,
      });
      const uri = picked?.uri?.trim();
      if (!uri) {
        return;
      }
      const displayName = resolveAudioFileDisplayName(uri, picked?.name);
      onChange(toFileSource(uri, displayName));
    } catch (err) {
      if (isPickerCancelled(err)) {
        return;
      }
      Alert.alert('File pick failed', String(err));
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.labelBlock}>
        <Text style={styles.label}>
          {label}
          {required ? ' *' : ''}
        </Text>
        <Text style={styles.path} numberOfLines={2}>
          {value ? describeFileSource(value) : 'No file selected'}
        </Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.pickButton, disabled && styles.pickButtonDisabled]}
          onPress={handlePick}
          disabled={disabled}
        >
          <Text style={styles.pickButtonText}>Pick</Text>
        </TouchableOpacity>
        {value != null && (
          <TouchableOpacity
            style={[styles.clearButton, disabled && styles.pickButtonDisabled]}
            onPress={() => onChange(undefined)}
            disabled={disabled}
          >
            <Text style={styles.clearButtonText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  labelBlock: {
    flex: 1,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 2,
  },
  path: {
    fontSize: 12,
    color: '#8E8E93',
  },
  actions: {
    flexDirection: 'row',
    gap: 6,
  },
  pickButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  pickButtonDisabled: {
    opacity: 0.5,
  },
  pickButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  clearButton: {
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#C7C7CC',
  },
  clearButtonText: {
    color: '#3A3A3C',
    fontSize: 13,
    fontWeight: '500',
  },
});
