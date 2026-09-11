import { StyleSheet } from 'react-native';

export const SPEAKER_COLORS = [
  '#2563EB', // Speaker 0: Vibrant Blue
  '#059669', // Speaker 1: Emerald Green
  '#D97706', // Speaker 2: Amber Orange
  '#7C3AED', // Speaker 3: Violet Purple
  '#DC2626', // Speaker 4: Crimson Red
  '#0891B2', // Speaker 5: Cyan
  '#EA580C', // Speaker 6: Rust Orange
  '#4F46E5', // Speaker 7: Indigo
] as const;

export const SPEAKER_BG_COLORS = [
  '#EFF6FF', // Light blue
  '#ECFDF5', // Light green
  '#FFFBEB', // Light amber
  '#F5F3FF', // Light violet
  '#FEF2F2', // Light red
  '#ECFEFF', // Light cyan
  '#FFF7ED', // Light orange
  '#EEF2FF', // Light indigo
] as const;

export const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
    gap: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    flexShrink: 1,
    marginRight: 8,
  },
  cardSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
    marginBottom: 12,
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
    marginTop: 10,
    marginBottom: 6,
  },
  toggleChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  toggleChip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  toggleChipActive: {
    backgroundColor: '#0F62FE',
    borderColor: '#0F62FE',
  },
  toggleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  toggleChipTextActive: {
    color: '#FFFFFF',
  },
  primaryButton: {
    backgroundColor: '#0F62FE',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButton: {
    backgroundColor: '#F3F4F6',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  accentButton: {
    backgroundColor: '#059669',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  dangerButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButtonText: {
    color: '#374151',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  actionControlRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  flex1: {
    flex: 1,
  },
  paramRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  paramLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    flex: 1,
  },
  paramControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  paramValueBadge: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 48,
    alignItems: 'center',
  },
  paramValueText: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#111827',
  },
  paramStepButton: {
    backgroundColor: '#E5E7EB',
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paramStepButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#374151',
    lineHeight: 18,
  },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  metaBadge: {
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  metaBadgeLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  metaBadgeValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '700',
    marginTop: 1,
    fontFamily: 'monospace',
  },
  // Progress bar
  progressContainer: {
    marginTop: 12,
    marginBottom: 4,
  },
  progressLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  progressLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  progressSpinner: {
    marginRight: 2,
  },
  progressLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  progressPercent: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    color: '#0F62FE',
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#0F62FE',
    borderRadius: 4,
  },
  progressFillIndeterminate: {
    width: '35%',
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 4,
  },
  // Speakers HUD & Aliases
  speakerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  speakerCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#FAFAFA',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  speakerCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  speakerBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakerBadgeText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  speakerAliasInput: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    paddingVertical: 2,
    paddingHorizontal: 0,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    marginBottom: 6,
  },
  speakerStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  speakerStatLabel: {
    fontSize: 11,
    color: '#6B7280',
  },
  speakerStatValue: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
    fontFamily: 'monospace',
  },
  // Meeting Analytics & Airtime Bar
  airtimeBar: {
    height: 14,
    flexDirection: 'row',
    borderRadius: 7,
    overflow: 'hidden',
    backgroundColor: '#E5E7EB',
    marginVertical: 10,
  },
  airtimeSegment: {
    height: '100%',
  },
  airtimeEmptyBar: {
    flex: 1,
    backgroundColor: '#E5E7EB',
  },
  analyticsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  statBox: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  statBoxLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  statBoxValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginTop: 2,
  },
  // Timeline
  timelineFilterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  timelineList: {
    maxHeight: 280,
    marginTop: 4,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#F9FAFB',
    marginBottom: 6,
    borderLeftWidth: 4,
    borderLeftColor: '#0F62FE',
  },
  timelineSpeakerTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    marginRight: 10,
  },
  timelineSpeakerTagText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  timelineTimeInfo: {
    flex: 1,
  },
  timelineTimeRange: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    fontFamily: 'monospace',
  },
  timelineSampleRange: {
    fontSize: 11,
    color: '#6B7280',
    fontFamily: 'monospace',
    marginTop: 1,
  },
  timelineDurationBadge: {
    backgroundColor: '#E5E7EB',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  timelineDurationText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    fontFamily: 'monospace',
  },
  timelineConfidenceBadge: {
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 4,
  },
  timelineConfidenceText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
    fontFamily: 'monospace',
  },
  // Diagnostics
  statusBox: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  statusText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#38BDF8',
    lineHeight: 18,
  },
  statusDimText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#94A3B8',
    lineHeight: 16,
  },
  errorBox: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  errorText: {
    color: '#B91C1C',
    fontSize: 13,
    fontWeight: '600',
  },
  emptyNotice: {
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyNoticeText: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },
  marginTop10: {
    marginTop: 10,
  },
  marginTop12: {
    marginTop: 12,
  },
  tuningToggleLabel: {
    fontWeight: '700',
    color: '#0F62FE',
  },
  tuningSectionContent: {
    marginTop: 4,
    paddingBottom: 6,
  },
  copyButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  copyButtonText: {
    color: '#0F62FE',
    fontSize: 13,
    fontWeight: '600',
  },
  statusErrorText: {
    color: '#F87171',
  },
  eventsHeaderLabel: {
    marginTop: 12,
    fontWeight: '700',
  },
  eventLogContainer: {
    marginTop: 6,
    maxHeight: 180,
  },
  noModelsBanner: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    gap: 10,
  },
  noModelsText: {
    fontSize: 13,
    color: '#92400E',
    lineHeight: 18,
  },
  downloadLinkButton: {
    backgroundColor: '#D97706',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
  },
  downloadLinkText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
