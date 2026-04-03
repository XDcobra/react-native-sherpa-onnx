#!/usr/bin/env node

'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { readSources } = require('./build_and_upload.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CSV = path.join(__dirname, 'sources.csv');
const TARGETS = [
  path.join(
    REPO_ROOT,
    'android/src/main/assets/model_licenses/alignment-models-license-status.csv'
  ),
  path.join(
    REPO_ROOT,
    'ios/Resources/model_licenses/alignment-models-license-status.csv'
  ),
];

const HEADER =
  'asset_name,license_type,commercial_use,confidence,detection_source,license_file';

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else if (c === '"') {
      inQuotes = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function escapeCsvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowFromSource(source) {
  return [
    `${source.modelId}.tar.bz2`,
    source.licenseType,
    source.commercialUse,
    'high',
    'manual',
    source.licenseUrl || '',
  ]
    .map(escapeCsvField)
    .join(',');
}

async function readExistingRows(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return new Map();
  }
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    return new Map();
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols[0]) {
      map.set(cols[0], lines[i]);
    }
  }
  return map;
}

async function writeMerged(filePath, sources) {
  const byAsset = await readExistingRows(filePath);
  for (const s of sources) {
    byAsset.set(`${s.modelId}.tar.bz2`, rowFromSource(s));
  }
  const keys = Array.from(byAsset.keys()).sort((a, b) => a.localeCompare(b));
  const body = keys.map((k) => byAsset.get(k)).join('\n');
  const out = `${HEADER}\n${body}\n`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, out, 'utf8');
}

async function main() {
  const csvPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_CSV;
  const sources = await readSources(csvPath);
  for (const target of TARGETS) {
    await writeMerged(target, sources);
    console.log(`[sync] ${path.relative(REPO_ROOT, target)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
