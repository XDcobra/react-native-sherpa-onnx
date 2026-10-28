import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  icon: {
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    gap: 10,
  },
  warnSection: {
    backgroundColor: '#FFF4E5',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#F5C16C',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
  },
  sectionHint: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 18,
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
  },
  sourceActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sourceActionTitle: {
    flex: 1,
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#F2F2F7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    fontSize: 12,
    color: '#8E8E93',
  },
  bodyText: {
    fontSize: 16,
    color: '#111827',
    lineHeight: 24,
  },
  placeholder: {
    fontSize: 14,
    color: '#8E8E93',
  },
  highlight: {
    backgroundColor: '#FDE68A',
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#F2F2F7',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 15,
    fontWeight: '600',
  },
  releaseButton: {
    alignSelf: 'flex-end',
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  releaseButtonText: {
    color: '#FF3B30',
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButtonFlex: {
    flex: 1,
  },
  errorText: {
    color: '#b91c1c',
    fontSize: 13,
    lineHeight: 18,
  },
  progressBox: {
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  progressLabel: {
    fontSize: 13,
    color: '#334155',
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
  originList: {
    gap: 10,
  },
  originBlock: {
    gap: 6,
    paddingLeft: 10,
    borderLeftWidth: 3,
  },
  originBlockMarkup: {
    borderLeftColor: '#2563EB',
  },
  originBlockOcr: {
    borderLeftColor: '#EA580C',
  },
  originChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  originChipMarkup: {
    backgroundColor: '#DBEAFE',
  },
  originChipOcr: {
    backgroundColor: '#FFEDD5',
  },
  originChipText: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  originChipTextMarkup: {
    color: '#1D4ED8',
  },
  originChipTextOcr: {
    color: '#C2410C',
  },
});
