import { StyleSheet } from 'react-native';

export const puncStyles = StyleSheet.create({
  outputReadonly: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#C6C6C8',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1b5e20',
    backgroundColor: '#f1f8f1',
  },
  outputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  outputTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  modelChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#C6C6C8',
    marginRight: 8,
    marginBottom: 8,
  },
  modelChipSelected: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.08)',
  },
  modelChipText: {
    fontSize: 14,
    color: '#000',
  },
  modelWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  optionInput: {
    borderWidth: 1,
    borderColor: '#C6C6C8',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    marginBottom: 10,
    color: '#000',
  },
  smallLabel: {
    fontSize: 13,
    color: '#8E8E93',
    marginBottom: 4,
  },
  debugRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  hintAfterAction: {
    marginTop: 8,
  },
  multilineInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#C62828',
    fontSize: 15,
  },
});
