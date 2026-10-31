import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  sectionHint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FECACA',
    padding: 12,
    gap: 4,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B91C1C',
  },
  errorText: {
    fontSize: 13,
    color: '#7F1D1D',
    lineHeight: 18,
  },
  hintBox: {
    backgroundColor: '#FFFBEB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FDE68A',
    padding: 12,
  },
  hintText: {
    fontSize: 13,
    color: '#92400E',
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusChip: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  statusLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statusValue: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#0f172a',
    marginTop: 2,
  },
  mono: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#334155',
    lineHeight: 17,
  },
});
