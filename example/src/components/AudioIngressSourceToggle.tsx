import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export type AudioIngressSourceMode = 'file' | 'mic';

type AudioIngressSourceToggleProps = {
  value: AudioIngressSourceMode;
  onChange: (mode: AudioIngressSourceMode) => void;
  disabled?: boolean;
};

export function AudioIngressSourceToggle({
  value,
  onChange,
  disabled = false,
}: AudioIngressSourceToggleProps) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'file' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('file')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'file' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'file' && styles.segmentTextActive,
          ]}
        >
          File
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'mic' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('mic')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'mic' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'mic' && styles.segmentTextActive,
          ]}
        >
          Microphone
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
