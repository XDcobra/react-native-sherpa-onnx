#!/usr/bin/env node

'use strict';

const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');

const DEFAULT_CSV = 'scripts/wav2vec2-models/sources.csv';
const DEFAULT_BUILD_DIR = 'build/wav2vec2-models';
const DEFAULT_DIST_DIR = 'dist/wav2vec2-models';
const DEFAULT_REPO = 'XDcobra/react-native-sherpa-onnx';
const DEFAULT_TAG = 'wav2vec2-models';
const EXPECTED_HEADER = ['id', 'onnx_url', 'license'];
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;

function printHelp() {
  console.log(`Usage: node scripts/wav2vec2-models/build_and_upload.js [options]

Options:
  --csv <path>        Path to semicolon-separated CSV source list
  --build-dir <path>  Workspace directory for unpacked model folders
  --dist-dir <path>   Output directory for generated .tar.bz2 files
  --repo <owner/name> GitHub repository in owner/name format
  --tag <tag>         Release tag to inspect and upload assets to
  --dry-run           Build archives only, skip release lookup and upload
  -h, --help          Show this help message

Environment (downloads):
  GITHUB_TOKEN / GH_TOKEN   Bearer token for github.com, raw.githubusercontent.com,
                            objects.githubusercontent.com, codeload.github.com (rate limits / private).
  HUGGINGFACE_TOKEN       Bearer token for huggingface.co (CI; avoids anonymous LFS/rate limits).
`);
}

function parseArgs(argv) {
  const args = {
    csv: DEFAULT_CSV,
    buildDir: DEFAULT_BUILD_DIR,
    distDir: DEFAULT_DIST_DIR,
    repo: DEFAULT_REPO,
    tag: DEFAULT_TAG,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (
      arg === '--csv' ||
      arg === '--build-dir' ||
      arg === '--dist-dir' ||
      arg === '--repo' ||
      arg === '--tag'
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === '--csv') {
        args.csv = value;
      } else if (arg === '--build-dir') {
        args.buildDir = value;
      } else if (arg === '--dist-dir') {
        args.distDir = value;
      } else if (arg === '--repo') {
        args.repo = value;
      } else if (arg === '--tag') {
        args.tag = value;
      }

      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function parseSemicolonCsv(content) {
  const input = content.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        const next = input[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ';') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      field = '';
      if (!(row.length === 1 && row[0] === '')) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    if (char === '\r') {
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('CSV parsing failed: unterminated quoted field');
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
    }
  }

  return rows;
}

function normalizeCell(value) {
  return (value || '').trim();
}

async function readSources(csvPath) {
  let content;
  try {
    content = await fsp.readFile(csvPath, 'utf8');
  } catch {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const rows = parseSemicolonCsv(content);
  if (rows.length === 0) {
    throw new Error(`CSV file has no rows: ${csvPath}`);
  }

  const header = rows[0].map(normalizeCell);
  if (
    header.length !== EXPECTED_HEADER.length ||
    header.join(';') !== EXPECTED_HEADER.join(';')
  ) {
    throw new Error(
      `Invalid CSV header. Expected ${EXPECTED_HEADER.join(
        ';'
      )}, got ${header.join(';')}`
    );
  }

  const sources = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i += 1) {
    const lineNumber = i + 1;
    const row = rows[i];

    if (row.length > 3) {
      throw new Error(`Line ${lineNumber}: too many columns (expected 3)`);
    }

    while (row.length < 3) {
      row.push('');
    }

    const modelId = normalizeCell(row[0]);
    const onnxUrl = normalizeCell(row[1]);
    const licenseUrl = normalizeCell(row[2]);

    if (!modelId) {
      throw new Error(`Line ${lineNumber}: id is required`);
    }
    if (!VALID_ID_RE.test(modelId)) {
      throw new Error(
        `Line ${lineNumber}: invalid id '${modelId}'. Allowed characters: A-Z a-z 0-9 . _ -`
      );
    }
    if (!onnxUrl) {
      throw new Error(`Line ${lineNumber}: onnx_url is required`);
    }
    if (seen.has(modelId)) {
      throw new Error(`Duplicate id value in CSV: ${modelId}`);
    }

    seen.add(modelId);
    sources.push({ modelId, onnxUrl, licenseUrl });
  }

  if (sources.length === 0) {
    throw new Error(`CSV contains no data rows: ${csvPath}`);
  }

  return sources;
}

async function ensureCleanDir(targetDir) {
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.mkdir(targetDir, { recursive: true });
}

/**
 * @param {string} url
 * @returns {Record<string, string>}
 */
function headersForDownloadUrl(url) {
  const headers = {
    'User-Agent': 'wav2vec2-model-publisher/1.0',
    'Accept': '*/*',
  };

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return headers;
  }

  const githubHosts = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'codeload.github.com',
    'gist.githubusercontent.com',
  ]);

  if (githubHosts.has(hostname) || hostname.endsWith('.github.com')) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  if (
    hostname === 'huggingface.co' ||
    hostname === 'hf.co' ||
    hostname.endsWith('.huggingface.co')
  ) {
    const hfToken = process.env.HUGGINGFACE_TOKEN || '';
    if (hfToken) {
      headers.Authorization = `Bearer ${hfToken}`;
    }
    return headers;
  }

  return headers;
}

