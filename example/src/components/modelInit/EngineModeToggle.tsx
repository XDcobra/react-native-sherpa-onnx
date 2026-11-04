import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { EngineMode } from '../EngineModeModelSelector';

type EngineModeToggleProps = {
  value: EngineMode;
  onChange: (mode: EngineMode) => void;
  disabled?: boolean;
};

export function EngineModeToggle({
  value,
  onChange,
  disabled = false,
}: EngineModeToggleProps) {
  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'streaming' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('streaming')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'streaming' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'streaming' && styles.segmentTextActive,
          ]}
        >
          Streaming
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.segment,
          value === 'offline' && styles.segmentActive,
          disabled && styles.segmentDisabled,
        ]}
        onPress={() => onChange('offline')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'offline' }}
      >
        <Text
          style={[
            styles.segmentText,
            value === 'offline' && styles.segmentTextActive,
          ]}
        >
          Live Overload
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
