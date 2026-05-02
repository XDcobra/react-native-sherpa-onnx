import { StyleSheet } from 'react-native';

export const segStyles = StyleSheet.create({
  container: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d0d8e8',
    backgroundColor: '#f8f9fc',
    marginBottom: 12,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  headerLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#444',
    flex: 1,
  },
  modeTabs: {
    flexDirection: 'row',
    gap: 6,
  },
  modeTab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#c8d0df',
    backgroundColor: '#fff',
  },
  modeTabActive: {
    borderColor: '#007AFF',
    backgroundColor: '#007AFF',
  },
  modeTabDisabled: {
    opacity: 0.4,
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#555',
  },
  modeTabTextActive: {
    color: '#fff',
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowLabel: {
    fontSize: 13,
    color: '#555',
    flex: 1,
  },
  evaluatorScroll: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  evaluatorChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#c8d0df',
    backgroundColor: '#fff',
  },
  evaluatorChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#e8f0ff',
  },
  evaluatorChipDisabled: {
    opacity: 0.4,
  },
  evaluatorChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#555',
  },
  evaluatorChipTextActive: {
    color: '#1a55cc',
  },
  fieldGroup: {
    gap: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    color: '#666',
    flex: 1,
  },
  fieldInput: {
    width: 80,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#c8d0df',
    backgroundColor: '#fff',
    fontSize: 13,
    textAlign: 'right',
    color: '#222',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkboxLabel: {
    fontSize: 12,
    color: '#666',
    flex: 1,
  },
  noteText: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
  },
  vadWarningBox: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fff8e6',
    borderWidth: 1,
    borderColor: '#ffe0b2',
    marginBottom: 8,
  },
  vadWarningText: {
    fontSize: 12,
    color: '#b71c1c',
    lineHeight: 18,
  },
  vadModelScroll: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  vadModelChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c8d0df',
    backgroundColor: '#fff',
    maxWidth: '100%',
  },
  vadModelChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#e8f0ff',
  },
  vadModelChipTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  vadModelChipId: {
    fontSize: 10,
    color: '#888',
    marginTop: 2,
  },
  vadRecommendedBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#e3f2fd',
  },
  vadRecommendedBadgeText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#1565c0',
  },
  vadErrorText: {
    fontSize: 12,
    color: '#b71c1c',
    marginBottom: 6,
  },
  vadOkText: {
    fontSize: 11,
    color: '#2e7d32',
    marginBottom: 6,
  },
  vadLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: '#e0e6f0',
    marginVertical: 4,
  },
});
