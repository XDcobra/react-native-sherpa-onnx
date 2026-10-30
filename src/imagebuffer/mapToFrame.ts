import type { TextSpatialSpan } from '../textbuffer/types';

export type MapTextSpatialSpansToFrameOrigin = 'ocr' | 'textLayer';

export type MapTextSpatialSpansToFrameOptions = {
  frameIndex: number;
  frameWidth: number;
  frameHeight: number;
  /** Default: both `ocr` and `textLayer`. */
  origins?: MapTextSpatialSpansToFrameOrigin[];
};

export type MappedTextSpatialSpan = {
  /** Index in the input `spans` array. */
  index: number;
  span: TextSpatialSpan;
  /** Quad in decoded ImageBuffer frame pixels. */
  quad: TextSpatialSpan['quad'];
};

function scaleQuad(
  quad: TextSpatialSpan['quad'],
  sx: number,
  sy: number
): TextSpatialSpan['quad'] {
  return [
    quad[0] * sx,
    quad[1] * sy,
    quad[2] * sx,
    quad[3] * sy,
    quad[4] * sx,
    quad[5] * sy,
    quad[6] * sx,
    quad[7] * sy,
  ];
}

/**
 * Project spatial spans onto one decoded ImageBuffer frame.
 *
 * - `ocr`: quad already in frame pixels (pass through).
 * - `textLayer`: scale PDF user-space by frameSize / pageSize (skip if page size missing).
 * - `markup` and other origins: skipped.
 */
export function mapTextSpatialSpansToFrame(
  spans: TextSpatialSpan[],
  options: MapTextSpatialSpansToFrameOptions
): MappedTextSpatialSpan[] {
  const frameIndex = Math.trunc(options.frameIndex);
  const frameWidth = options.frameWidth;
  const frameHeight = options.frameHeight;
  const allowed = new Set<MapTextSpatialSpansToFrameOrigin>(
    options.origins ?? ['ocr', 'textLayer']
  );

  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return [];
  }

  const out: MappedTextSpatialSpan[] = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    if (span.frameIndex !== frameIndex) continue;
    if (span.origin === 'ocr') {
      if (!allowed.has('ocr')) continue;
      out.push({ index, span, quad: span.quad });
      continue;
    }
    if (span.origin === 'textLayer') {
      if (!allowed.has('textLayer')) continue;
      const pageWidth = span.pageWidth;
      const pageHeight = span.pageHeight;
      if (
        pageWidth == null ||
        pageHeight == null ||
        !Number.isFinite(pageWidth) ||
        !Number.isFinite(pageHeight) ||
        pageWidth <= 0 ||
        pageHeight <= 0
      ) {
        continue;
      }
      out.push({
        index,
        span,
        quad: scaleQuad(
          span.quad,
          frameWidth / pageWidth,
          frameHeight / pageHeight
        ),
      });
    }
  }
  return out;
}
