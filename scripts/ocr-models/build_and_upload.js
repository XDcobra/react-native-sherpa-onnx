#!/usr/bin/env node

'use strict';

const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fileURLToPath } = require('node:url');

const DEFAULT_CSV = 'scripts/ocr-models/sources.csv';
const DEFAULT_BUILD_DIR = 'build/ocr-models';
const DEFAULT_DIST_DIR = 'dist/ocr-models';
const DEFAULT_REPO = 'XDcobra/react-native-sherpa-onnx';
const DEFAULT_TAG = 'ocr-models';
const EXPECTED_HEADER = [
  'id',
  'family',
  'det_url',
  'rec_url',
  'cls_url',
  'rec_yml_url',
  'det_config_url',
  'rec_config_url',
  'license',
  'license_type',
  'commercial_use',
  'languages',
  'hf_repo',
];
const VALID_FAMILIES = new Set(['ppocr', 'doctr', 'doc_vlm', 'nemotron_parse']);
const NEMOTRON_PARSE_EXPORT_ROOT = path.join(
  __dirname,
  '../../build/ocr-models/nemotron-3.5-parse'
);
const NEMOTRON_PARSE_VARIANT_DIRS = {
  fp16: 'onnx-fp16',
  int8: 'onnx-int8',
  fp32: 'onnx',
  q4f16: 'onnx-q4f16',
};
const NEMOTRON_PARSE_HUB_FOLDERS = {
  fp16: 'onnx/fp16',
  int8: 'onnx/int8',
};
const NEMOTRON_PARSE_PACK_FILES = [
  'patch_embed.onnx',
  'patch_embed.onnx_data',
  'pos_embed.npy',
  'vision_encoder.onnx',
  'vision_encoder.onnx_data',
  'embed_tokens.onnx',
  'embed_tokens.onnx_data',
  'decoder_model_merged.onnx',
  'decoder_model_merged.onnx_data',
  'tokenizer.json',
  'ocr_manifest.json',
];
const NEMOTRON_PARSE_OPTIONAL_ROOT_FILES = ['TOKENIZER_ATTRIBUTION.md'];
const DOC_VLM_HF_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_LFS_POINTER_FIRST_LINE = 'version https://git-lfs.github.com/spec/v1';
const MIB = 1024 * 1024;
const NEMOTRON_PARSE_MIN_BYTES = {
  fp16: new Map([
    ['vision_encoder.onnx_data', 700 * MIB],
    ['decoder_model_merged.onnx_data', 300 * MIB],
    ['embed_tokens.onnx_data', 100 * MIB],
    ['pos_embed.npy', 50 * MIB],
    ['tokenizer.json', 1 * MIB],
  ]),
  int8: new Map([
    ['vision_encoder.onnx_data', 350 * MIB],
    ['decoder_model_merged.onnx_data', 150 * MIB],
    ['embed_tokens.onnx_data', 50 * MIB],
    ['pos_embed.npy', 20 * MIB],
    ['tokenizer.json', 1 * MIB],
  ]),
};
/** Hub filename tag is not the pack-id technique (`_quantized` → pack `-q8`). */
const DOC_VLM_VARIANTS = {
  fp32: {
    hubSuffix: '',
    onnxDtype: 'fp32',
    minBytes: new Map([
      ['vision_encoder.onnx_data', 300 * MIB],
      ['embed_tokens.onnx_data', 200 * MIB],
      ['decoder_model_merged.onnx_data', 600 * MIB],
      ['tokenizer.json', 1 * MIB],
    ]),
  },
  q8: {
    hubSuffix: '_quantized',
    onnxDtype: 'q8',
    minBytes: new Map([
      ['vision_encoder.onnx_data', 70 * MIB],
      ['embed_tokens.onnx_data', 40 * MIB],
      ['decoder_model_merged.onnx_data', 120 * MIB],
      ['tokenizer.json', 1 * MIB],
    ]),
  },
  fp16: {
    hubSuffix: '_fp16',
    onnxDtype: 'fp16',
    minBytes: new Map([
      ['vision_encoder.onnx_data', 140 * MIB],
      ['embed_tokens.onnx_data', 80 * MIB],
      ['decoder_model_merged.onnx_data', 250 * MIB],
      ['tokenizer.json', 1 * MIB],
    ]),
  },
  q4f16: {
    hubSuffix: '_q4f16',
    onnxDtype: 'q4f16',
    minBytes: new Map([
      ['vision_encoder.onnx_data', 40 * MIB],
      ['embed_tokens.onnx_data', 80 * MIB],
      ['decoder_model_merged.onnx_data', 70 * MIB],
      ['tokenizer.json', 1 * MIB],
    ]),
  },
};
const DOC_VLM_SHARED_FILES = [
  { repoPath: 'tokenizer.json', name: 'tokenizer.json' },
  { repoPath: 'tokenizer_config.json', name: 'tokenizer_config.json' },
  { repoPath: 'vocab.json', name: 'vocab.json' },
  { repoPath: 'merges.txt', name: 'merges.txt' },
  { repoPath: 'added_tokens.json', name: 'added_tokens.json' },
  { repoPath: 'special_tokens_map.json', name: 'special_tokens_map.json' },
  { repoPath: 'chat_template.jinja', name: 'chat_template.jinja' },
  { repoPath: 'config.json', name: 'config.json' },
  { repoPath: 'generation_config.json', name: 'generation_config.json' },
  { repoPath: 'preprocessor_config.json', name: 'preprocessor_config.json' },
  { repoPath: 'processor_config.json', name: 'processor_config.json' },
];

