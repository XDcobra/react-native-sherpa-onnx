import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  body: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 36,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 12,
    lineHeight: 20,
  },
  hintCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF8E1',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFD54F',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  hintText: {
    flex: 1,
    fontSize: 13,
    color: '#795548',
    lineHeight: 18,
  },
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#999999',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  selectedFileCard: {
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#F9F9FB',
  },
  selectedFileLabel: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 4,
  },
  selectedFileName: {
    fontSize: 15,
    color: '#1C1C1E',
    fontWeight: '500',
  },
  warningText: {
    marginTop: 8,
    fontSize: 12,
    color: '#C62828',
  },
  inputLabel: {
    fontSize: 14,
    color: '#1C1C1E',
    fontWeight: '500',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#000000',
    fontSize: 15,
    minHeight: 96,
    textAlignVertical: 'top',
  },
  optionRow: {
    gap: 10,
    marginBottom: 12,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dropdownTriggerText: {
    fontSize: 16,
    color: '#1C1C1E',
    fontWeight: '500',
  },
  dropdownBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdownMenu: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 8,
  },
  dropdownTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1C1E',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  dropdownItem: {
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  dropdownItemActive: {
    backgroundColor: '#E3F2FD',
  },
  dropdownItemText: {
    fontSize: 16,
    color: '#1C1C1E',
    fontWeight: '500',
  },
  dropdownItemTextActive: {
    color: '#007AFF',
  },
  dropdownItemDescription: {
    marginTop: 2,
    fontSize: 12,
    color: '#8E8E93',
  },
  generateButton: {
    marginTop: 8,
  },
  resultCard: {
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  resultMetaText: {
    fontSize: 14,
    color: '#1C1C1E',
    marginBottom: 4,
  },
  subtitleList: {
    gap: 8,
  },
  subtitleItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  subtitleText: {
    fontSize: 14,
    color: '#1C1C1E',
    marginBottom: 4,
  },
  subtitleTime: {
    fontSize: 12,
    color: '#8E8E93',
  },
  emptyText: {
    fontSize: 14,
    color: '#8E8E93',
  },
  errorContainer: {
    marginTop: 8,
    backgroundColor: '#FFEBEE',
    borderRadius: 8,
    padding: 12,
  },
  errorText: {
    color: '#B71C1C',
    fontSize: 14,
  },
});
