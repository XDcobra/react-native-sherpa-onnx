import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
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
  reader: {
    flex: 1,
    backgroundColor: '#FBF8F1',
  },
  insertCard: {
    marginHorizontal: 16,
    marginVertical: 12,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
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
    minHeight: 100,
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
});
