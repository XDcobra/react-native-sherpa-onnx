import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  diagram: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 4,
    flexWrap: 'wrap',
  },
  step: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#F8F8FA',
    alignItems: 'center',
    minWidth: 56,
  },
  stepActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  stepLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6E6E73',
  },
  stepLabelActive: {
    color: '#0065D1',
  },
  arrow: {
    fontSize: 14,
    color: '#C7C7CC',
  },
  arrowActive: {
    color: '#007AFF',
  },
});