/**
 * Pack-id technique. Check q4f16 before fp16.
 * @param {string} modelId
 * @returns {keyof typeof DOC_VLM_VARIANTS}
 */
function nemotronParseVariantFromId(modelId) {
  const id = String(modelId ?? '');
  if (id.endsWith('-q4f16')) return 'q4f16';
  if (id.endsWith('-fp16')) return 'fp16';
  if (id.endsWith('-int8')) return 'int8';
  if (id.endsWith('-fp32')) return 'fp32';
  throw new Error(
    `${id}: nemotron_parse id must end with -fp16, -int8, -fp32, or -q4f16`
  );
}

function docVlmVariantFromId(modelId) {
  const id = String(modelId ?? '');
  if (id.endsWith('-q4f16')) return 'q4f16';
  if (id.endsWith('-fp16')) return 'fp16';
  if (id.endsWith('-q8')) return 'q8';
  if (id.endsWith('-fp32')) return 'fp32';
  throw new Error(
    `${id}: doc_vlm id must end with -fp32, -q8, -fp16, or -q4f16`
  );
}

/**
 * Flatten Hub suffixed graphs onto the eight canonical pack names.
 * Each returned list is a complete archive (no files borrowed from another pack).
 * @param {keyof typeof DOC_VLM_VARIANTS} variantKey
 */
function docVlmPackFiles(variantKey) {
  const variant = DOC_VLM_VARIANTS[variantKey];
  if (!variant) {
    throw new Error(`Unknown doc_vlm variant '${variantKey}'`);
  }
  const suffix = variant.hubSuffix;
  const onnxPair = (base) => {
    const hub = suffix ? `${base}${suffix}` : base;
    return [
      { repoPath: `onnx/${hub}.onnx`, name: `${base}.onnx` },
      { repoPath: `onnx/${hub}.onnx_data`, name: `${base}.onnx_data` },
    ];
  };
  return [
    ...onnxPair('vision_encoder'),
    ...onnxPair('embed_tokens'),
    ...onnxPair('decoder_model_merged'),
    ...DOC_VLM_SHARED_FILES,
  ];
}
const DOC_VLM_IMAGE_TOKEN = '<image>';
const DOC_VLM_IMAGE_TOKEN_ID = 100270;
const DOC_VLM_BOS_TOKEN_ID = 100264;
const DOC_VLM_EOS_TOKEN_ID = 100257;
const CHECKSUM_ASSET_NAME = 'checksum.txt';
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;
const VALID_ISO6391_RE = /^[a-z]{2,3}(-[a-z0-9]+)?$/i;
const USER_AGENT = 'ocr-model-publisher/1.0';

/**
 * @param {string} languagesRaw
 * @param {number} lineNumber
 * @returns {string[]}
 */
function parseLanguagesCell(languagesRaw, lineNumber) {
  if (!languagesRaw) {
    return [];
  }
  const parts = languagesRaw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const code of parts) {
    if (!VALID_ISO6391_RE.test(code)) {
      throw new Error(
        `Line ${lineNumber}: invalid language code '${code}' in languages column`
      );
    }
  }
  return [...new Set(parts)];
}

