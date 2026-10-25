import { mapTextSpatialSpansToFrame } from '../mapToFrame';
import type { TextSpatialSpan } from '../../textbuffer/types';

function span(
  partial: Partial<TextSpatialSpan> &
    Pick<TextSpatialSpan, 'origin' | 'frameIndex' | 'quad'>
): TextSpatialSpan {
  return {
    utf16Start: 0,
    utf16End: 4,
    level: 'line',
    ...partial,
  };
}

const ocrQuad: TextSpatialSpan['quad'] = [10, 20, 110, 20, 110, 40, 10, 40];
const pdfQuad: TextSpatialSpan['quad'] = [72, 48, 310, 48, 310, 78, 72, 78];

describe('mapTextSpatialSpansToFrame', () => {
  it('passes ocr quads through in frame pixels', () => {
    const spans = [span({ origin: 'ocr', frameIndex: 0, quad: ocrQuad })];
    const mapped = mapTextSpatialSpansToFrame(spans, {
      frameIndex: 0,
      frameWidth: 1224,
      frameHeight: 1584,
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.index).toBe(0);
    expect(mapped[0]!.quad).toEqual(ocrQuad);
  });

  it('scales textLayer quads by frame / page size', () => {
    const spans = [
      span({
        origin: 'textLayer',
        frameIndex: 0,
        quad: pdfQuad,
        pageWidth: 612,
        pageHeight: 792,
      }),
    ];
    const mapped = mapTextSpatialSpansToFrame(spans, {
      frameIndex: 0,
      frameWidth: 1224,
      frameHeight: 1584,
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.quad).toEqual([144, 96, 620, 96, 620, 156, 144, 156]);
  });

  it('skips spans on other frames', () => {
    const spans = [
      span({ origin: 'ocr', frameIndex: 1, quad: ocrQuad }),
      span({
        origin: 'textLayer',
        frameIndex: 2,
        quad: pdfQuad,
        pageWidth: 612,
        pageHeight: 792,
      }),
    ];
    expect(
      mapTextSpatialSpansToFrame(spans, {
        frameIndex: 0,
        frameWidth: 100,
        frameHeight: 100,
      })
    ).toEqual([]);
  });

  it('skips textLayer without a usable page size', () => {
    const spans = [
      span({ origin: 'textLayer', frameIndex: 0, quad: pdfQuad }),
      span({
        origin: 'textLayer',
        frameIndex: 0,
        quad: pdfQuad,
        pageWidth: 0,
        pageHeight: 792,
      }),
    ];
    expect(
      mapTextSpatialSpansToFrame(spans, {
        frameIndex: 0,
        frameWidth: 1224,
        frameHeight: 1584,
      })
    ).toEqual([]);
  });

  it('filters by origins', () => {
    const spans = [
      span({ origin: 'ocr', frameIndex: 0, quad: ocrQuad }),
      span({
        origin: 'textLayer',
        frameIndex: 0,
        quad: pdfQuad,
        pageWidth: 612,
        pageHeight: 792,
      }),
      span({ origin: 'markup', frameIndex: 0, quad: ocrQuad }),
    ];
    const ocrOnly = mapTextSpatialSpansToFrame(spans, {
      frameIndex: 0,
      frameWidth: 1224,
      frameHeight: 1584,
      origins: ['ocr'],
    });
    expect(ocrOnly).toHaveLength(1);
    expect(ocrOnly[0]!.span.origin).toBe('ocr');

    const layerOnly = mapTextSpatialSpansToFrame(spans, {
      frameIndex: 0,
      frameWidth: 1224,
      frameHeight: 1584,
      origins: ['textLayer'],
    });
    expect(layerOnly).toHaveLength(1);
    expect(layerOnly[0]!.span.origin).toBe('textLayer');
  });

  it('returns empty when frame size is invalid', () => {
    expect(
      mapTextSpatialSpansToFrame(
        [span({ origin: 'ocr', frameIndex: 0, quad: ocrQuad })],
        { frameIndex: 0, frameWidth: 0, frameHeight: 100 }
      )
    ).toEqual([]);
  });
});
