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
    'android/src/main/assets/model_licenses/diarization-models-license-status.csv'
  ),
  path.join(
    REPO_ROOT,
    'ios/Resources/model_licenses/diarization-models-license-status.csv'
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
  const sortedKeys = Array.from(byAsset.keys()).sort((a, b) =>
    a.localeCompare(b)
  );
  const outLines = [HEADER];
  for (const k of sortedKeys) {
    const row = byAsset.get(k);
    if (row) {
      outLines.push(row);
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${outLines.join('\n')}\n`, 'utf8');
  console.log(`[sync] Wrote ${outLines.length - 1} rows to ${filePath}`);
}

async function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CSV;
  const sources = await readSources(csvPath);
  for (const t of TARGETS) {
    await writeMerged(t, sources);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, writeMerged, rowFromSource };
