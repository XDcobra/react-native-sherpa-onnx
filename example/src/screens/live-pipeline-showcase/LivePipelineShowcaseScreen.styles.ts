import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
    gap: 14,
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    padding: 14,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1C1C1E',
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    color: '#6E6E73',
  },
  errorBox: {
    flexDirection: 'row',
    backgroundColor: '#FFEBEE',
    borderLeftColor: '#D32F2F',
    borderLeftWidth: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    gap: 8,
  },
  errorText: {
    color: '#D32F2F',
    fontSize: 13,
    flex: 1,
  },
  optionRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  optionButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#F8F8FA',
  },
  optionButtonActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  optionButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3A3A3C',
  },
  optionButtonTextActive: {
    color: '#0065D1',
  },
  // Pipeline diagram
  pipelineDiagram: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 4,
    flexWrap: 'wrap',
  },
  pipelineStep: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#F8F8FA',
    alignItems: 'center',
    minWidth: 56,
  },
  pipelineStepActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  pipelineStepLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6E6E73',
  },
  pipelineStepLabelActive: {
    color: '#0065D1',
  },
  pipelineArrow: {
    fontSize: 14,
    color: '#C7C7CC',
  },
  pipelineArrowActive: {
    color: '#007AFF',
  },
  // Source toggle
  sourceToggle: {
    flexDirection: 'row',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 3,
  },
  sourceToggleBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  sourceToggleBtnActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  sourceToggleText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6E6E73',
  },
  sourceToggleTextActive: {
    color: '#1C1C1E',
  },
  // Run / stop buttons
  runButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    backgroundColor: '#007AFF',
  },
  runButtonDisabled: {
    backgroundColor: '#B0C8E8',
  },
  runButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 13,
    color: '#555',
    flex: 1,
  },
  // Transcript / partial
  transcriptBox: {
    backgroundColor: '#F8F8FA',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    padding: 12,
    gap: 6,
  },
  transcriptLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  partialText: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 20,
    fontStyle: 'italic',
  },
  committedText: {
    fontSize: 14,
    color: '#1C1C1E',
    lineHeight: 20,
  },
  // Segment events
  segmentEventRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F2F7',
    alignItems: 'flex-start',
  },
  segmentEventIndex: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8E8E93',
    minWidth: 22,
  },
  segmentEventText: {
    fontSize: 12,
    color: '#3A3A3C',
    flex: 1,
    lineHeight: 17,
  },
  segmentEventMeta: {
    fontSize: 11,
    color: '#8E8E93',
  },
  // Meta chips
  metaRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  metaChip: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: '#EAF3FF',
  },
  metaChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0065D1',
  },
  metaChipWarn: {
    backgroundColor: '#FFF3E0',
  },
  metaChipTextWarn: {
    color: '#B24A00',
  },
});
