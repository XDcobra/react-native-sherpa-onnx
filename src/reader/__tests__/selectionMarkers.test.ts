jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
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
  markerHitSlop,
  markerSpecFor,
  nextMarkerWindow,
  selectionMenuItemSpecFor,
  tapFromNative,
} from '../ReaderView';

describe('markerSpecFor', () => {
  it('flattens a block marker', () => {
    expect(markerSpecFor({ id: 'm1', blockId: 's0.b1' })).toEqual({
      id: 'm1',
      blockId: 's0.b1',
      start: -1,
      end: -1,
    });
  });

  it('keeps the range (truncated) and leaves accessibility to JS', () => {
    expect(
      markerSpecFor({
        id: 'm2',
        blockId: 's0.b2',
        start: 4.7,
        end: 12,
        accessibilityLabel: '2 notes',
      })
    ).toEqual({ id: 'm2', blockId: 's0.b2', start: 4, end: 12 });
  });

  it('drops negative offsets', () => {
    const spec = markerSpecFor({ id: 'm3', blockId: 's0.b3', start: -5 });
    expect(spec.start).toBe(-1);
    expect(spec.end).toBe(-1);
  });
});

describe('nextMarkerWindow', () => {
  const known = new Set(['a', 'b', 'c', 'd', 'e', 'f']);

  it('mounts what the native window asks for, in its order', () => {
    expect(nextMarkerWindow([], ['c', 'a'], known)).toEqual(['c', 'a']);
  });

  it('keeps recently mounted markers as a buffer', () => {
    expect(nextMarkerWindow(['a', 'b'], ['c'], known)).toEqual(['c', 'a', 'b']);
  });

  it('caps the buffer, dropping the least recently requested', () => {
    expect(nextMarkerWindow(['b', 'c', 'd', 'e'], ['a'], known, 2)).toEqual([
      'a',
      'b',
      'c',
    ]);
    // Scrolling on: the oldest leave first, the window always stays.
    let mounted: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      mounted = nextMarkerWindow(mounted, [id], known, 2);
    }
    expect(mounted).toEqual(['f', 'e', 'd']);
  });

  it('drops IDs that are no longer markers and ignores duplicates', () => {
    expect(
      nextMarkerWindow(['gone', 'a'], ['b', 'b', 'unknown'], known)
    ).toEqual(['b', 'a']);
  });

  it('returns the previous array when nothing changed (no re-render)', () => {
    const prev = ['a', 'b'];
    expect(nextMarkerWindow(prev, ['a', 'b'], known)).toBe(prev);
    expect(nextMarkerWindow(prev, ['a'], known)).toBe(prev);
  });

  it('can unmount everything', () => {
    expect(nextMarkerWindow(['a', 'b'], [], known, 0)).toEqual([]);
    expect(nextMarkerWindow(['a', 'b'], [], new Set())).toEqual([]);
  });
});

describe('markerHitSlop', () => {
  it('grows small views to the minimum target', () => {
    expect(markerHitSlop(24, 20, 44)).toEqual({
      top: 12,
      bottom: 12,
      left: 10,
      right: 10,
    });
    expect(markerHitSlop(60, 30, 44)).toEqual({
      top: 7,
      bottom: 7,
      left: 0,
      right: 0,
    });
  });

  it('needs no slop for large views', () => {
    expect(markerHitSlop(48, 48, 44)).toBeUndefined();
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
