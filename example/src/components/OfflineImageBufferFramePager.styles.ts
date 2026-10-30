import { StyleSheet } from 'react-native';

export const framePagerStyles = StyleSheet.create({
  root: {
    gap: 8,
  },
  frame: {
    width: '100%',
    height: 240,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    overflow: 'hidden',
  },
  chrome: {
    gap: 8,
  },
  pageLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
  },
  navRow: {
    flexDirection: 'row',
    gap: 10,
  },
  navButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  navButtonDisabled: {
    backgroundColor: '#94a3b8',
  },
  navButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
