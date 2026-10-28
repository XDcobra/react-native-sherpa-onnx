import { StyleSheet } from 'react-native';

export const fileSourcePickerStyles = StyleSheet.create({
  choiceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  choiceButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  choiceButtonDisabled: {
    backgroundColor: '#94a3b8',
    opacity: 0.9,
  },
  choiceButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
  },
  browse: {
    gap: 10,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  listTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F2F2F7',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  selectedTextWrap: {
    flex: 1,
    gap: 2,
  },
  selectedLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  selectedDescription: {
    fontSize: 13,
    color: '#6B7280',
  },
  selectedActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  changeButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#E8F1FF',
  },
  changeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  disabled: {
    opacity: 0.5,
  },
});
