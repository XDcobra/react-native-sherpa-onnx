jest.mock('react-native', () => ({
  processColor: (c: unknown) =>
    c === '#FF0000'
      ? 0xffff0000
      : c === '#FFFFFF'
      ? 0xffffffff
      : c === 'semantic'
      ? { semantic: ['labelColor'] }
      : null,
  StyleSheet: { create: (s: unknown) => s },
  codegenNativeComponent: () => 'SherpaReaderView',
  codegenNativeCommands: () => ({
    scrollToLocator: jest.fn(),
    resumeFollow: jest.fn(),
  }),
}));

jest.mock('../SherpaReaderInsertViewNativeComponent', () => 'Insert');

import {
  markerSpecFor,
  selectionMenuItemSpecFor,
  tapFromNative,
} from '../ReaderView';

describe('markerSpecFor', () => {
  it('flattens a block marker with defaults', () => {
    expect(markerSpecFor({ id: 'm1', blockId: 's0.b1', label: '3' })).toEqual({
      id: 'm1',
      blockId: 's0.b1',
      start: -1,
      end: -1,
      label: '3',
      accessibilityLabel: '',
      color: 0,
      hasColor: false,
      textColor: 0,
      hasTextColor: false,
    });
  });

  it('keeps the range and resolves colors to signed ARGB ints', () => {
    expect(
      markerSpecFor({
        id: 'm2',
        blockId: 's0.b2',
        start: 4.7,
        end: 12,
        label: '•',
        accessibilityLabel: '2 notes',
        color: '#FF0000',
        textColor: '#FFFFFF',
      })
    ).toEqual({
      id: 'm2',
      blockId: 's0.b2',
      start: 4,
      end: 12,
      label: '•',
      accessibilityLabel: '2 notes',
      color: 0xffff0000 - 0x100000000,
      hasColor: true,
      textColor: -1,
      hasTextColor: true,
    });
  });

  it('drops negative offsets and colors processColor cannot flatten', () => {
    const spec = markerSpecFor({
      id: 'm3',
      blockId: 's0.b3',
      start: -5,
      label: 'x',
      color: 'semantic',
    });
    expect(spec.start).toBe(-1);
    expect(spec.end).toBe(-1);
    expect(spec.hasColor).toBe(false);
  });
});

describe('selectionMenuItemSpecFor', () => {
  it('defaults the symbol to an empty string', () => {
    expect(selectionMenuItemSpecFor({ id: 'note', title: 'Note' })).toEqual({
      id: 'note',
      title: 'Note',
      systemImage: '',
    });
    expect(
      selectionMenuItemSpecFor({
        id: 'note',
        title: 'Note',
        systemImage: 'text.bubble',
      }).systemImage
    ).toBe('text.bubble');
  });
});

describe('tapFromNative', () => {
  it('reports the offset only on text rows', () => {
    expect(tapFromNative({ blockId: 's0.b1', offset: 7 })).toEqual({
      blockId: 's0.b1',
      offset: 7,
    });
    expect(tapFromNative({ blockId: 's0.b4', offset: -1 })).toEqual({
      blockId: 's0.b4',
    });
  });
});
