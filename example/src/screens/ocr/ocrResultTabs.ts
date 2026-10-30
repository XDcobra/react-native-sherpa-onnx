import type {
  OcrContent,
  OcrElement,
  OcrFamily,
  OcrRecognizeResult,
} from 'react-native-sherpa-onnx/ocr';
import type { TextSpatialSpan } from 'react-native-sherpa-onnx/textbuffer';

/**
 * Result-box tabs. A tab is listed only when that run actually filled it.
 *
 * | Family / task | spans | text | content | raw | elements |
 * | --- | --- | --- | --- | --- | --- |
 * | ppocr / doctr | if boxes | plaintext | — | — | — |
 * | doc_vlm page | if locs | plaintext | markdown | doctags | if kinds |
 * | doc_vlm element/table | if locs | plaintext | markdown | doctags | if kinds |
 * | doc_vlm element/formula | if locs | plaintext | latex | doctags | if kinds |
 * | doc_vlm element/code | if locs | plaintext | code | doctags | if kinds |
 * | doc_vlm regionText | — | plaintext | plain | stream | — |
 * | doc_vlm identifyElement | — | plaintext | plain | stream | — |
 * | nemotron_parse page | — | plaintext | markdown | markup | — |
 * | paddleocr_vl ocr/table/chart | — | plaintext | markdown | stream | — |
 * | paddleocr_vl formula | — | plaintext | latex | stream | — |
 * | paddleocr_vl seal | — | plaintext | plain | stream | — |
 * | paddleocr_vl spotting | instance boxes | plaintext | plain | stream | — |
 * | PDF textLayer | glyph boxes | plaintext | — | — | — |
 *
 * Default: box-first (ppocr / doctr / spotting / textLayer) → spans, else text.
 * Everyone else → content, else text, else raw.
 */
export type OcrResultTab = 'spans' | 'text' | 'content' | 'raw' | 'elements';

export type OcrResultOrigin = 'ocr' | 'textLayer';

export function hasVlmRecognizeExtras(
  result: OcrRecognizeResult | null
): result is Extract<
  OcrRecognizeResult,
  { family: 'doc_vlm' | 'nemotron_parse' | 'paddleocr_vl' }
> {
  return (
    result?.family === 'doc_vlm' ||
    result?.family === 'nemotron_parse' ||
    result?.family === 'paddleocr_vl'
  );
}

export function collectOcrResultTabs(input: {
  origin: OcrResultOrigin | null;
  resultText: string;
  spans: readonly TextSpatialSpan[];
  content?: OcrContent | null;
  raw?: string;
  elements?: readonly OcrElement[];
  /** VLM recognize always exposes Raw, including empty / invalid_sequence. */
  includeRawTab?: boolean;
}): OcrResultTab[] {
  const tabs: OcrResultTab[] = [];
  if (input.spans.length > 0) tabs.push('spans');
  if (input.resultText.length > 0) tabs.push('text');
  if ((input.content?.value.length ?? 0) > 0) tabs.push('content');
  if ((input.raw?.length ?? 0) > 0 || input.includeRawTab) tabs.push('raw');
  if ((input.elements?.length ?? 0) > 0) tabs.push('elements');
  return tabs;
}

export function pickDefaultOcrResultTab(input: {
  origin: OcrResultOrigin | null;
  family?: OcrFamily | null;
  paddleocrVlTask?: string;
  incomplete?: boolean;
  tabs: readonly OcrResultTab[];
}): OcrResultTab {
  const tabs = input.tabs;
  if (tabs.length === 0) return 'text';
  const prefer = (...order: OcrResultTab[]): OcrResultTab => {
    for (const id of order) {
      if (tabs.includes(id)) return id;
    }
    return tabs[0] ?? 'text';
  };
  if (input.incomplete) {
    return prefer('raw', 'content', 'text', 'elements', 'spans');
  }
  const boxFirst =
    input.origin === 'textLayer' ||
    input.family === 'ppocr' ||
    input.family === 'doctr' ||
    (input.family === 'paddleocr_vl' && input.paddleocrVlTask === 'spotting');
  if (boxFirst) {
    return prefer('spans', 'text', 'content', 'raw');
  }
  return prefer('content', 'text', 'raw', 'elements', 'spans');
}

export function formatOcrElements(elements: readonly OcrElement[]): string {
  return elements
    .map((el, i) => {
      const range =
        el.utf16Start != null && el.utf16End != null
          ? ` utf16=${el.utf16Start}-${el.utf16End}`
          : '';
      return `#${i} ${el.kind} frame=${el.frameIndex}${range}`;
    })
    .join('\n');
}
