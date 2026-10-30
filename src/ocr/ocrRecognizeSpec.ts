import type { OcrFamily } from './types';
import {
  OCR_CAPABILITIES,
  OCR_DEFAULT_INSTRUCTIONS,
  type OcrDocVlmInstruction,
  type OcrInstructionFamily,
  type OcrInstructionOf,
  type OcrNemotronParseInstruction,
  type OcrPaddleocrVlInstruction,
  type OcrPixelRect,
  type OcrRecognizeOptionsOf,
  type OcrVlmRawMode,
  OcrErrorCode,
} from './types';

export type OcrRecognizeSpecRequest = {
  family: OcrFamily;
  instruction:
    | OcrInstructionOf<'doc_vlm'>
    | OcrInstructionOf<'nemotron_parse'>
    | OcrInstructionOf<'paddleocr_vl'>
    | undefined;
  crop?: OcrPixelRect;
  raw?: OcrVlmRawMode;
};

function invalidSpec(message: string): never {
  throw Object.assign(new Error(message), {
    code: OcrErrorCode.INVALID_RECOGNIZE_SPEC,
  });
}

function isInt(n: number): boolean {
  return Number.isInteger(n) && Number.isFinite(n);
}

export function assertOcrPixelRect(
  rect: OcrPixelRect,
  label: string
): asserts rect is OcrPixelRect {
  if (
    !isInt(rect.x) ||
    !isInt(rect.y) ||
    !isInt(rect.width) ||
    !isInt(rect.height)
  ) {
    invalidSpec(`${label} coordinates must be integers`);
  }
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
    throw Object.assign(
      new Error(`${label} must have x,y>=0 and width,height>0`),
      { code: OcrErrorCode.INVALID_REGION }
    );
  }
}

function kv(parts: string[], key: string, value: string): void {
  parts.push(`${key}=${value}`);
}

function encodeCrop(parts: string[], crop: OcrPixelRect): void {
  assertOcrPixelRect(crop, 'crop');
  kv(parts, 'cx', String(Math.round(crop.x)));
  kv(parts, 'cy', String(Math.round(crop.y)));
  kv(parts, 'cw', String(Math.round(crop.width)));
  kv(parts, 'ch', String(Math.round(crop.height)));
}

