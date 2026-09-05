#!/usr/bin/env node

'use strict';

const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const DEFAULT_CSV = 'scripts/diarization-models/sources.csv';
const DEFAULT_BUILD_DIR = 'build/diarization-models';
const DEFAULT_DIST_DIR = 'dist/diarization-models';
const DEFAULT_REPO = 'XDcobra/react-native-sherpa-onnx';
const DEFAULT_TAG = 'diarization-models';
const CHECKSUM_ASSET_NAME = 'checksum.txt';
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;

function printHelp() {
  console.log(`Usage: node scripts/diarization-models/build_and_upload.js [options]

Options:
  --csv <path>        Path to semicolon-separated CSV source list
  --build-dir <path>  Workspace directory for unpacked model folders
  --dist-dir <path>   Output directory for generated .tar.bz2 files
  --repo <owner/name> GitHub repository in owner/name format
  --tag <tag>         Release tag to inspect and upload assets to
  --dry-run           Build archives only, skip release lookup and upload
  -h, --help          Show this help message

After uploads, writes ${CHECKSUM_ASSET_NAME} (SHA-256 per .tar.bz2, tab-separated) and uploads with --clobber.

Environment (downloads):
  GITHUB_TOKEN / GH_TOKEN   Bearer token for github.com, raw.githubusercontent.com,
                            objects.githubusercontent.com, codeload.github.com (rate limits / private).
  HUGGINGFACE_TOKEN         Bearer token for huggingface.co (CI; avoids anonymous LFS/rate limits).
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
  const baseHeader = ['id', 'onnx_url', 'license', 'license_type', 'commercial_use'];
  const hasMetadataCol = header.length >= 6 && header[5] === 'metadata';

  if (
    header.length < 5 ||
    header[0] !== 'id' ||
    header[1] !== 'onnx_url' ||
    header[2] !== 'license' ||
    header[3] !== 'license_type' ||
    header[4] !== 'commercial_use'
  ) {
    throw new Error(
      `Invalid CSV header. Expected at least id;onnx_url;license;license_type;commercial_use (got ${header.join(';')})`
    );
  }

  const csvDir = path.dirname(path.resolve(csvPath));
  const sources = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i += 1) {
    const lineNumber = i + 1;
    const row = rows[i];

    if (row.length > (hasMetadataCol ? 6 : 5)) {
      throw new Error(
        `Line ${lineNumber}: too many columns (expected ${hasMetadataCol ? 6 : 5})`
      );
    }

    while (row.length < (hasMetadataCol ? 6 : 5)) {
      row.push('');
    }

    const modelId = normalizeCell(row[0]);
    const onnxUrl = normalizeCell(row[1]);
    const licenseUrl = normalizeCell(row[2]);
    const licenseType = normalizeCell(row[3]);
    let commercialUse = normalizeCell(row[4]).toLowerCase();
    const metadataSource = hasMetadataCol ? normalizeCell(row[5]) : '';

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
    if (!licenseType) {
      throw new Error(`Line ${lineNumber}: license_type is required`);
    }
    if (commercialUse !== 'yes' && commercialUse !== 'no') {
      throw new Error(
        `Line ${lineNumber}: commercial_use must be "yes" or "no" (got "${row[4]}")`
      );
    }
    if (seen.has(modelId)) {
      throw new Error(`Duplicate id value in CSV: ${modelId}`);
    }

    seen.add(modelId);
    sources.push({
      modelId,
      onnxUrl,
      licenseUrl,
      licenseType,
      commercialUse,
      metadataSource,
      csvDir,
    });
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
    'User-Agent': 'diarization-model-publisher/1.0',
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

async function handleMetadataFile(source, targetPath) {
  // 1. If explicit metadataSource provided
  if (source.metadataSource) {
    if (
      source.metadataSource.startsWith('http://') ||
      source.metadataSource.startsWith('https://') ||
      source.metadataSource.startsWith('file://')
    ) {
      console.log(`[download] ${source.modelId}: metadata.json from ${source.metadataSource}`);
      await downloadFile(source.metadataSource, targetPath);
      return;
    }

    const localPath = path.isAbsolute(source.metadataSource)
      ? source.metadataSource
      : path.join(source.csvDir, source.metadataSource);

    if (fs.existsSync(localPath)) {
      console.log(`[copy] ${source.modelId}: metadata.json from ${localPath}`);
      await fsp.copyFile(localPath, targetPath);
      return;
    }
    throw new Error(`Metadata file specified but not found: ${localPath}`);
  }

  // 2. Check default conventional path <csvDir>/metadata/<modelId>.json
  const defaultMetaPath = path.join(source.csvDir, 'metadata', `${source.modelId}.json`);
  if (fs.existsSync(defaultMetaPath)) {
    console.log(`[copy] ${source.modelId}: metadata.json from ${defaultMetaPath}`);
    await fsp.copyFile(defaultMetaPath, targetPath);
  }
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

async function getReleaseData(repo, tag, token) {
  if (typeof fetch !== 'function') {
    throw new Error('Node runtime does not provide fetch(); use Node 18+');
  }

  const endpoint = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(
    tag
  )}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'diarization-model-publisher/1.0',
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
  const raw = Array.isArray(payload.assets) ? payload.assets : [];
  const assets = raw
    .filter(
      (asset) =>
        asset &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string'
    )
    .map((asset) => ({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
    }));

  return {
    assetNames: new Set(assets.map((a) => a.name)),
    assets,
  };
}

function parseChecksumMap(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const tab = trimmed.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const name = trimmed.slice(0, tab).trim();
    const hex = trimmed
      .slice(tab + 1)
      .trim()
      .toLowerCase();
    if (name && /^[a-f0-9]{64}$/.test(hex)) {
      map.set(name, hex);
    }
  }
  return map;
}

function formatChecksumMap(map, orderedArchiveNames) {
  const lines = orderedArchiveNames.map((name) => {
    const hex = map.get(name);
    if (!hex) {
      throw new Error(`Missing SHA-256 for ${name}`);
    }
    return `${name}\t${hex}`;
  });
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

async function sha256File(filePath) {
  const buf = await fsp.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function sha256FromUrl(url, token) {
  if (typeof fetch !== 'function') {
    throw new Error('Node runtime does not provide fetch(); use Node 18+');
  }

  const headers = {
    ...headersForDownloadUrl(url),
    'User-Agent': 'diarization-model-publisher/1.0',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} while hashing ${url}: ${body}`);
  }

  const hash = createHash('sha256');
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    hash.update(Buffer.from(arrayBuffer));
    return hash.digest('hex');
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      hash.update(value);
    }
  }
  return hash.digest('hex');
}

