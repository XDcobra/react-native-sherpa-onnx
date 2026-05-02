import { StyleSheet } from 'react-native';

export const widgetStyles = StyleSheet.create({
  // Source choice
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
  // Audio file list
  subsectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    marginTop: 4,
    marginBottom: 10,
  },
  audioFilesContainer: {
    marginBottom: 12,
  },
  audioFileButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ddd',
    marginBottom: 8,
  },
  audioFileButtonActive: {
    backgroundColor: '#e3f2fd',
    borderColor: '#2196f3',
  },
  audioFileButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 2,
  },
  audioFileButtonTextActive: {
    color: '#1976d2',
  },
  audioFileDescription: {
    fontSize: 12,
    color: '#999',
  },
  // Decode progress
  decodeProgressContainer: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d3e5ff',
    backgroundColor: '#f5f9ff',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  decodeProgressHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  decodeProgressLabel: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    color: '#1b4f8f',
    fontWeight: '500',
  },
  decodeProgressPercent: {
    fontSize: 12,
    color: '#005ecb',
    fontWeight: '700',
  },
  decodeProgressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#dcecff',
    overflow: 'hidden',
  },
  decodeProgressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 999,
  },
  decodeProgressMeta: {
    marginTop: 6,
    fontSize: 12,
    color: '#5f6f82',
  },
  // Buffer ready card
  bufferReadyCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    padding: 14,
    marginBottom: 8,
  },
  bufferHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  bufferHeaderTextWrap: {
    flex: 1,
  },
  bufferReadyLabel: {
    fontSize: 11,
    color: '#8E8E93',
    marginBottom: 2,
  },
  bufferSourceLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1b5e20',
    marginBottom: 2,
  },
  bufferIdText: {
    fontSize: 11,
    color: '#8E8E93',
  },
  bufferDeleteButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#f5c6cb',
    backgroundColor: '#fff5f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  playButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
  // Pick own file
  pickButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  pickButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  // Change source button
  changeSourceButton: {
    backgroundColor: '#f5f5f5',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
    marginTop: 10,
  },
  changeSourceButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  // Error
  errorContainer: {
    backgroundColor: '#ffebee',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#b71c1c',
  },
  // Row helpers
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAlignCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconInline: {
    marginRight: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