async function downloadFile(url, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  if (url.startsWith('file://')) {
    const sourcePath = fileURLToPath(url);
    await fsp.copyFile(sourcePath, destination);
    return;
  }

  if (typeof fetch !== 'function') {
    throw new Error('Node runtime does not provide fetch(); use Node 18+');
  }

  const response = await fetch(url, {
    headers: headersForDownloadUrl(url),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `HTTP ${response.status} while downloading ${url}: ${body}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(destination, Buffer.from(arrayBuffer));
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function createArchive(modelId, buildDir, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true });
  }

  runCommand('tar', ['-cjf', archivePath, '-C', buildDir, modelId]);
}

function resolveToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

async function getReleaseAssetNames(repo, tag, token) {
  if (typeof fetch !== 'function') {
    throw new Error('Node runtime does not provide fetch(); use Node 18+');
  }

  const endpoint = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(
    tag
  )}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'wav2vec2-model-publisher/1.0',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1000);
    throw new Error(
      `Could not query release tag '${tag}' in ${repo}: HTTP ${response.status} ${body}`
    );
  }

  const payload = await response.json();
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  return new Set(
    assets
      .map((asset) =>
        asset && typeof asset.name === 'string' ? asset.name : ''
      )
      .filter(Boolean)
  );
}

function uploadArchive(repo, tag, archivePath, token) {
  const env = { ...process.env };
  if (token && !env.GH_TOKEN) {
    env.GH_TOKEN = token;
  }

  runCommand('gh', ['release', 'upload', tag, archivePath, '--repo', repo], {
    env,
  });
}

async function buildArchives(sources, buildDir, distDir) {
  await fsp.mkdir(buildDir, { recursive: true });
  await fsp.mkdir(distDir, { recursive: true });

  const archives = [];

  for (const source of sources) {
    const modelDir = path.join(buildDir, source.modelId);
    await ensureCleanDir(modelDir);

    const modelPath = path.join(modelDir, 'model.onnx');
    console.log(`[download] ${source.modelId}: model.onnx`);
    await downloadFile(source.onnxUrl, modelPath);

    if (source.licenseUrl) {
      const licensePath = path.join(modelDir, 'LICENSE');
      console.log(`[download] ${source.modelId}: LICENSE`);
      await downloadFile(source.licenseUrl, licensePath);
    }

    const archivePath = path.join(distDir, `${source.modelId}.tar.bz2`);
    createArchive(source.modelId, buildDir, archivePath);
    console.log(`[archive] ${archivePath}`);
    archives.push(archivePath);
  }

  return archives;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = await readSources(args.csv);
  const archives = await buildArchives(sources, args.buildDir, args.distDir);

  if (args.dryRun) {
    console.log('[dry-run] Upload skipped.');
    for (const archive of archives) {
      console.log(`[dry-run] built ${archive}`);
    }
    return;
  }

  const token = resolveToken();
  if (!token) {
    throw new Error(
      'Missing GITHUB_TOKEN/GH_TOKEN environment variable for release lookup and upload'
    );
  }

  const existingAssets = await getReleaseAssetNames(args.repo, args.tag, token);
  console.log(
    `[release] Found ${existingAssets.size} assets on ${args.repo}@${args.tag}`
  );

  let uploaded = 0;
  let skipped = 0;

  for (const archive of archives) {
    const assetName = path.basename(archive);
    if (existingAssets.has(assetName)) {
      console.log(`[skip] ${assetName} already exists in release`);
      skipped += 1;
      continue;
    }

    console.log(`[upload] ${assetName}`);
    uploadArchive(args.repo, args.tag, archive, token);
    uploaded += 1;
  }

  console.log(
    `[done] uploaded=${uploaded} skipped=${skipped} total=${archives.length}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${message}`);
  process.exit(1);
});