async function fetchExistingChecksumTextAndMap(releaseAssets, token) {
  const checksumAsset = releaseAssets.find(
    (a) => a.name === CHECKSUM_ASSET_NAME
  );
  if (!checksumAsset) {
    return { text: '', map: new Map() };
  }

  const headers = {
    ...headersForDownloadUrl(checksumAsset.browser_download_url),
    'User-Agent': 'diarization-model-publisher/1.0',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(checksumAsset.browser_download_url, {
    headers,
  });
  if (!response.ok) {
    return { text: '', map: new Map() };
  }

  const text = await response.text();
  return { text, map: parseChecksumMap(text) };
}

async function buildChecksumMap(
  allSources,
  distDir,
  builtNames,
  releaseAssets,
  priorMap,
  token
) {
  const map = new Map(priorMap);

  for (const source of allSources) {
    const name = `${source.modelId}.tar.bz2`;
    const localPath = path.join(distDir, name);

    if (builtNames.has(name) && fs.existsSync(localPath)) {
      map.set(name, await sha256File(localPath));
    } else if (!map.has(name)) {
      const asset = releaseAssets.find((a) => a.name === name);
      if (!asset) {
        throw new Error(
          `[checksum] ${name} is missing from the release; build or upload it first`
        );
      }
      console.log(`[checksum] hashing remote ${name}`);
      map.set(name, await sha256FromUrl(asset.browser_download_url, token));
    }
  }

  return map;
}

function uploadChecksumFile(repo, tag, checksumPath, token) {
  const env = { ...process.env };
  if (token && !env.GH_TOKEN) {
    env.GH_TOKEN = token;
  }

  runCommand(
    'gh',
    ['release', 'upload', tag, checksumPath, '--clobber', '--repo', repo],
    { env }
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

    const metadataPath = path.join(modelDir, 'metadata.json');
    await handleMetadataFile(source, metadataPath);

    const archivePath = path.join(distDir, `${source.modelId}.tar.bz2`);
    createArchive(source.modelId, buildDir, archivePath);
    console.log(`[archive] ${archivePath}`);
    archives.push(archivePath);
  }

  return archives;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allSources = await readSources(args.csv);

  if (args.dryRun) {
    const archives = await buildArchives(
      allSources,
      args.buildDir,
      args.distDir
    );
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

  const releaseData = await getReleaseData(args.repo, args.tag, token);
  const { assetNames: existingAssets, assets: releaseAssets } = releaseData;
  console.log(
    `[release] Found ${existingAssets.size} assets on ${args.repo}@${args.tag}`
  );

  const { text: priorChecksumText, map: priorChecksumMap } =
    await fetchExistingChecksumTextAndMap(releaseAssets, token);

  const sourcesToBuild = [];
  let skipped = 0;

  for (const source of allSources) {
    const assetName = `${source.modelId}.tar.bz2`;
    if (existingAssets.has(assetName)) {
      console.log(`[skip] ${assetName} already exists in release`);
      skipped += 1;
    } else {
      sourcesToBuild.push(source);
    }
  }

  const builtNames = new Set();
  let uploaded = 0;

  if (sourcesToBuild.length > 0) {
    const archives = await buildArchives(
      sourcesToBuild,
      args.buildDir,
      args.distDir
    );
    for (const archive of archives) {
      const assetName = path.basename(archive);
      console.log(`[upload] ${assetName}`);
      uploadArchive(args.repo, args.tag, archive, token);
      uploaded += 1;
      builtNames.add(assetName);
    }
  } else {
    console.log('[build] No new archives (all assets already on release)');
  }

  let assetsForChecksum = releaseAssets;
  if (uploaded > 0) {
    const refreshed = await getReleaseData(args.repo, args.tag, token);
    assetsForChecksum = refreshed.assets;
  }

  const archiveNames = allSources
    .map((s) => `${s.modelId}.tar.bz2`)
    .sort((a, b) => a.localeCompare(b));

  const checksumMap = await buildChecksumMap(
    allSources,
    args.distDir,
    builtNames,
    assetsForChecksum,
    priorChecksumMap,
    token
  );

  const checksumContent = formatChecksumMap(checksumMap, archiveNames);
  const checksumPath = path.join(args.distDir, CHECKSUM_ASSET_NAME);
  await fsp.mkdir(path.dirname(checksumPath), { recursive: true });
  await fsp.writeFile(checksumPath, checksumContent, 'utf8');

  const priorNorm = priorChecksumText.replace(/\r\n/g, '\n').trimEnd();
  const nextNorm = checksumContent.replace(/\r\n/g, '\n').trimEnd();
  if (nextNorm !== priorNorm) {
    console.log(`[upload] ${CHECKSUM_ASSET_NAME}`);
    uploadChecksumFile(args.repo, args.tag, checksumPath, token);
  } else {
    console.log(`[checksum] ${CHECKSUM_ASSET_NAME} unchanged`);
  }

  console.log(
    `[done] uploaded=${uploaded} skipped=${skipped} total=${allSources.length}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    process.exit(1);
  });
}

module.exports = {
  readSources,
};
