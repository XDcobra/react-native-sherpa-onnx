import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export type ModelInitMode = 'auto' | 'custom';

type InitModeSelectorProps = {
  value: ModelInitMode;
  onChange: (mode: ModelInitMode) => void;
  disabled?: boolean;
};

export function InitModeSelector({
  value,
  onChange,
  disabled = false,
}: InitModeSelectorProps) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'auto' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('auto')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'auto' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'auto' && styles.segmentTextActive,
          ]}
        >
          Auto detect
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'custom' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('custom')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'custom' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'custom' && styles.segmentTextActive,
          ]}
        >
          Custom files
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C7C7CC',
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
  },
  segmentActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E3F2FD',
  },
  segmentDisabled: {
    opacity: 0.5,
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#3A3A3C',
  },
  segmentTextActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
});
