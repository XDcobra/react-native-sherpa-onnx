import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props<T extends string | number> = {
  label: string;
  hint?: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  formatLabel?: (option: T) => string;
  locked?: boolean;
};

export function OcrChoiceRow<T extends string | number>({
  label,
  hint,
  options,
  value,
  onChange,
  disabled = false,
  formatLabel,
  locked = false,
}: Props<T>) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <View style={styles.row}>
        {options.map((option) => {
          const active = option === value;
          return (
            <TouchableOpacity
              key={String(option)}
              style={[
                styles.chip,
                active && styles.chipActive,
                (disabled || locked) && styles.chipDisabled,
              ]}
              onPress={() => onChange(option)}
              disabled={disabled || locked}
              accessibilityRole="button"
              accessibilityState={{
                selected: active,
                disabled: disabled || locked,
              }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {formatLabel ? formatLabel(option) : String(option)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginTop: 4,
  },
  hint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActive: {
    backgroundColor: '#E8F1FF',
    borderColor: '#007AFF',
  },
  chipDisabled: {
    opacity: 0.55,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
  },
  chipTextActive: {
    color: '#007AFF',
  },
});
