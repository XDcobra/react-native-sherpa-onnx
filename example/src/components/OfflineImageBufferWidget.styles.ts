import { StyleSheet } from 'react-native';

export const widgetStyles = StyleSheet.create({
  sourceChoiceRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  sourceChoiceButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 18,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sourceChoiceButtonDisabled: {
    backgroundColor: '#999',
    opacity: 0.8,
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
    marginTop: 4,
    marginBottom: 10,
  },
  imageFilesContainer: {
    marginBottom: 12,
  },
  imageFileSection: {
    marginBottom: 4,
  },
  imageFileSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    marginBottom: 8,
    marginTop: 4,
  },
  imageFileButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    marginBottom: 8,
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
    marginBottom: 12,
  },
  progressLabel: {
    fontSize: 13,
    color: '#444',
    marginBottom: 8,
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
    marginBottom: 12,
  },
  readyCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 8,
  },
  readyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  readyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    flex: 1,
    marginRight: 8,
  },
  deleteButton: {
    padding: 6,
  },
  thumb: {
    width: '100%',
    height: 160,
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
    marginBottom: 8,
  },
  metaText: {
    fontSize: 12,
    color: '#64748b',
    fontFamily: 'Menlo',
  },
  changeSourceButton: {
    marginTop: 8,
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
