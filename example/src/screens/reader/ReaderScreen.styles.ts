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
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    flexShrink: 1,
  },
  sectionHint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#F2F2F7',
  },
  toolbarButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    justifyContent: 'center',
  },
  toolbarButtonPressed: {
    opacity: 0.6,
  },
  toolbarButtonText: {
    fontSize: 15,
    color: '#007AFF',
    fontWeight: '600',
  },
  settings: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 6,
    backgroundColor: '#F2F2F7',
  },
  reader: {
    flex: 1,
  },
  insertCard: {
    marginHorizontal: 20,
    marginVertical: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    gap: 8,
  },
  insertTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  insertBody: {
    fontSize: 14,
    color: '#64748b',
    lineHeight: 20,
  },
  insertButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  insertButtonPressed: {
    opacity: 0.6,
  },
  insertButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  log: {
    minHeight: 84,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E7EB',
  },
  logLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#111827',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sectionRow: {
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    gap: 2,
  },
  sectionRowTitle: {
    fontSize: 16,
    color: '#111827',
    fontWeight: '500',
  },
  sectionRowMeta: {
    fontSize: 12,
    color: '#64748b',
  },
});
