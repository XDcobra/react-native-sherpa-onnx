import { StyleSheet } from 'react-native';

export const HIT_CHIP_COLORS = [
  '#2563EB',
  '#059669',
  '#D97706',
  '#DB2777',
  '#7C3AED',
  '#0891B2',
];

export function colorForKeyword(keyword: string): string {
  const hash = keyword.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const idx = Math.abs(hash) % HIT_CHIP_COLORS.length;
  return HIT_CHIP_COLORS[idx] ?? '#2563EB';
}

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    padding: 14,
    gap: 10,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1C1C1E',
  },
  cardSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: '#636366',
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    color: '#8E8E93',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#A1A1AA',
  },
  statusDotRunning: {
    backgroundColor: '#16A34A',
  },
  statusDotReady: {
    backgroundColor: '#2563EB',
  },
  statusText: {
    fontSize: 13,
    color: '#3A3A3C',
    flex: 1,
  },
  errorText: {
    fontSize: 13,
    color: '#DC2626',
  },
  flex1: {
    flex: 1,
  },
  dangerText: {
    color: '#DC2626',
  },
  keywordsInput: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    fontFamily: 'Menlo',
    color: '#1C1C1E',
    textAlignVertical: 'top',
    backgroundColor: '#FAFAFA',
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  primaryButtonDanger: {
    backgroundColor: '#DC2626',
  },
  primaryButtonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  paramLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3A3A3C',
    marginTop: 4,
  },
  paramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  paramInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#1C1C1E',
    backgroundColor: '#FAFAFA',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#F2F2F7',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  chipActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#3A3A3C',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  hud: {
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 16,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 96,
  },
  hudIdle: {
    opacity: 0.85,
  },
  hudLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  hudKeyword: {
    fontSize: 28,
    fontWeight: '800',
    color: '#F8FAFC',
    textAlign: 'center',
  },
  hudMeta: {
    marginTop: 6,
    fontSize: 12,
    color: '#94A3B8',
  },
  timelineScroll: {
    maxHeight: 52,
  },
  timelineChip: {
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
  },
  timelineChipText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  eventLog: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: '#E5E5EA',
    borderRadius: 8,
    backgroundColor: '#FAFAFA',
    padding: 8,
  },
  eventRow: {
    fontSize: 12,
    fontFamily: 'Menlo',
    color: '#3A3A3C',
    marginBottom: 4,
  },
  noModelsBanner: {
    backgroundColor: '#FFF7ED',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FDBA74',
    padding: 12,
    gap: 10,
  },
  noModelsText: {
    fontSize: 13,
    color: '#9A3412',
    lineHeight: 18,
  },
  downloadLinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: '#EA580C',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  downloadLinkText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  iconButton: {
    padding: 6,
  },
  marginTop8: {
    marginTop: 8,
  },
});
