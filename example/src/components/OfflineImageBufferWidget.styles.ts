import { StyleSheet } from 'react-native';

export const widgetStyles = StyleSheet.create({
  root: {
    gap: 12,
  },
  sourceChoiceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sourceChoiceButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  sourceChoiceButtonDisabled: {
    backgroundColor: '#94a3b8',
    opacity: 0.9,
  },
  sourceChoiceButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
  },
  subsectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    marginBottom: 4,
  },
  imageFilesContainer: {
    gap: 4,
  },
  imageFileSection: {
    gap: 8,
  },
  imageFileSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
  },
  imageFileButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  imageFileButtonActive: {
    borderColor: '#007AFF',
    backgroundColor: '#E8F1FF',
  },
  imageFileButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#222',
  },
  imageFileButtonTextActive: {
    color: '#007AFF',
  },
  imageFileDescription: {
    fontSize: 12,
    color: '#666',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  progressBox: {
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  progressLabel: {
    fontSize: 13,
    color: '#444',
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#ddd',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    backgroundColor: '#007AFF',
  },
  errorText: {
    color: '#c00',
    fontSize: 13,
    lineHeight: 18,
  },
  readyCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 10,
  },
  readyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  readyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    flex: 1,
  },
  deleteButton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  thumb: {
    width: '100%',
    height: 160,
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
  },
  metaText: {
    fontSize: 12,
    color: '#64748b',
    fontFamily: 'Menlo',
    lineHeight: 17,
  },
  changeSourceButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#eef2ff',
  },
  changeSourceButtonText: {
    color: '#3730a3',
    fontWeight: '600',
    fontSize: 13,
  },
});
