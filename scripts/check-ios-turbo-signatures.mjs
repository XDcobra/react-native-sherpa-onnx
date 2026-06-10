#!/usr/bin/env node
/**
 * Compare iOS TurboModule implementations (@implementation SherpaOnnx …)
 * against React Native codegen (NativeSherpaOnnxSpec in SherpaOnnxSpec.h).
 *
 * Any mismatch in method name, parameter name, parameter count, or parameter
 * type fails the check (TurboModule NSInvocation requires an exact match).
 *
 * Usage:
 *   node scripts/check-ios-turbo-signatures.mjs
 *   yarn check:ios-turbo-signatures
 *
 * SherpaOnnxSpec.h from Pods (after pod install) or from codegen:
 *   cd example && npx react-native codegen --platform ios --outputPath ../.codegen/ios
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IOS_ROOT = path.join(ROOT, 'ios');
const EXAMPLE_IOS = path.join(ROOT, 'example', 'ios');

const SPEC_CANDIDATES = [
  path.join(
    EXAMPLE_IOS,
    'Pods/Headers/Public/ReactCodegen/SherpaOnnxSpec/SherpaOnnxSpec.h',
  ),
  path.join(
    ROOT,
    '.codegen/ios/build/generated/ios/ReactCodegen/SherpaOnnxSpec/SherpaOnnxSpec.h',
  ),
];

/** @type {ReadonlySet<string>} */
const SKIP_SPEC_METHODS = new Set([
  'addListener',
  'removeListeners',
  'setEventEmitterCallback',
  'installJSI',
]);

/** Internal helpers — not TurboModule API surface. */
const SKIP_IMPL_PREFIXES = ['so_'];

/** ObjC methods on SherpaOnnx that are not in the codegen spec. */
const ALLOW_EXTRA_IMPL = new Set([
  'setBridge',
  'emitError',
  'emitFileIOProgress',
  'URLSession',
  'runForegroundDownload',
]);

/**
 * @param {string} t
 * @returns {string}
 */
function normalizeType(t) {
  return t
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ \*/g, '*')
    .replace(/\* /g, '*');
}

/**
 * @param {string} decl
 * @returns {Array<{ name: string, type: string }>}
 */
function parseParamsFromDecl(decl) {
  const params = [];
  const re = /(\w+):\(([^()]+(?:\([^)]*\))*[^()]*)\)/gs;
  let m;
  while ((m = re.exec(decl)) !== null) {
    params.push({ name: m[1], type: normalizeType(m[2]) });
  }
  return params;
}

/**
 * @returns {string | null}
 */
function findSpecHeader() {
  for (const p of SPEC_CANDIDATES) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * @returns {string}
 */
function runCodegen() {
  const out = path.join(ROOT, '.codegen/ios');
  fs.mkdirSync(out, { recursive: true });
  execSync(
    'npx react-native codegen --platform ios --outputPath ' +
      JSON.stringify(out),
    { cwd: path.join(ROOT, 'example'), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const spec = path.join(
    out,
    'build/generated/ios/ReactCodegen/SherpaOnnxSpec/SherpaOnnxSpec.h',
  );
  if (!fs.existsSync(spec)) {
    throw new Error(`codegen did not produce ${spec}`);
  }
  return spec;
}

/**
 * @param {string} specText
 * @returns {Map<string, Array<{ name: string, type: string }>>}
 */
function parseSpecMethods(specText) {
  const proto = specText.match(
    /@protocol\s+NativeSherpaOnnxSpec\s*([\s\S]*?)\n@end/,
  );
  if (!proto) {
    throw new Error('NativeSherpaOnnxSpec not found in SherpaOnnxSpec.h');
  }
  /** @type {Map<string, Array<{ name: string, type: string }>>} */
  const methods = new Map();
  const declRe = /-\s*\([^)]+\)[^;]+;/gs;
  let decl;
  while ((decl = declRe.exec(proto[1])) !== null) {
    const nameM = decl[0].match(/\)\s*(\w+):/);
    if (!nameM) {
      continue;
    }
    methods.set(nameM[1], parseParamsFromDecl(decl[0]));
  }
  return methods;
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {{ name: string, params: Array<{ name: string, type: string }>, next: number } | null}
 */
function parseImplSignature(lines, start) {
  if (!/^\s*-\s*\(void\)\w+:/.test(lines[start])) {
    return null;
  }
  const parts = [lines[start].trimEnd()];
  let j = start + 1;
  while (j < lines.length) {
    const stripped = lines[j].trim();
    if (stripped.startsWith('{') || stripped.startsWith('#')) {
      break;
    }
    if (stripped.startsWith('- (') && stripped.includes(':')) {
      break;
    }
    if (
      stripped &&
      !stripped.startsWith('//') &&
      (/^\w+:\(/.test(stripped) ||
        stripped.startsWith('resolve:') ||
        stripped.startsWith('reject:'))
    ) {
      parts.push(stripped);
    } else if (stripped) {
      break;
    }
    j += 1;
  }
  const sig = parts.join(' ');
  const nameM = sig.match(/-\s*\(void\)(\w+):/);
  if (!nameM) {
    return null;
  }
  return { name: nameM[1], params: parseParamsFromDecl(sig), next: j };
}

/**
 * @param {string} iosDir
 * @returns {Map<string, { file: string, params: Array<{ name: string, type: string }> }>}
 */
function parseImplMethods(iosDir) {
  /** @type {Map<string, { file: string, params: Array<{ name: string, type: string }> }>} */
  const methods = new Map();

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.mm')) {
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes('@implementation') || !text.includes('SherpaOnnx')) {
          continue;
        }
        const rel = path.relative(iosDir, full);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; ) {
          const parsed = parseImplSignature(lines, i);
          if (!parsed) {
            i += 1;
            continue;
          }
          i = parsed.next;
          if (SKIP_IMPL_PREFIXES.some((p) => parsed.name.startsWith(p))) {
            continue;
          }
          const prev = methods.get(parsed.name);
          if (
            !prev ||
            parsed.params.length >= prev.params.length
          ) {
            methods.set(parsed.name, { file: rel, params: parsed.params });
          }
        }
      }
    }
  }

  walk(iosDir);
  return methods;
}