function printHelp() {
  console.log(`Usage: node scripts/ocr-models/build_and_upload.js [options]

Options:
  --csv <path>        Path to semicolon-separated CSV source list
  --build-dir <path>  Workspace directory for unpacked model folders
  --dist-dir <path>   Output directory for generated .tar.bz2 files
  --repo <owner/name> GitHub repository in owner/name format
  --tag <tag>         Release tag to inspect and upload assets to
  --only <id>         Build/upload only this model id (repeatable)
  --dry-run           Build archives only, skip release lookup and upload
  -h, --help          Show this help message

Nemotron-Parse packs flatten onnx/fp16 and onnx/int8 from
XDcobra/Nemotron-3.5-Parse-ONNX (same hf_repo column as granite).

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
    onlyIds: [],
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
      arg === '--tag' ||
      arg === '--only'
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
      } else if (arg === '--only') {
        args.onlyIds.push(value);
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

    if (row.length > EXPECTED_HEADER.length) {
      throw new Error(
        `Line ${lineNumber}: too many columns (expected ${EXPECTED_HEADER.length})`
      );
    }

    while (row.length < EXPECTED_HEADER.length) {
      row.push('');
    }

    const modelId = normalizeCell(row[0]);
    const family = normalizeCell(row[1]).toLowerCase();
    const detUrl = normalizeCell(row[2]);
    const recUrl = normalizeCell(row[3]);
    const clsUrl = normalizeCell(row[4]);
    const recYmlUrl = normalizeCell(row[5]);
    const detConfigUrl = normalizeCell(row[6]);
    const recConfigUrl = normalizeCell(row[7]);
    const licenseUrl = normalizeCell(row[8]);
    const licenseType = normalizeCell(row[9]);
    const commercialUse = normalizeCell(row[10]).toLowerCase();
    const languages = parseLanguagesCell(normalizeCell(row[11]), lineNumber);
    const hfRepo = normalizeCell(row[12]);

    if (!modelId) {
      throw new Error(`Line ${lineNumber}: id is required`);
    }
    if (!VALID_ID_RE.test(modelId)) {
      throw new Error(
        `Line ${lineNumber}: invalid id '${modelId}'. Allowed characters: A-Z a-z 0-9 . _ -`
      );
    }
    if (!VALID_FAMILIES.has(family)) {
      throw new Error(
        `Line ${lineNumber}: family must be "ppocr", "doctr", "doc_vlm", or "nemotron_parse" (got "${row[1]}")`
      );
    }
    if (family === 'ppocr' || family === 'doctr') {
      if (!detUrl) {
        throw new Error(`Line ${lineNumber}: det_url is required`);
      }
      if (!recUrl) {
        throw new Error(`Line ${lineNumber}: rec_url is required`);
      }
      if (hfRepo) {
        throw new Error(
          `Line ${lineNumber}: hf_repo must be empty for ${family}`
        );
      }
    }
    if (family === 'ppocr') {
      if (!clsUrl) {
        throw new Error(`Line ${lineNumber}: cls_url is required for ppocr`);
      }
      if (!recYmlUrl) {
        throw new Error(
          `Line ${lineNumber}: rec_yml_url is required for ppocr`
        );
      }
      if (detConfigUrl || recConfigUrl) {
        throw new Error(
          `Line ${lineNumber}: det_config_url/rec_config_url must be empty for ppocr`
        );
      }
    } else if (family === 'doctr') {
      if (recYmlUrl) {
        throw new Error(
          `Line ${lineNumber}: rec_yml_url must be empty for doctr`
        );
      }
      if (!detConfigUrl) {
        throw new Error(
          `Line ${lineNumber}: det_config_url is required for doctr`
        );
      }
      if (!recConfigUrl) {
        throw new Error(
          `Line ${lineNumber}: rec_config_url is required for doctr`
        );
      }
    } else if (family === 'doc_vlm') {
      if (
        detUrl ||
        recUrl ||
        clsUrl ||
        recYmlUrl ||
        detConfigUrl ||
        recConfigUrl
      ) {
        throw new Error(
          `Line ${lineNumber}: det_url, rec_url, cls_url, rec_yml_url, det_config_url, and rec_config_url must be empty for doc_vlm`
        );
      }
      if (!hfRepo) {
        throw new Error(`Line ${lineNumber}: hf_repo is required for doc_vlm`);
      }
      if (!DOC_VLM_HF_REPO_RE.test(hfRepo)) {
        throw new Error(
          `Line ${lineNumber}: hf_repo must be owner/name with no scheme (got "${hfRepo}")`
        );
      }
      try {
        docVlmVariantFromId(modelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Line ${lineNumber}: ${message}`);
      }
    } else if (family === 'nemotron_parse') {
      if (
        detUrl ||
        recUrl ||
        clsUrl ||
        recYmlUrl ||
        detConfigUrl ||
        recConfigUrl
      ) {
        throw new Error(
          `Line ${lineNumber}: det_url, rec_url, cls_url, rec_yml_url, det_config_url, and rec_config_url must be empty for nemotron_parse`
        );
      }
      if (!hfRepo) {
        throw new Error(
          `Line ${lineNumber}: hf_repo is required for nemotron_parse`
        );
      }
      if (!DOC_VLM_HF_REPO_RE.test(hfRepo)) {
        throw new Error(
          `Line ${lineNumber}: hf_repo must be owner/name with no scheme (got "${hfRepo}")`
        );
      }
      try {
        nemotronParseVariantFromId(modelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Line ${lineNumber}: ${message}`);
      }
    }
    if (!licenseType) {
      throw new Error(`Line ${lineNumber}: license_type is required`);
    }
    if (
      commercialUse !== 'yes' &&
      commercialUse !== 'no' &&
      commercialUse !== 'conditional'
    ) {
      throw new Error(
        `Line ${lineNumber}: commercial_use must be "yes", "no", or "conditional" (got "${row[10]}")`
      );
    }
    if (seen.has(modelId)) {
      throw new Error(`Duplicate id value in CSV: ${modelId}`);
    }

    seen.add(modelId);
    sources.push({
      modelId,
      family,
      detUrl,
      recUrl,
      clsUrl,
      recYmlUrl,
      detConfigUrl,
      recConfigUrl,
      licenseUrl,
      licenseType,
      commercialUse,
      languages,
      hfRepo,
      docVlmVariant:
        family === 'doc_vlm' ? docVlmVariantFromId(modelId) : undefined,
      nemotronParseVariant:
        family === 'nemotron_parse'
          ? nemotronParseVariantFromId(modelId)
          : undefined,
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
    'User-Agent': USER_AGENT,
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

async function downloadFile(url, destination, options = {}) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });

  if (url.startsWith('file://')) {
    const sourcePath = fileURLToPath(url);
    await fsp.copyFile(sourcePath, destination);
    return true;
  }

  if (typeof fetch !== 'function') {
    throw new Error('Node runtime does not provide fetch(); use Node 18+');
  }

  const response = await fetch(url, {
    headers: headersForDownloadUrl(url),
    redirect: 'follow',
  });

  if (options.optional && response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `HTTP ${response.status} while downloading ${url}: ${body}`
    );
  }

  if (!response.body) {
    throw new Error(`Empty body while downloading ${url}`);
  }

  const fileStream = fs.createWriteStream(destination);
  try {
    await pipeline(Readable.fromWeb(response.body), fileStream);
  } catch (error) {
    fileStream.destroy();
    await fsp.rm(destination, { force: true });
    throw error;
  }
  return true;
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

function pythonHasOnnx(python) {
  const probe = spawnSync(python, ['-c', 'import onnx'], { encoding: 'utf8' });
  return probe.status === 0;
}

function resolveOnnxPython() {
  if (process.env.DOCVLM_ONNX_PYTHON) {
    return process.env.DOCVLM_ONNX_PYTHON;
  }
  for (const candidate of ['python3', 'python']) {
    if (pythonHasOnnx(candidate)) return candidate;
  }
  const venvDir = path.join(__dirname, '../../build/ocr-models/.venv-onnx');
  const venvPython = path.join(venvDir, 'bin', 'python');
  if (pythonHasOnnx(venvPython)) return venvPython;
  console.log('[onnx] creating venv to flatten DocVLM external-data locations');
  runCommand('python3', ['-m', 'venv', venvDir]);
  runCommand(venvPython, ['-m', 'pip', 'install', '--quiet', 'onnx']);
  return venvPython;
}

/**
 * Point a flattened graph at `<graph>.onnx_data` instead of the Hub suffix.
 * @param {string} graphPath
 * @param {string} dataBasename
 */
function rewriteOnnxExternalLocation(graphPath, dataBasename) {
  const scriptPath = path.join(__dirname, 'rewrite_onnx_external_location.py');
  const python = resolveOnnxPython();
  const result = spawnSync(python, [scriptPath, graphPath, dataBasename], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    throw new Error(
      `Failed to rewrite ONNX external data in ${graphPath}` +
        (detail ? `: ${detail}` : ` (${python} exited ${result.status})`)
    );
  }
}

function createArchive(modelId, buildDir, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  if (fs.existsSync(archivePath)) {
    fs.rmSync(archivePath, { force: true });
  }

  // macOS bsdtar stores AppleDouble `._*` members when files have xattrs.
  const env = { ...process.env, COPYFILE_DISABLE: '1' };
  runCommand('tar', ['-cjf', archivePath, '-C', buildDir, modelId], { env });
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
    'User-Agent': USER_AGENT,
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
    'User-Agent': USER_AGENT,
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
    'User-Agent': USER_AGENT,
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

/**
 * @param {object} source
 * @param {string} modelDir
 */
async function buildPpocrPack(source, modelDir) {
  const files = [
    { url: source.detUrl, name: 'det.onnx' },
    { url: source.recUrl, name: 'rec.onnx' },
    { url: source.clsUrl, name: 'cls.onnx' },
    { url: source.recYmlUrl, name: 'rec_inference.yml' },
  ];
  for (const file of files) {
    console.log(`[download] ${source.modelId}: ${file.name}`);
    await downloadFile(file.url, path.join(modelDir, file.name));
  }
}

/**
 * Build doctr (OnnxTR) pack: det/rec ONNX + merged ocr_manifest.json from configs.
 * @param {object} source
 * @param {string} modelDir
 */
async function buildDoctrPack(source, modelDir) {
  console.log(`[download] ${source.modelId}: det.onnx`);
  await downloadFile(source.detUrl, path.join(modelDir, 'det.onnx'));
  console.log(`[download] ${source.modelId}: rec.onnx`);
  await downloadFile(source.recUrl, path.join(modelDir, 'rec.onnx'));

  const detConfigPath = path.join(modelDir, '_det_config.json');
  const recConfigPath = path.join(modelDir, '_rec_config.json');
  console.log(`[download] ${source.modelId}: det config.json`);
  await downloadFile(source.detConfigUrl, detConfigPath);
  console.log(`[download] ${source.modelId}: rec config.json`);
  await downloadFile(source.recConfigUrl, recConfigPath);

  const detCfg = JSON.parse(await fsp.readFile(detConfigPath, 'utf8'));
  const recCfg = JSON.parse(await fsp.readFile(recConfigPath, 'utf8'));
  if (
    !detCfg.arch ||
    !Array.isArray(detCfg.mean) ||
    !Array.isArray(detCfg.std)
  ) {
    throw new Error(`${source.modelId}: det config.json missing arch/mean/std`);
  }
  if (
    !recCfg.arch ||
    typeof recCfg.vocab !== 'string' ||
    recCfg.vocab.length === 0 ||
    !Array.isArray(recCfg.mean) ||
    !Array.isArray(recCfg.std)
  ) {
    throw new Error(
      `${source.modelId}: rec config.json missing arch/vocab/mean/std`
    );
  }

  const manifest = {
    family: 'doctr',
    det: {
      arch: detCfg.arch,
      input_shape: detCfg.input_shape,
      mean: detCfg.mean,
      std: detCfg.std,
    },
    rec: {
      arch: recCfg.arch,
      input_shape: recCfg.input_shape,
      mean: recCfg.mean,
      std: recCfg.std,
      vocab: recCfg.vocab,
    },
  };
  const manifestPath = path.join(modelDir, 'ocr_manifest.json');
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  console.log(`[manifest] ${source.modelId}: ocr_manifest.json`);

  await fsp.rm(detConfigPath, { force: true });
  await fsp.rm(recConfigPath, { force: true });
}

/**
 * @param {string} filePath
 */
async function assertNotGitLfsPointer(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(256);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const firstLine = buf
      .subarray(0, bytesRead)
      .toString('utf8')
      .split(/\r?\n/, 1)[0];
    if (firstLine === GIT_LFS_POINTER_FIRST_LINE) {
      throw new Error(
        `${path.basename(filePath)} is a Git LFS pointer, not file contents`
      );
    }
  } finally {
    await fh.close();
  }
}

/**
 * @param {string} filePath
 * @param {number} minBytes
 */
async function assertMinBytes(filePath, minBytes) {
  const stat = await fsp.stat(filePath);
  if (stat.size < minBytes) {
    throw new Error(
      `${path.basename(filePath)} is ${
        stat.size
      } bytes; expected at least ${minBytes}`
    );
  }
  return stat.size;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function expectObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} label
 */
function expectFiniteNumber(obj, key, label) {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}.${key} must be a finite number`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} label
 */
function expectNonEmptyString(obj, key, label) {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} label
 */
function expectBoolean(obj, key, label) {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${label}.${key} must be a boolean`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function expectNumberArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    throw new Error(`${label} must be a non-empty array of finite numbers`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function expectTokenContent(value, label) {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const content = /** @type {{ content?: unknown }} */ (value).content;
    if (typeof content === 'string' && content.length > 0) {
      return content;
    }
  }
  throw new Error(`${label} must be a string or an object with content`);
}

/**
 * @param {string} hfRepo
 * @param {string} repoRelativePath
 */
function docVlmFileUrl(hfRepo, repoRelativePath) {
  if (!DOC_VLM_HF_REPO_RE.test(hfRepo)) {
    throw new Error(`Invalid hf_repo '${hfRepo}'`);
  }
  return `https://huggingface.co/${hfRepo}/resolve/main/${repoRelativePath}`;
}

/**
 * @param {string} modelDir
 * @param {string} name
 */
async function readPackJson(modelDir, name) {
  const filePath = path.join(modelDir, name);
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${name}: ${message}`);
  }
  try {
    return expectObject(JSON.parse(text), name);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${name} is not valid JSON`);
    }
    throw error;
  }
}

