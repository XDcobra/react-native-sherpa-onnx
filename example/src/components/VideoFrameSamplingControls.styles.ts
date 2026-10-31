import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  root: {
    gap: 10,
  },
  hint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  modeChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  modeChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  modeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  modeChipTextActive: {
    color: '#0065D1',
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0f172a',
    backgroundColor: '#fff',
  },
});
