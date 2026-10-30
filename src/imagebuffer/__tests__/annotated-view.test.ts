jest.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (input: unknown) => {
      const out: Record<string, unknown> = {};
      const stack = Array.isArray(input) ? [...input] : [input];
      while (stack.length > 0) {
        const item = stack.shift();
        if (item == null || item === false) continue;
        if (Array.isArray(item)) {
          stack.unshift(...item);
        } else if (typeof item === 'object') {
          Object.assign(out, item);
        }
      }
      return out;
    },
    absoluteFillObject: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
  },
  View: 'View',
  TouchableOpacity: 'TouchableOpacity',
  requireNativeComponent: jest.fn(() => 'OfflineImageBufferFrameView'),
  NativeModules: { SherpaOnnx: {} },
  Platform: { OS: 'ios' },
  NativeEventEmitter: class {
    addListener(): { remove: () => void } {
      return { remove() {} };
    }
  },
  TurboModuleRegistry: {
    getEnforcing: () => ({}),
  },
}));

jest.mock('../../textbuffer', () => ({
  getOfflineTextBufferSpatialSpansSlice: jest.fn(),
  getPipelineTextBufferInfo: jest.fn(),
}));

jest.mock('../getFrameInfo', () => ({
  getOfflineImageBufferFrameInfo: jest.fn(),
}));

import type { MappedTextSpatialSpan } from '../mapToFrame';
import type { TextSpatialSpan } from '../../textbuffer/types';
import {
  computeAnnotatedFrameLayout,
  isAnnotatedSpanSelected,
  resolveAnnotatedBoxStyle,
} from '../OfflineImageBufferAnnotatedView';

function row(
  index: number,
  span: Pick<TextSpatialSpan, 'utf16Start' | 'utf16End'>
): Pick<MappedTextSpatialSpan, 'index' | 'span'> {
  return {
    index,
    span: {
      utf16Start: span.utf16Start,
      utf16End: span.utf16End,
      level: 'line',
      frameIndex: 0,
      origin: 'ocr',
      quad: [0, 0, 1, 0, 1, 1, 0, 1],
    },
  };
}

describe('computeAnnotatedFrameLayout', () => {
  const frame = { width: 100, height: 200 };

  it('returns null when layout or frame is empty', () => {
    expect(
      computeAnnotatedFrameLayout({ width: 0, height: 280 }, frame, 'contain')
    ).toBeNull();
    expect(
      computeAnnotatedFrameLayout(
        { width: 200, height: 200 },
        { width: 0, height: 10 },
        'contain'
      )
    ).toBeNull();
  });

  it('letterboxes contain', () => {
    const layout = computeAnnotatedFrameLayout(
      { width: 200, height: 200 },
      frame,
      'contain'
    );
    expect(layout).toEqual({
      scaleX: 1,
      scaleY: 1,
      offsetX: 50,
      offsetY: 0,
    });
  });

  it('fills and clips cover', () => {
    const layout = computeAnnotatedFrameLayout(
      { width: 200, height: 200 },
      frame,
      'cover'
    );
    expect(layout).toEqual({
      scaleX: 2,
      scaleY: 2,
      offsetX: 0,
      offsetY: -100,
    });
  });

  it('uses independent axes for stretch', () => {
    const layout = computeAnnotatedFrameLayout(
      { width: 200, height: 100 },
      frame,
      'stretch'
    );
    expect(layout).toEqual({
      scaleX: 2,
      scaleY: 0.5,
      offsetX: 0,
      offsetY: 0,
    });
  });
});

describe('isAnnotatedSpanSelected', () => {
  const first = row(2, { utf16Start: 10, utf16End: 16 });

  it('matches selectedIndex', () => {
    expect(isAnnotatedSpanSelected(first, 2, null)).toBe(true);
    expect(isAnnotatedSpanSelected(first, 1, null)).toBe(false);
  });

  it('matches overlapping selectedRange', () => {
    expect(
      isAnnotatedSpanSelected(first, null, { utf16Start: 12, utf16End: 20 })
    ).toBe(true);
    expect(
      isAnnotatedSpanSelected(first, null, { utf16Start: 16, utf16End: 20 })
    ).toBe(false);
    expect(
      isAnnotatedSpanSelected(first, null, { utf16Start: 0, utf16End: 10 })
    ).toBe(false);
  });

  it('ignores empty or inverted ranges', () => {
    expect(
      isAnnotatedSpanSelected(first, null, { utf16Start: 10, utf16End: 10 })
    ).toBe(false);
    expect(
      isAnnotatedSpanSelected(first, null, { utf16Start: 16, utf16End: 10 })
    ).toBe(false);
  });
});

describe('resolveAnnotatedBoxStyle', () => {
  it('merges default → box → origin → selected', () => {
    const style = resolveAnnotatedBoxStyle(
      'textLayer',
      true,
      { borderWidth: 3, backgroundColor: 'rgba(0, 0, 0, 0.1)' },
      { borderColor: '#111111' },
      {
        textLayer: { borderColor: '#34C759' },
        ocr: { borderColor: '#007AFF' },
      }
    );
    expect(style.borderWidth).toBe(3);
    expect(style.backgroundColor).toBe('rgba(255, 59, 48, 0.45)');
    expect(style.borderColor).toBe('#111111');
    expect(style).not.toHaveProperty('left');
    expect(style).not.toHaveProperty('width');
    expect(style).not.toHaveProperty('position');
  });

  it('drops consumer geometry so the view keeps box placement', () => {
    const style = resolveAnnotatedBoxStyle('ocr', false, {
      left: 99,
      top: 99,
      width: 9,
      height: 9,
      position: 'relative',
      borderColor: '#000000',
    });
    expect(style.borderColor).toBe('#000000');
    expect(style.left).toBeUndefined();
    expect(style.width).toBeUndefined();
    expect(style.position).toBeUndefined();
  });
});