/**
 * Build a self-contained doc_vlm pack: flattened ONNX graphs plus tokenizer files.
 * @param {object} source
 * @param {string} modelDir
 */
async function buildDocVlmPack(source, modelDir) {
  const variantKey =
    source.docVlmVariant ?? docVlmVariantFromId(source.modelId);
  const variant = DOC_VLM_VARIANTS[variantKey];
  const packFiles = docVlmPackFiles(variantKey);
  for (const file of packFiles) {
    const destination = path.join(modelDir, file.name);
    const url = docVlmFileUrl(source.hfRepo, file.repoPath);
    console.log(
      `[download] ${source.modelId}: ${file.name} ← ${file.repoPath}`
    );
    await downloadFile(url, destination);
    await assertNotGitLfsPointer(destination);
    if (
      file.name.endsWith('.onnx') &&
      path.basename(file.repoPath) !== file.name
    ) {
      rewriteOnnxExternalLocation(destination, `${file.name}_data`);
    }
    const minBytes = variant.minBytes.get(file.name);
    const size = minBytes
      ? await assertMinBytes(destination, minBytes)
      : (await fsp.stat(destination)).size;
    if (size <= 0) {
      throw new Error(`${source.modelId}: ${file.name} is empty`);
    }
  }

  const manifestFiles = {
    vision_encoder: 'vision_encoder.onnx',
    vision_encoder_data: 'vision_encoder.onnx_data',
    embed_tokens: 'embed_tokens.onnx',
    embed_tokens_data: 'embed_tokens.onnx_data',
    decoder: 'decoder_model_merged.onnx',
    decoder_data: 'decoder_model_merged.onnx_data',
    tokenizer: 'tokenizer.json',
    tokenizer_config: 'tokenizer_config.json',
    vocab: 'vocab.json',
    merges: 'merges.txt',
    added_tokens: 'added_tokens.json',
    special_tokens_map: 'special_tokens_map.json',
    chat_template: 'chat_template.jinja',
    config: 'config.json',
    generation_config: 'generation_config.json',
    preprocessor_config: 'preprocessor_config.json',
    processor_config: 'processor_config.json',
  };
  for (const packName of Object.values(manifestFiles)) {
    const stat = await fsp.stat(path.join(modelDir, packName));
    if (stat.size <= 0) {
      throw new Error(`${source.modelId}: ${packName} is missing or empty`);
    }
  }

  const config = await readPackJson(modelDir, 'config.json');
  const preprocessor = await readPackJson(modelDir, 'preprocessor_config.json');
  const processor = await readPackJson(modelDir, 'processor_config.json');
  const tokenizerConfig = await readPackJson(modelDir, 'tokenizer_config.json');
  const specialTokens = await readPackJson(modelDir, 'special_tokens_map.json');

  const arch = expectNonEmptyString(config, 'model_type', 'config.json');
  if (arch !== 'idefics3') {
    throw new Error(
      `${source.modelId}: config.json model_type must be idefics3 (got "${arch}")`
    );
  }
  const configDtype = expectNonEmptyString(config, 'dtype', 'config.json');
  const visionConfig = expectObject(
    config.vision_config,
    'config.json.vision_config'
  );
  const textConfig = expectObject(
    config.text_config,
    'config.json.text_config'
  );

  const imageTokenId = expectFiniteNumber(
    config,
    'image_token_id',
    'config.json'
  );
  if (imageTokenId !== DOC_VLM_IMAGE_TOKEN_ID) {
    throw new Error(
      `${source.modelId}: config.json image_token_id must be ${DOC_VLM_IMAGE_TOKEN_ID} (got ${imageTokenId})`
    );
  }
  const bosTokenId = expectFiniteNumber(config, 'bos_token_id', 'config.json');
  if (bosTokenId !== DOC_VLM_BOS_TOKEN_ID) {
    throw new Error(
      `${source.modelId}: config.json bos_token_id must be ${DOC_VLM_BOS_TOKEN_ID} (got ${bosTokenId})`
    );
  }
  const eosTokenId = expectFiniteNumber(config, 'eos_token_id', 'config.json');
  if (eosTokenId !== DOC_VLM_EOS_TOKEN_ID) {
    throw new Error(
      `${source.modelId}: config.json eos_token_id must be ${DOC_VLM_EOS_TOKEN_ID} (got ${eosTokenId})`
    );
  }
  const padTokenId = expectFiniteNumber(config, 'pad_token_id', 'config.json');

  const addedDecoder = expectObject(
    tokenizerConfig.added_tokens_decoder,
    'tokenizer_config.json.added_tokens_decoder'
  );
  const imageTokenEntry = addedDecoder[String(DOC_VLM_IMAGE_TOKEN_ID)];
  const imageToken = expectTokenContent(
    imageTokenEntry,
    `tokenizer_config.json.added_tokens_decoder.${DOC_VLM_IMAGE_TOKEN_ID}`
  );
  if (imageToken !== DOC_VLM_IMAGE_TOKEN) {
    throw new Error(
      `${source.modelId}: image token must be ${DOC_VLM_IMAGE_TOKEN} (got "${imageToken}")`
    );
  }

  const bosToken = expectTokenContent(
    specialTokens.bos_token,
    'special_tokens_map.json.bos_token'
  );
  const eosToken = expectTokenContent(
    specialTokens.eos_token,
    'special_tokens_map.json.eos_token'
  );
  const padToken = expectTokenContent(
    specialTokens.pad_token,
    'special_tokens_map.json.pad_token'
  );

  const maxImageSize = expectObject(
    preprocessor.max_image_size,
    'preprocessor_config.json.max_image_size'
  );
  const imageSize = expectObject(
    preprocessor.size,
    'preprocessor_config.json.size'
  );

  const manifest = {
    schema: 1,
    family: 'doc_vlm',
    id: source.modelId,
    arch,
    onnx_dtype: variant.onnxDtype,
    source: {
      repo: source.hfRepo,
      subfolder: 'onnx',
      config_dtype: configDtype,
      hub_suffix: variant.hubSuffix,
      pack_dtype: variant.onnxDtype,
    },
    files: manifestFiles,
    vision: {
      image_size: expectFiniteNumber(
        visionConfig,
        'image_size',
        'config.json.vision_config'
      ),
      patch_size: expectFiniteNumber(
        visionConfig,
        'patch_size',
        'config.json.vision_config'
      ),
      num_channels: expectFiniteNumber(
        visionConfig,
        'num_channels',
        'config.json.vision_config'
      ),
      scale_factor: expectFiniteNumber(config, 'scale_factor', 'config.json'),
      image_seq_len: expectFiniteNumber(
        processor,
        'image_seq_len',
        'processor_config.json'
      ),
      do_image_splitting: expectBoolean(
        preprocessor,
        'do_image_splitting',
        'preprocessor_config.json'
      ),
      do_normalize: expectBoolean(
        preprocessor,
        'do_normalize',
        'preprocessor_config.json'
      ),
      max_image_size_longest_edge: expectFiniteNumber(
        maxImageSize,
        'longest_edge',
        'preprocessor_config.json.max_image_size'
      ),
      size_longest_edge: expectFiniteNumber(
        imageSize,
        'longest_edge',
        'preprocessor_config.json.size'
      ),
      mean: expectNumberArray(
        preprocessor.image_mean,
        'preprocessor_config.json.image_mean'
      ),
      std: expectNumberArray(
        preprocessor.image_std,
        'preprocessor_config.json.image_std'
      ),
      rescale_factor: expectFiniteNumber(
        preprocessor,
        'rescale_factor',
        'preprocessor_config.json'
      ),
    },
    text: {
      hidden_size: expectFiniteNumber(
        textConfig,
        'hidden_size',
        'config.json.text_config'
      ),
      num_hidden_layers: expectFiniteNumber(
        textConfig,
        'num_hidden_layers',
        'config.json.text_config'
      ),
      num_attention_heads: expectFiniteNumber(
        textConfig,
        'num_attention_heads',
        'config.json.text_config'
      ),
      num_key_value_heads: expectFiniteNumber(
        textConfig,
        'num_key_value_heads',
        'config.json.text_config'
      ),
      head_dim: expectFiniteNumber(
        textConfig,
        'head_dim',
        'config.json.text_config'
      ),
      vocab_size: expectFiniteNumber(
        textConfig,
        'vocab_size',
        'config.json.text_config'
      ),
      max_position_embeddings: expectFiniteNumber(
        textConfig,
        'max_position_embeddings',
        'config.json.text_config'
      ),
      rope_theta: expectFiniteNumber(
        textConfig,
        'rope_theta',
        'config.json.text_config'
      ),
      model_type: expectNonEmptyString(
        textConfig,
        'model_type',
        'config.json.text_config'
      ),
    },
    special_tokens: {
      bos_token_id: bosTokenId,
      eos_token_id: eosTokenId,
      pad_token_id: padTokenId,
      image_token_id: imageTokenId,
      bos_token: bosToken,
      eos_token: eosToken,
      pad_token: padToken,
      image_token: imageToken,
    },
  };

  const manifestPath = path.join(modelDir, 'ocr_manifest.json');
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  console.log(`[manifest] ${source.modelId}: ocr_manifest.json`);
}

