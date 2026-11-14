jest.mock('react-native', () => ({
  processColor: (c: unknown) =>
    c === '#FF0000'
      ? 0xffff0000
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

import { highlightSpecFor } from '../ReaderView';

describe('highlightSpecFor', () => {
  it('flattens locators and defaults', () => {
    expect(
      highlightSpecFor({
        id: 'sentence',
        from: { sectionId: 's0', blockId: 's0.b1', offset: 4 },
        to: { sectionId: 's0', blockId: 's0.b2' },
      })
    ).toEqual({
      id: 'sentence',
      fromBlockId: 's0.b1',
      fromOffset: 4,
      toBlockId: 's0.b2',
      toOffset: -1,
      style: 'background',
      color: 0,
      hasColor: false,
      follow: false,
    });
  });

  it('passes ARGB colors as signed 32-bit ints', () => {
    const spec = highlightSpecFor({
      id: 'w',
      from: { sectionId: 's0', blockId: 's0.b1', offset: 0 },
      to: { sectionId: 's0', blockId: 's0.b1', offset: 3 },
      style: 'underline',
      color: '#FF0000',
      follow: true,
    });
    expect(spec.color).toBe(0xffff0000 - 0x100000000);
    expect(spec.color).toBeLessThan(0);
    expect(spec.hasColor).toBe(true);
    expect(spec.style).toBe('underline');
    expect(spec.follow).toBe(true);
  });

  it('falls back to the accent for platform colors', () => {
    const spec = highlightSpecFor({
      id: 'x',
      from: { sectionId: 's0', blockId: 's0.b1' },
      to: { sectionId: 's0', blockId: 's0.b1' },
      color: 'semantic',
    });
    expect(spec.hasColor).toBe(false);
  });
});