function encodeDocVlm(
  parts: string[],
  instruction: OcrDocVlmInstruction
): void {
  kv(parts, 'task', instruction.task);
  if (instruction.task === 'element') {
    if ((instruction.element as string) === 'chart') {
      throw Object.assign(
        new Error(
          'doc_vlm element=chart did not pass the Phase 0 grammar gate'
        ),
        { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
      );
    }
    kv(parts, 'element', instruction.element);
  }
  if (
    instruction.task === 'regionText' ||
    instruction.task === 'identifyElement'
  ) {
    assertOcrPixelRect(instruction.region, 'region');
    kv(parts, 'rx', String(Math.round(instruction.region.x)));
    kv(parts, 'ry', String(Math.round(instruction.region.y)));
    kv(parts, 'rw', String(Math.round(instruction.region.width)));
    kv(parts, 'rh', String(Math.round(instruction.region.height)));
  }
}

function encodeNemotron(
  parts: string[],
  instruction: OcrNemotronParseInstruction
): void {
  kv(parts, 'task', 'page');
  kv(parts, 'text', instruction.output.text);
  kv(parts, 'layout', instruction.output.layout);
  kv(parts, 'pic', instruction.output.textInPictures ? '1' : '0');
}

function encodePaddle(
  parts: string[],
  instruction: OcrPaddleocrVlInstruction
): void {
  kv(parts, 'task', instruction.task);
}

export function encodeOcrRecognizeSpec<F extends OcrFamily>(
  family: F,
  options?: OcrRecognizeOptionsOf<F>
): string {
  const parts = ['v1', `family=${family}`];
  const crop = options?.crop;
  const instructionFamily = family as OcrInstructionFamily | OcrFamily;
  if (
    instructionFamily === 'doc_vlm' ||
    instructionFamily === 'nemotron_parse' ||
    instructionFamily === 'paddleocr_vl'
  ) {
    const typedOptions = options as OcrRecognizeOptionsOf<
      'doc_vlm' | 'nemotron_parse' | 'paddleocr_vl'
    >;
    const instruction =
      typedOptions?.instruction ?? OCR_DEFAULT_INSTRUCTIONS[instructionFamily];
    if (
      crop &&
      family === 'doc_vlm' &&
      typedOptions?.instruction &&
      (typedOptions.instruction.task === 'regionText' ||
        typedOptions.instruction.task === 'identifyElement')
    ) {
      throw Object.assign(
        new Error('crop cannot combine with regionText/identifyElement'),
        { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
      );
    }
    const allowedTasks = OCR_CAPABILITIES[instructionFamily]
      .tasks as readonly string[];
    if (!allowedTasks.includes(instruction.task)) {
      throw Object.assign(
        new Error(`instruction.task is not enabled: ${instruction.task}`),
        { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
      );
    }
    if (family === 'nemotron_parse') {
      const output = (instruction as OcrNemotronParseInstruction).output as {
        text: string;
        layout: string;
        textInPictures: boolean;
      };
      if (
        output.text !== 'markdown' ||
        output.layout !== 'none' ||
        output.textInPictures !== true
      ) {
        throw Object.assign(
          new Error(
            'nemotron_parse profile did not pass the Phase 0 identity gate'
          ),
          { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
        );
      }
    }
    if (family === 'doc_vlm') {
      encodeDocVlm(parts, instruction as OcrDocVlmInstruction);
    } else if (family === 'nemotron_parse') {
      encodeNemotron(parts, instruction as OcrNemotronParseInstruction);
    } else {
      encodePaddle(parts, instruction as OcrPaddleocrVlInstruction);
    }
  } else if (
    options &&
    'instruction' in options &&
    options.instruction !== undefined
  ) {
    throw Object.assign(new Error(`instruction is not valid for ${family}`), {
      code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
    });
  }
  if (crop) encodeCrop(parts, crop);
  const rawMode =
    options && 'raw' in options
      ? (options as { raw?: OcrVlmRawMode }).raw
      : undefined;
  if (rawMode !== undefined) {
    if (
      family !== 'doc_vlm' &&
      family !== 'nemotron_parse' &&
      family !== 'paddleocr_vl'
    ) {
      throw Object.assign(new Error(`raw is not valid for ${family}`), {
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
      });
    }
    if (rawMode !== 'accepted' && rawMode !== 'full') {
      invalidSpec(`raw must be accepted or full`);
    }
    if (rawMode === 'full') kv(parts, 'raw', 'full');
  }
  return parts.join(';');
}

function splitFields(spec: string): string[] {
  return spec.split(';');
}

function parseIntStrict(raw: string, key: string): number {
  if (!/^[+-]?\d+$/.test(raw)) {
    invalidSpec(`recognizeSpec ${key} is not an integer`);
  }
  return Number.parseInt(raw, 10);
}

export function decodeOcrRecognizeSpec(spec: string): OcrRecognizeSpecRequest {
  const parts = splitFields(spec);
  if (parts[0] !== 'v1') {
    invalidSpec('recognizeSpec must start with v1');
  }
  const kvMap = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 1) {
    const field = parts[i];
    if (!field) invalidSpec('empty recognizeSpec field');
    const eq = field.indexOf('=');
    if (eq <= 0) invalidSpec(`recognizeSpec field missing key=value: ${field}`);
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (kvMap.has(key)) invalidSpec(`duplicate recognizeSpec key: ${key}`);
    kvMap.set(key, value);
  }
  const known = new Set([
    'family',
    'task',
    'element',
    'rx',
    'ry',
    'rw',
    'rh',
    'text',
    'layout',
    'pic',
    'cx',
    'cy',
    'cw',
    'ch',
    'raw',
  ]);
  for (const key of kvMap.keys()) {
    if (!known.has(key)) invalidSpec(`unknown recognizeSpec key: ${key}`);
  }
  const family = kvMap.get('family');
  if (!family) invalidSpec('recognizeSpec missing family');
  if (
    family !== 'ppocr' &&
    family !== 'doctr' &&
    family !== 'doc_vlm' &&
    family !== 'nemotron_parse' &&
    family !== 'paddleocr_vl'
  ) {
    invalidSpec(`unknown family: ${family}`);
  }

  let crop: OcrPixelRect | undefined;
  if (
    kvMap.has('cx') ||
    kvMap.has('cy') ||
    kvMap.has('cw') ||
    kvMap.has('ch')
  ) {
    if (
      !kvMap.has('cx') ||
      !kvMap.has('cy') ||
      !kvMap.has('cw') ||
      !kvMap.has('ch')
    ) {
      invalidSpec('crop requires cx,cy,cw,ch');
    }
    crop = {
      x: parseIntStrict(kvMap.get('cx') as string, 'cx'),
      y: parseIntStrict(kvMap.get('cy') as string, 'cy'),
      width: parseIntStrict(kvMap.get('cw') as string, 'cw'),
      height: parseIntStrict(kvMap.get('ch') as string, 'ch'),
    };
    assertOcrPixelRect(crop, 'crop');
  }

  let raw: OcrVlmRawMode | undefined;
  if (kvMap.has('raw')) {
    const rawValue = kvMap.get('raw');
    if (rawValue !== 'accepted' && rawValue !== 'full') {
      invalidSpec('raw must be accepted or full');
    }
    raw = rawValue;
  }

  if (family === 'ppocr' || family === 'doctr') {
    if (
      kvMap.has('task') ||
      kvMap.has('element') ||
      kvMap.has('text') ||
      kvMap.has('layout') ||
      kvMap.has('pic') ||
      kvMap.has('rx') ||
      kvMap.has('raw')
    ) {
      throw Object.assign(new Error(`instruction is not valid for ${family}`), {
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
      });
    }
    return { family, instruction: undefined, crop };
  }

  if (family === 'doc_vlm') {
    const task = kvMap.get('task') ?? 'page';
    let instruction: OcrDocVlmInstruction;
    if (task === 'page') instruction = { task: 'page' };
    else if (task === 'element') {
      const element = kvMap.get('element');
      if (element === 'chart') {
        throw Object.assign(
          new Error(
            'doc_vlm element=chart did not pass the Phase 0 grammar gate'
          ),
          { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
        );
      }
      if (element !== 'table' && element !== 'formula' && element !== 'code') {
        throw Object.assign(new Error('unknown doc_vlm element'), {
          code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
        });
      }
      instruction = { task: 'element', element };
    } else if (task === 'regionText' || task === 'identifyElement') {
      if (
        !kvMap.has('rx') ||
        !kvMap.has('ry') ||
        !kvMap.has('rw') ||
        !kvMap.has('rh')
      ) {
        invalidSpec('region task requires rx,ry,rw,rh');
      }
      const region = {
        x: parseIntStrict(kvMap.get('rx') as string, 'rx'),
        y: parseIntStrict(kvMap.get('ry') as string, 'ry'),
        width: parseIntStrict(kvMap.get('rw') as string, 'rw'),
        height: parseIntStrict(kvMap.get('rh') as string, 'rh'),
      };
      assertOcrPixelRect(region, 'region');
      instruction =
        task === 'regionText'
          ? { task: 'regionText', region }
          : { task: 'identifyElement', region };
    } else {
      throw Object.assign(new Error(`unknown doc_vlm task: ${task}`), {
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
      });
    }
    return { family, instruction, crop, raw };
  }

  if (family === 'nemotron_parse') {
    const task = kvMap.get('task') ?? 'page';
    if (task !== 'page') {
      throw Object.assign(new Error('nemotron_parse task must be page'), {
        code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
      });
    }
    const text = kvMap.get('text') ?? 'markdown';
    const layout = kvMap.get('layout') ?? 'none';
    const picRaw = kvMap.get('pic') ?? '1';
    if (picRaw !== '0' && picRaw !== '1') invalidSpec('pic must be 0 or 1');
    if (text !== 'markdown' || layout !== 'none' || picRaw !== '1') {
      throw Object.assign(
        new Error(
          'nemotron_parse profile did not pass the Phase 0 identity gate'
        ),
        { code: OcrErrorCode.INSTRUCTION_UNSUPPORTED }
      );
    }
    const instruction: OcrNemotronParseInstruction = {
      task: 'page',
      output: { text: 'markdown', layout: 'none', textInPictures: true },
    };
    return { family, instruction, crop, raw };
  }

  const task = kvMap.get('task') ?? 'ocr';
  if (
    task !== 'ocr' &&
    task !== 'table' &&
    task !== 'formula' &&
    task !== 'chart' &&
    task !== 'seal' &&
    task !== 'spotting'
  ) {
    throw Object.assign(new Error(`unknown paddleocr_vl task: ${task}`), {
      code: OcrErrorCode.INSTRUCTION_UNSUPPORTED,
    });
  }
  const instruction: OcrPaddleocrVlInstruction = { task };
  return { family: 'paddleocr_vl', instruction, crop, raw };
}