async function copyNemotronParseLocalPack(source, modelDir, variant) {
  const exportRoot =
    process.env.NEMOTRON_PARSE_EXPORT_ROOT || NEMOTRON_PARSE_EXPORT_ROOT;
  const srcDir = path.join(exportRoot, NEMOTRON_PARSE_VARIANT_DIRS[variant]);
  if (!fs.existsSync(srcDir)) {
    throw new Error(
      `${source.modelId}: local export missing at ${srcDir} (NEMOTRON_PARSE_EXPORT_ROOT)`
    );
  }
  for (const name of NEMOTRON_PARSE_PACK_FILES) {
    const src = path.join(srcDir, name);
    if (name.endsWith('.onnx_data') && !fs.existsSync(src)) {
      continue;
    }
    if (!fs.existsSync(src)) {
      throw new Error(`${source.modelId}: missing ${name} in ${srcDir}`);
    }
    const dest = path.join(modelDir, name);
    await fsp.copyFile(src, dest);
    const size = (await fsp.stat(dest)).size;
    if (size <= 0) {
      throw new Error(`${source.modelId}: ${name} is empty`);
    }
  }
  for (const name of NEMOTRON_PARSE_OPTIONAL_ROOT_FILES) {
    const src = path.join(srcDir, name);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(modelDir, name));
    }
  }
  console.log(`[flatten] ${source.modelId}: copied from ${srcDir}`);
}

