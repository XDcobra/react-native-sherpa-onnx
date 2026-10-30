import {
  decodeOcrRecognizeSpec,
  encodeOcrRecognizeSpec,
} from '../ocrRecognizeSpec';
import { OCR_DEFAULT_INSTRUCTIONS, OcrErrorCode } from '../types';

describe('ocrRecognizeSpec', () => {
  it('round-trips paddle spotting + crop', () => {
    const spec = encodeOcrRecognizeSpec('paddleocr_vl', {
      instruction: { task: 'spotting' },
      crop: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(spec).toBe(
      'v1;family=paddleocr_vl;task=spotting;cx=0;cy=0;cw=800;ch=600'
    );
    const decoded = decodeOcrRecognizeSpec(spec);
    expect(decoded.family).toBe('paddleocr_vl');
    expect(decoded.instruction).toEqual({ task: 'spotting' });
    expect(decoded.crop).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('encodes family defaults when instruction is omitted', () => {
    expect(encodeOcrRecognizeSpec('doc_vlm')).toBe(
      'v1;family=doc_vlm;task=page'
    );
    expect(encodeOcrRecognizeSpec('nemotron_parse')).toBe(
      'v1;family=nemotron_parse;task=page;text=markdown;layout=none;pic=1'
    );
    expect(encodeOcrRecognizeSpec('paddleocr_vl')).toBe(
      'v1;family=paddleocr_vl;task=ocr'
    );
    expect(encodeOcrRecognizeSpec('ppocr')).toBe('v1;family=ppocr');
    expect(OCR_DEFAULT_INSTRUCTIONS.nemotron_parse.output).toEqual({
      text: 'markdown',
      layout: 'none',
      textInPictures: true,
    });
  });

  it('rejects crop + regionText', () => {
    expect(() =>
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: {
          task: 'regionText',
          region: { x: 1, y: 2, width: 3, height: 4 },
        },
        crop: { x: 0, y: 0, width: 10, height: 10 },
      })
    ).toThrow(
      expect.objectContaining({
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
        message: expect.stringMatching(/crop cannot combine/),
      })
    );
  });

  it('rejects crop + identifyElement', () => {
    expect(() =>
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: {
          task: 'identifyElement',
          region: { x: 1, y: 2, width: 3, height: 4 },
        },
        crop: { x: 0, y: 0, width: 10, height: 10 },
      })
    ).toThrow(
      expect.objectContaining({
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
        message: expect.stringMatching(/crop cannot combine/),
      })
    );
  });

  it('encodes paddle table/formula/chart/seal tasks', () => {
    expect(
      encodeOcrRecognizeSpec('paddleocr_vl', { instruction: { task: 'table' } })
    ).toBe('v1;family=paddleocr_vl;task=table');
    expect(
      encodeOcrRecognizeSpec('paddleocr_vl', { instruction: { task: 'chart' } })
    ).toBe('v1;family=paddleocr_vl;task=chart');
    expect(
      encodeOcrRecognizeSpec('paddleocr_vl', { instruction: { task: 'seal' } })
    ).toBe('v1;family=paddleocr_vl;task=seal');
    expect(
      encodeOcrRecognizeSpec('paddleocr_vl', {
        instruction: { task: 'formula' },
      })
    ).toBe('v1;family=paddleocr_vl;task=formula');
  });

  it('encodes granite element and region tasks', () => {
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'element', element: 'table' },
      })
    ).toBe('v1;family=doc_vlm;task=element;element=table');
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'element', element: 'formula' },
      })
    ).toBe('v1;family=doc_vlm;task=element;element=formula');
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: {
          task: 'regionText',
          region: { x: 48, y: 55, width: 452, height: 33 },
        },
      })
    ).toBe('v1;family=doc_vlm;task=regionText;rx=48;ry=55;rw=452;rh=33');
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: {
          task: 'identifyElement',
          region: { x: 48, y: 55, width: 452, height: 33 },
        },
      })
    ).toBe('v1;family=doc_vlm;task=identifyElement;rx=48;ry=55;rw=452;rh=33');
  });

  it('rejects tasks not in capabilities.tasks', () => {
    expect(() =>
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'query' as 'page' },
      })
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
  });

  it('rejects granite chart that failed the Phase 0 grammar gate', () => {
    expect(() =>
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'element', element: 'chart' },
      } as never)
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
    expect(() =>
      decodeOcrRecognizeSpec('v1;family=doc_vlm;task=element;element=chart')
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
  });

  it('rejects nemotron profiles that failed the Phase 0 identity gate', () => {
    expect(() =>
      encodeOcrRecognizeSpec('nemotron_parse', {
        instruction: {
          task: 'page',
          output: {
            text: 'markdown',
            layout: 'boxesAndClasses',
            textInPictures: false,
          },
        } as never,
      })
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
    expect(() =>
      decodeOcrRecognizeSpec(
        'v1;family=nemotron_parse;task=page;text=markdown;layout=boxesAndClasses;pic=0'
      )
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
    expect(() =>
      decodeOcrRecognizeSpec(
        'v1;family=nemotron_parse;task=page;text=plain;layout=none;pic=1'
      )
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
  });

  it('encodes granite raw=full and omits the accepted default', () => {
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'page' },
        raw: 'full',
      })
    ).toBe('v1;family=doc_vlm;task=page;raw=full');
    expect(
      encodeOcrRecognizeSpec('doc_vlm', {
        instruction: { task: 'page' },
        raw: 'accepted',
      })
    ).toBe('v1;family=doc_vlm;task=page');
    expect(
      decodeOcrRecognizeSpec('v1;family=doc_vlm;task=page;raw=full').raw
    ).toBe('full');
  });

  it('rejects raw on ppocr', () => {
    expect(() =>
      encodeOcrRecognizeSpec('ppocr', { raw: 'full' } as never)
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
    expect(() => decodeOcrRecognizeSpec('v1;family=ppocr;raw=full')).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
  });

  it('rejects instruction keys on ppocr', () => {
    expect(() =>
      encodeOcrRecognizeSpec('ppocr', {
        instruction: { task: 'ocr' },
      } as never)
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INSTRUCTION_UNSUPPORTED })
    );
  });

  it('rejects unknown, duplicate, missing, and non-integer fields', () => {
    expect(() => decodeOcrRecognizeSpec('v2;family=ppocr')).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INVALID_RECOGNIZE_SPEC })
    );
    expect(() =>
      decodeOcrRecognizeSpec('v1;family=paddleocr_vl;task=ocr;task=spotting')
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INVALID_RECOGNIZE_SPEC })
    );
    expect(() =>
      decodeOcrRecognizeSpec('v1;family=paddleocr_vl;foo=1')
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INVALID_RECOGNIZE_SPEC })
    );
    expect(() => decodeOcrRecognizeSpec('v1;task=ocr')).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INVALID_RECOGNIZE_SPEC })
    );
    expect(() =>
      decodeOcrRecognizeSpec('v1;family=paddleocr_vl;cx=1.5;cy=0;cw=1;ch=1')
    ).toThrow(
      expect.objectContaining({ code: OcrErrorCode.INVALID_RECOGNIZE_SPEC })
    );
  });
});