/**
 * @param {Map<string, Array<{ name: string, type: string }>>} spec
 * @param {Map<string, { file: string, params: Array<{ name: string, type: string }> }>} impl
 */
function compare(spec, impl) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const missingImpl = [];

  for (const name of [...spec.keys()].sort()) {
    if (SKIP_SPEC_METHODS.has(name)) {
      continue;
    }
    const sp = spec.get(name);
    const ip = impl.get(name);
    if (!ip) {
      missingImpl.push(name);
      continue;
    }
    if (sp.length !== ip.params.length) {
      errors.push(
        `${name} (${ip.file}): parameter count spec=${sp.length} impl=${ip.params.length}\n` +
          `  spec: ${formatParams(sp)}\n` +
          `  impl: ${formatParams(ip.params)}`,
      );
      continue;
    }
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i];
      const im = ip.params[i];
      if (s.name !== im.name) {
        errors.push(
          `${name} (${ip.file}): parameter ${i + 1} name spec='${s.name}' impl='${im.name}'`,
        );
      }
      if (s.type !== im.type) {
        errors.push(
          `${name} (${ip.file}): parameter '${s.name}' type spec='${s.type}' impl='${im.type}'`,
        );
      }
    }
  }

  for (const name of [...impl.keys()].sort()) {
    if (spec.has(name) || ALLOW_EXTRA_IMPL.has(name)) {
      continue;
    }
    if (SKIP_IMPL_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    errors.push(
      `implementation not in spec: ${name} (${impl.get(name).file})`,
    );
  }

  return { errors, missingImpl };
}

/**
 * @param {Array<{ name: string, type: string }>} params
 */
function formatParams(params) {
  return params.map((p) => `${p.name}:(${p.type})`).join(' ');
}

function main() {
  let specPath = findSpecHeader();
  if (!specPath) {
    console.error('SherpaOnnxSpec.h not found; running react-native codegen…');
    try {
      specPath = runCodegen();
      console.error(`  generated: ${specPath}`);
    } catch (e) {
      console.error('codegen failed:', e.stderr?.toString() ?? e.message);
      process.exit(2);
    }
  }

  const specText = fs.readFileSync(specPath, 'utf8');
  const specMethods = parseSpecMethods(specText);
  const implMethods = parseImplMethods(IOS_ROOT);
  const { errors, missingImpl } = compare(specMethods, implMethods);

  const specCount = specMethods.size;
  const matched = [...specMethods.keys()].filter(
    (n) => implMethods.has(n) && !SKIP_SPEC_METHODS.has(n),
  ).length;

  console.log(`Spec: ${specPath}`);
  console.log(`Spec methods: ${specCount}`);
  console.log(`Impl methods (SherpaOnnx): ${implMethods.size}`);
  console.log(`Matched: ${matched}`);

  if (missingImpl.length > 0) {
    console.log(`\nMissing implementation (${missingImpl.length}):`);
    for (const n of missingImpl.slice(0, 40)) {
      console.log(`  - ${n}`);
    }
    if (missingImpl.length > 40) {
      console.log(`  … and ${missingImpl.length - 40} more`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nSignature mismatches (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ${e}`);
    }
  }

  const failCount = errors.length + missingImpl.length;
  if (failCount === 0) {
    console.log('\nAll TurboModule signatures match codegen.');
    process.exit(0);
  }

  console.error(
    `\n${failCount} problem(s): fix native signatures to match SherpaOnnxSpec.h.`,
  );
  process.exit(1);
}

main();
