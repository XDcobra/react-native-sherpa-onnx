#!/usr/bin/env node
/**
 * Regenerate model language catalog artifacts and fail if the tree is dirty.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const TRACKED = [
  'android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h',
  'src/model-languages/generated/catalog.ts',
];

execSync('node scripts/generate-model-language-catalog.mjs', {
  cwd: ROOT,
  stdio: 'inherit',
});

for (const rel of TRACKED) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.error(`Missing generated file: ${rel}`);
    process.exit(1);
  }
}

const dirty = execSync(`git status --porcelain -- ${TRACKED.join(' ')}`, {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();

if (dirty) {
  console.error('Generated model language catalog files are out of date. Run:');
  console.error('  yarn generate:model-language-catalog');
  console.error('\nDiff:\n' + dirty);
  process.exit(1);
}

console.log('Model language catalog artifacts are up to date.');