async function downloadNemotronParseHubPack(source, modelDir, variant) {
  const hubFolder = NEMOTRON_PARSE_HUB_FOLDERS[variant];
  if (!hubFolder) {
    throw new Error(
      `${source.modelId}: ${variant} is not a published Hub variant (fp16/int8)`
    );
  }
  const minBytes = NEMOTRON_PARSE_MIN_BYTES[variant] || new Map();
  for (const name of NEMOTRON_PARSE_PACK_FILES) {
    const destination = path.join(modelDir, name);
    const url = docVlmFileUrl(source.hfRepo, `${hubFolder}/${name}`);
    console.log(`[download] ${source.modelId}: ${name} ← ${hubFolder}/${name}`);
    await downloadFile(url, destination);
    await assertNotGitLfsPointer(destination);
    const requiredBytes = minBytes.get(name);
    const size = requiredBytes
      ? await assertMinBytes(destination, requiredBytes)
      : (await fsp.stat(destination)).size;
    if (size <= 0) {
      throw new Error(`${source.modelId}: ${name} is empty`);
    }
  }
  for (const name of NEMOTRON_PARSE_OPTIONAL_ROOT_FILES) {
    const destination = path.join(modelDir, name);
    const url = docVlmFileUrl(source.hfRepo, name);
    const downloaded = await downloadFile(url, destination, { optional: true });
    if (downloaded) {
      await assertNotGitLfsPointer(destination);
      console.log(`[download] ${source.modelId}: ${name}`);
    }
  }
  console.log(`[flatten] ${source.modelId}: ${source.hfRepo}/${hubFolder}`);
}

