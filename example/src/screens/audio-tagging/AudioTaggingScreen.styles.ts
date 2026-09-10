import { StyleSheet } from 'react-native';

export const EVENT_COLORS = [
  '#2563EB',
  '#059669',
  '#D97706',
  '#7C3AED',
  '#DC2626',
  '#0891B2',
  '#EA580C',
  '#4F46E5',
] as const;

export function colorForEvent(name: string, indexHint?: number): string {
  const hash = name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const index =
    typeof indexHint === 'number'
      ? indexHint
      : Math.abs(hash) % EVENT_COLORS.length;
  return EVENT_COLORS[index % EVENT_COLORS.length]!;
}

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  },
  bodyText: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
  },
  sectionHint: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  primaryButton: {
    backgroundColor: '#0F62FE',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryButton: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  secondaryButtonText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 15,
  },
  dangerButton: {
    backgroundColor: '#B42318',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  flexButton: {
    flexGrow: 1,
    flexBasis: '40%',
    minWidth: 120,
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 12,
    padding: 12,
  },
  errorText: {
    color: '#B42318',
    fontSize: 13,
    lineHeight: 18,
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
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  chipActive: {
    backgroundColor: '#0F62FE',
    borderColor: '#0F62FE',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  eventHero: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 6,
  },
  eventChip: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#EEF4FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    maxWidth: '100%',
  },
  eventChipText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1D4ED8',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
  },
  metaText: {
    fontSize: 13,
    color: '#6B7280',
  },
  distRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  distLabel: {
    width: 96,
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  distTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#F3F4F6',
    overflow: 'hidden',
  },
  distFill: {
    height: '100%',
    borderRadius: 5,
  },
  distPct: {
    width: 48,
    textAlign: 'right',
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '600',
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  timelineChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#EEF4FF',
    maxWidth: 140,
  },
  timelineChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1D4ED8',
  },
  timelineMeta: {
    flex: 1,
    fontSize: 12,
    color: '#6B7280',
  },
  timelineExpand: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0F62FE',
  },
  timelineDetail: {
    paddingLeft: 8,
    paddingBottom: 8,
    gap: 4,
  },
  hud: {
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 16,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 96,
    gap: 6,
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
  },
  hudPrimary: {
    fontSize: 24,
    fontWeight: '800',
    color: '#F8FAFC',
    textAlign: 'center',
  },
  hudMeta: {
    fontSize: 12,
    color: '#94A3B8',
  },
  liveEventChip: {
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  liveEventChipText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  logBox: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    padding: 10,
    backgroundColor: '#F9FAFB',
  },
  logLine: {
    fontSize: 12,
    color: '#374151',
    fontFamily: 'Menlo',
    paddingVertical: 2,
  },
  progressBox: {
    gap: 6,
    marginTop: 4,
  },
  progressLabel: {
    fontSize: 13,
    color: '#4B5563',
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E5E7EB',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#0F62FE',
  },
  progressIndeterminate: {
    width: '40%',
  },
  copyBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  copyBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  emptyCatalog: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 8,
  },
  selectedFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  },
});
