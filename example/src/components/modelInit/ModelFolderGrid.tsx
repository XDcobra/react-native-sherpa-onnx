import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { getSizeHint, getQualityHint } from '../../utils/recommendedModels';

export type ModelFolderGridEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

type ModelFolderGridProps = {
  entries: ModelFolderGridEntry[];
  selectedId: string | null;
  initializedId: string | null;
  onSelect: (modelId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  emptyMessage?: string;
};

export function ModelFolderGrid({
  entries,
  selectedId,
  initializedId,
  onSelect,
  loading = false,
  disabled = false,
  emptyMessage = 'No models found.',
}: ModelFolderGridProps) {
  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Discovering available models…</Text>
      </View>
    );
  }

  if (entries.length === 0) {
    return (
      <View style={styles.warningContainer}>
        <Text style={styles.warningText}>{emptyMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.grid}>
      {entries.map((entry) => {
        const isSelected = selectedId === entry.id;
        const isInitialized = initializedId === entry.id;
        const sizeHintInfo = getSizeHint(entry.id);
        const qualityHintInfo = getQualityHint(entry.id);

        return (
          <TouchableOpacity
            key={entry.id}
            style={[
              styles.modelButton,
              isSelected && styles.modelButtonActive,
              isInitialized && styles.modelButtonInitialized,
              disabled && styles.modelButtonDisabled,
            ]}
            onPress={() => onSelect(entry.id)}
            disabled={disabled}
          >
            <Text
              style={[
                styles.modelButtonText,
                isSelected && styles.modelButtonTextActive,
              ]}
            >
              {entry.label}
            </Text>
            <View style={styles.modelHintRow}>
              <View style={styles.modelHintGroup}>
                <Ionicons
                  name={sizeHintInfo.iconName as any}
                  size={12}
                  color={sizeHintInfo.iconColor}
                />
                <Text style={styles.modelHintText}>{sizeHintInfo.tier}</Text>
              </View>
              <View style={styles.modelHintGroup}>
                <Ionicons
                  name={qualityHintInfo.iconName as any}
                  size={12}
                  color={qualityHintInfo.iconColor}
                />
                <Text style={styles.modelHintText}>
                  {qualityHintInfo.text.split(',')[0]}
                </Text>
              </View>
            </View>
            <Text style={styles.modelFolderText}>{entry.id}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  modelButton: {
    width: '48%',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    backgroundColor: '#F9F9F9',
  },
  modelButtonActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  modelButtonInitialized: {
    borderColor: '#34C759',
    backgroundColor: '#E8F5E9',
  },
  modelButtonDisabled: {
    opacity: 0.6,
  },
  modelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  modelButtonTextActive: {
    color: '#007AFF',
  },
  modelHintRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  modelHintGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  modelHintText: {
    fontSize: 11,
    color: '#8E8E93',
  },
  modelFolderText: {
    fontSize: 10,
    color: '#8E8E93',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
    color: '#8E8E93',
  },
  warningContainer: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#FFF3E0',
  },
  warningText: {
    fontSize: 14,
    color: '#E65100',
  },
});