async function buildNemotronParsePack(source, modelDir) {
  const variant =
    source.nemotronParseVariant ?? nemotronParseVariantFromId(source.modelId);
  if (process.env.NEMOTRON_PARSE_EXPORT_ROOT) {
    await copyNemotronParseLocalPack(source, modelDir, variant);
  } else {
    await downloadNemotronParseHubPack(source, modelDir, variant);
  }
  const manifestPath = path.join(modelDir, 'ocr_manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.family !== 'nemotron_parse') {
    throw new Error(
      `${source.modelId}: ocr_manifest.json family must be nemotron_parse (got ${manifest.family})`
    );
  }
}

async function buildArchives(sources, buildDir, distDir) {
  await fsp.mkdir(buildDir, { recursive: true });
  await fsp.mkdir(distDir, { recursive: true });

  const archives = [];

  for (const source of sources) {
    const modelDir = path.join(buildDir, source.modelId);
    await ensureCleanDir(modelDir);

    if (source.family === 'ppocr') {
      await buildPpocrPack(source, modelDir);
    } else if (source.family === 'doctr') {
      await buildDoctrPack(source, modelDir);
    } else if (source.family === 'doc_vlm') {
      await buildDocVlmPack(source, modelDir);
    } else if (source.family === 'nemotron_parse') {
      await buildNemotronParsePack(source, modelDir);
    } else {
      throw new Error(`Unknown family for ${source.modelId}: ${source.family}`);
    }

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

function filterSourcesByOnly(allSources, onlyIds) {
  if (!onlyIds || onlyIds.length === 0) {
    return allSources;
  }
  const wanted = new Set(onlyIds);
  const filtered = allSources.filter((s) => wanted.has(s.modelId));
  const missing = onlyIds.filter(
    (id) => !allSources.some((s) => s.modelId === id)
  );
  if (missing.length > 0) {
    throw new Error(`Unknown --only id(s): ${missing.join(', ')}`);
  }
  if (filtered.length === 0) {
    throw new Error('--only matched no sources');
  }
  return filtered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Full CSV is the checksum/release source of truth; --only only limits builds.
  const catalogSources = await readSources(args.csv);
  const selectedSources = filterSourcesByOnly(catalogSources, args.onlyIds);

  if (args.dryRun) {
    const archives = await buildArchives(
      selectedSources,
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

  for (const source of selectedSources) {
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

  const archiveNames = catalogSources
    .map((s) => `${s.modelId}.tar.bz2`)
    .sort((a, b) => a.localeCompare(b));

  const checksumMap = await buildChecksumMap(
    catalogSources,
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
    `[done] uploaded=${uploaded} skipped=${skipped} total=${catalogSources.length}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    process.exit(1);
  });
}

const OCR_PACK_QUANT_SUFFIX_RE =
  /-(int8|fp16|fp32|q4f16|q8|q4|uint8|bnb4|quantized)$/i;

/**
 * Strip archive extension and common quant suffixes for pack language lookup.
 * @param {string} modelId
 * @returns {string}
 */
function ocrPackStem(modelId) {
  let stem = String(modelId ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.tar\.(bz2|gz|zst)$/i, '');
  stem = stem.replace(OCR_PACK_QUANT_SUFFIX_RE, '');
  return stem;
}

module.exports = {
  readSources,
  ocrPackStem,
};
