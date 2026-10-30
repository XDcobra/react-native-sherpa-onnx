/**
 * Compile-time contract for family-typed engines (plan §8). Checked by `tsc`.
 */
import { createOCR } from '../index';
import type {
  OcrEngine,
  OcrEngineOf,
  OcrNemotronParseInstruction,
  OcrNemotronParseOutput,
  OcrRecognizeResultOf,
  OcrTaskOf,
} from '../types';
import type { OfflineImageBufferIdSource } from '../../imagebuffer/types';
import type { OfflineTextBufferIdSource } from '../../textbuffer/types';

declare const img: OfflineImageBufferIdSource;
declare const txt: OfflineTextBufferIdSource;
declare const paddle: OcrEngineOf<'paddleocr_vl'>;
declare const granite: OcrEngineOf<'doc_vlm'>;
declare const ppocr: OcrEngineOf<'ppocr'>;
declare const engine: OcrEngine;

export async function ocrInstructionTypeChecks(): Promise<void> {
  await paddle.recognize(img, txt, { instruction: { task: 'spotting' } });
  await granite.recognize(img, txt, { instruction: { task: 'page' } });
  await granite.recognize(img, txt, {
    instruction: { task: 'element', element: 'table' },
  });
  await granite.recognize(img, txt, {
    instruction: {
      task: 'element',
      // @ts-expect-error Phase 0 lock: granite chart failed the grammar gate
      element: 'chart',
    },
  });
  await granite.recognize(img, txt, {
    instruction: {
      task: 'regionText',
      region: { x: 48, y: 55, width: 452, height: 33 },
    },
  });
  await ppocr.recognize(img, txt);

  // @ts-expect-error Paddle task is not valid on doc_vlm
  await granite.recognize(img, txt, { instruction: { task: 'ocr' } });

  // @ts-expect-error instruction is not a ppocr recognize option
  await ppocr.recognize(img, txt, { instruction: { task: 'ocr' } });

  // @ts-expect-error un-narrowed auto engine cannot take a family task
  await engine.recognize(img, txt, { instruction: { task: 'ocr' } });

  const _classesWithoutBoxes: OcrNemotronParseOutput = {
    text: 'markdown',
    // @ts-expect-error classes without boxes is unrepresentable
    layout: 'classes',
    textInPictures: true,
  };
  void _classesWithoutBoxes;

  const _gatedLayout: OcrNemotronParseOutput = {
    text: 'markdown',
    // @ts-expect-error Phase 0 lock: boxesAndClasses is not in the public union
    layout: 'boxesAndClasses',
    textInPictures: true,
  };
  void _gatedLayout;

  const acceptNemotron = (_i: OcrNemotronParseInstruction): void => {};
  acceptNemotron({
    task: 'page',
    // @ts-expect-error text none forbids layout none; also outside Phase 0 lock
    output: { text: 'none', layout: 'none', textInPictures: false },
  });

  if (engine.family === 'paddleocr_vl') {
    await engine.recognize(img, txt, { instruction: { task: 'spotting' } });
    const task: OcrTaskOf<'paddleocr_vl'> | undefined =
      engine.capabilities.tasks[0];
    void task;
  }

  const paddleResult: OcrRecognizeResultOf<'paddleocr_vl'> =
    await paddle.recognize(img, txt);
  const _raw: string = paddleResult.raw;
  const _value: string | undefined = paddleResult.content?.value;
  const _kind = paddleResult.elements[0]?.kind;
  const _task = paddleResult.instruction.task;
  void _raw;
  void _value;
  void _kind;
  void _task;

  const graniteResult: OcrRecognizeResultOf<'doc_vlm'> =
    await granite.recognize(img, txt, {
      instruction: { task: 'element', element: 'code' },
    });
  if (graniteResult.content?.format === 'code') {
    const _lang: string | null = graniteResult.content.language;
    void _lang;
  }
  if (graniteResult.content?.format === 'markdown') {
    // @ts-expect-error markdown content has no language field
    graniteResult.content.language;
  }

  const typed = await createOCR({
    modelType: 'paddleocr_vl',
    modelSource: { kind: 'fs', path: '/m' },
  });
  const _family: 'paddleocr_vl' = typed.family;
  void _family;
  await typed.recognize(img, txt, { instruction: { task: 'ocr' } });
}
