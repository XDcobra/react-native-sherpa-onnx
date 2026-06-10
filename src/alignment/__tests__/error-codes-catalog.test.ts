import fs from 'node:fs';
import path from 'node:path';

const ALIGNMENT_ERROR_CODES = [
  'ALIGNMENT_OPTIONS_INVALID',
  'ALIGNMENT_MODEL_PATH_INVALID',
  'ALIGNMENT_GRANULARITY_INVALID',
  'ALIGNMENT_ASR_HYPOTHESIS_MISSING',
  'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS',
  'ALIGNMENT_NOT_IMPLEMENTED',
  'ALIGNMENT_ENGINE_DESTROYED',
  'ALIGNMENT_LINKER_INPUT_INVALID',
  'ALIGNMENT_LINKER_FAILED',
  'ALIGNMENT_LINKER_NO_MAPPING',
  'ALIGNMENT_ANCHOR_OUT_OF_RANGE',
  'ALIGNMENT_NATIVE_ACCURATE_FAILED',
  'ALIGNMENT_FORCED_CTC_FAILED',
  'ALIGNMENT_FORCED_CTC_STUCK',
  'ALIGNMENT_MODEL_LOAD_FAILED',
  'ALIGNMENT_NATIVE_UNKNOWN',
  'OFFLINE_OOM',
] as const;

const ALIGNMENT_WARNING_CODES = [
  'ALIGNMENT_PARTIAL_COVERAGE',
  'ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT',
  'ALIGNMENT_ANCHOR_NO_PROGRESS',
  'ALIGNMENT_RESIDUAL_TOKENS_REMAINING',
] as const;

function collectTestFiles(dirPath: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(abs));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('alignment error catalog coverage', () => {
  it('references every documented alignment error code in sub-06', () => {
    const root = path.resolve(__dirname, '..');
    const testFiles = collectTestFiles(root).filter(
      (filePath) => !filePath.endsWith('error-codes-catalog.test.ts')
    );
    const corpus = testFiles
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    for (const code of ALIGNMENT_ERROR_CODES) {
      expect(corpus).toContain(code);
    }
  });

  it('references every documented alignment warning code in sub-06', () => {
    const root = path.resolve(__dirname, '..');
    const testFiles = collectTestFiles(root).filter(
      (filePath) => !filePath.endsWith('error-codes-catalog.test.ts')
    );
    const corpus = testFiles
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    for (const code of ALIGNMENT_WARNING_CODES) {
      expect(corpus).toContain(code);
    }
  });
});
