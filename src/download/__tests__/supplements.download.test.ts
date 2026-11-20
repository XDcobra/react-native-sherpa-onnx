import { runPostDownloadProcessing } from '../postDownloadProcessing';
import { ensureModel } from '../ensureModel';
import { getModelDir, getReadyMarkerPath } from '../paths';
import {
  downloadSupplements,
  getArchiveBytes,
  getSupplementBytes,
} from '../supplementFiles';
import { ModelCategory, type ModelMeta, type Progress } from '../types';

type FsEntry = { type: 'file' | 'dir'; size: number; content?: string };

var mockFsEntries = new Map<string, FsEntry>();
var mockCreatedTasks: MockTask[] = [];
var mockTaskBehaviors: Array<(task: MockTask) => void> = [];
var mockValidateChecksum = jest.fn(async (_path: string, _sha: string) => ({
  success: true as boolean,
  error: undefined as undefined | 'CHECKSUM_MISMATCH',
}));
/** Files the mocked extraction writes, as `pack/relative/path` → size. */
var mockArchiveFiles: Record<string, number> = {};

function mockNorm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function mockParent(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function mockEnsureDir(path: string): void {
  let curr = '';
  for (const part of mockNorm(path).split('/').filter(Boolean)) {
    curr += `/${part}`;
    if (!mockFsEntries.has(curr)) {
      mockFsEntries.set(curr, { type: 'dir', size: 0 });
    }
  }
}

function mockWriteFile(path: string, size: number, content = ''): void {
  const p = mockNorm(path);
  mockEnsureDir(mockParent(p));
  mockFsEntries.set(p, { type: 'file', size, content });
}

function mockRemove(path: string): void {
  const target = mockNorm(path);
  for (const key of [...mockFsEntries.keys()]) {
    if (key === target || key.startsWith(`${target}/`)) {
      mockFsEntries.delete(key);
    }
  }
}

function mockReadDir(path: string) {
  const base = mockNorm(path);
  const out = new Map<string, { name: string; path: string; e: FsEntry }>();
  for (const [p, e] of mockFsEntries.entries()) {
    if (!p.startsWith(`${base}/`)) continue;
    const head = p.slice(base.length + 1).split('/')[0]!;
    const childPath = `${base}/${head}`;
    const child = mockFsEntries.get(childPath) ?? e;
    out.set(childPath, { name: head, path: childPath, e: child });
  }
  return [...out.values()].map(({ name, path: p, e }) => ({
    name,
    path: p,
    size: e.size,
    isDirectory: () => e.type === 'dir',
    isFile: () => e.type === 'file',
  }));
}

class MockTask {
  handlers: {
    progress?: (e: { bytesDownloaded: number; bytesTotal: number }) => void;
    done?: () => void;
    error?: (e: { error?: string; errorCode?: number }) => void;
  } = {};
  constructor(
    public readonly id: string,
    public readonly url: string,
    public readonly destination: string
  ) {}
  progress(cb: NonNullable<MockTask['handlers']['progress']>) {
    this.handlers.progress = cb;
    return this;
  }
  done(cb: NonNullable<MockTask['handlers']['done']>) {
    this.handlers.done = cb;
    return this;
  }
  error(cb: NonNullable<MockTask['handlers']['error']>) {
    this.handlers.error = cb;
    return this;
  }
  begin() {
    return this;
  }
  start() {
    (mockTaskBehaviors.shift() ?? mockCompleteWith(1))(this);
  }
  stop() {}
  async pause() {}
  async resume() {}
}

function mockCompleteWith(bytes: number): (task: MockTask) => void {
  return (task) => {
    mockWriteFile(task.destination, bytes, 'x'.repeat(bytes));
    task.handlers.progress?.({ bytesDownloaded: bytes, bytesTotal: bytes });
    task.handlers.done?.();
  };
}

jest.mock('@dr.pogodin/react-native-fs', () => ({
  __esModule: true,
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async (p: string) => mockFsEntries.has(mockNorm(p))),
  mkdir: jest.fn(async (p: string) => mockEnsureDir(p)),
  readFile: jest.fn(async (p: string) => {
    const e = mockFsEntries.get(mockNorm(p));
    if (!e || e.type !== 'file') throw new Error(`ENOENT: ${p}`);
    return e.content ?? '';
  }),
  writeFile: jest.fn(async (p: string, data: string) =>
    mockWriteFile(p, data.length, data)
  ),
  unlink: jest.fn(async (p: string) => mockRemove(p)),
  readDir: jest.fn(async (p: string) => mockReadDir(p)),
  stat: jest.fn(async (p: string) => {
    const e = mockFsEntries.get(mockNorm(p));
    if (!e) throw new Error(`ENOENT: ${p}`);
    return { size: e.size, isFile: () => e.type === 'file' };
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    const e = mockFsEntries.get(mockNorm(from));
    if (!e) throw new Error(`ENOENT: ${from}`);
    mockWriteFile(to, e.size, e.content);
    mockFsEntries.delete(mockNorm(from));
  }),
}));

jest.mock('../../NativeSherpaOnnx', () => ({ __esModule: true, default: {} }));

jest.mock('../foregroundDownload', () => ({
  __esModule: true,
  cancelForegroundDownload: jest.fn(async () => {}),
  createForegroundDownloadTask: jest.fn(
    (args: { id: string; url: string; destination: string }) => {
      const task = new MockTask(args.id, args.url, args.destination);
      mockCreatedTasks.push(task);
      return task;
    }
  ),
}));

jest.mock('../sources/registry', () => ({
  __esModule: true,
  getSource: jest.fn(() => ({})),
  buildSourceFetchContext: jest.fn(() => ({ headers: {} })),
}));

jest.mock('../../extraction/extractTarBz2', () => ({
  __esModule: true,
  extractTarBz2: jest.fn(async (_archive: string, target: string) => {
    for (const [rel, size] of Object.entries(mockArchiveFiles)) {
      mockWriteFile(`${target}/${rel}`, size);
    }
    return { success: true, sha256: 'aa'.repeat(32) };
  }),
}));

jest.mock('../registry', () => ({
  __esModule: true,
  refreshModels: jest.fn(async () => []),
  getModelById: jest.fn(),
}));

jest.mock('../downloadEvents', () => ({
  __esModule: true,
  emitDownloadProgress: jest.fn(),
  emitModelsListUpdated: jest.fn(),
}));

jest.mock('../validation', () => {
  const actual = jest.requireActual('../validation');
  return {
    ...actual,
    validateChecksum: (path: string, sha: string) =>
      mockValidateChecksum(path, sha),
  };
});

jest.mock('../localModels', () => ({
  __esModule: true,
  isModelDownloaded: jest.fn(async () => true),
  getModelPath: jest.fn(),
  deleteModel: jest.fn(),
  listDownloadedModels: jest.fn(async () => []),
}));

jest.mock('../downloadTask', () => ({
  __esModule: true,
  downloadModel: jest.fn(),
  resumeDownload: jest.fn(),
  getIncompleteDownloads: jest.fn(async () => []),
  deleteIncompleteDownload: jest.fn(),
}));

jest.mock('../modelExtraction', () => ({
  __esModule: true,
  extractModel: jest.fn(),
  resumeExtraction: jest.fn(),
  getIncompleteExtractions: jest.fn(async () => []),
  deleteIncompleteExtraction: jest.fn(),
}));

const MODEL_ID = 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia';
const SOURCE_ID = 'github_k2_fsa';
const LEXICON_SHA = 'cd'.repeat(32);

function makeModel(): ModelMeta {
  return {
    id: MODEL_ID,
    displayName: 'ZipVoice',
    sourceId: SOURCE_ID,
    category: ModelCategory.Tts,
    layout: { kind: 'archive', format: 'tar.bz2', extract: true },
    assets: [
      {
        relativePath: `${MODEL_ID}.tar.bz2`,
        url: 'https://example.invalid/zipvoice.tar.bz2',
        bytes: 100,
      },
    ],
    supplements: [
      {
        relativePath: 'lexicon-en-us.txt',
        url: 'https://example.invalid/lexicon-en-us.txt',
        bytes: 10,
        sha256: LEXICON_SHA,
      },
    ],
    bytes: 110,
  };
}

const modelDir = getModelDir(ModelCategory.Tts, MODEL_ID, SOURCE_ID);
const packDir = `${modelDir}/${MODEL_ID}`;
const archivePath = `${modelDir}.tar.bz2`;

function runPost(
  model: ModelMeta,
  extra: Partial<Parameters<typeof runPostDownloadProcessing>[0]> = {}
) {
  return runPostDownloadProcessing({
    category: ModelCategory.Tts,
    id: MODEL_ID,
    model,
    downloadPath: archivePath,
    modelDir,
    isArchive: true,
    statePath: `${modelDir}.state.json`,
    getDownloadedList: async () => [],
    ...extra,
  });
}

beforeEach(() => {
  mockFsEntries = new Map();
  mockCreatedTasks = [];
  mockTaskBehaviors = [];
  mockValidateChecksum.mockClear();
  mockValidateChecksum.mockImplementation(async () => ({
    success: true,
    error: undefined,
  }));
  mockArchiveFiles = {
    [`${MODEL_ID}/encoder.int8.onnx`]: 40,
    [`${MODEL_ID}/decoder.int8.onnx`]: 40,
    [`${MODEL_ID}/tokens.txt`]: 5,
    [`${MODEL_ID}/lexicon.txt`]: 5,
  };
  // The archive as downloaded: exactly the archive size, not model.bytes.
  mockWriteFile(archivePath, 100);
});

describe('supplement sizes', () => {
  it('separates the archive size from the total', () => {
    const model = makeModel();
    expect(getSupplementBytes(model)).toBe(10);
    expect(getArchiveBytes(model)).toBe(100);
    expect(
      getArchiveBytes({
        ...model,
        assets: [{ ...model.assets[0]!, bytes: undefined }],
      })
    ).toBe(100);
  });
});

describe('runPostDownloadProcessing — supplements', () => {
  it('puts the lexicon next to the model files before the ready marker', async () => {
    const progress: Progress[] = [];
    let readyWhenFetched: boolean | undefined;
    mockTaskBehaviors.push((task) => {
      readyWhenFetched = mockFsEntries.has(
        getReadyMarkerPath(ModelCategory.Tts, MODEL_ID, SOURCE_ID)
      );
      mockCompleteWith(10)(task);
    });

    const result = await runPost(makeModel(), {
      onProgress: (p) => progress.push(p),
    });

    expect(result.localPath).toBe(packDir);
    expect(mockCreatedTasks).toHaveLength(1);
    expect(mockCreatedTasks[0]?.url).toBe(
      'https://example.invalid/lexicon-en-us.txt'
    );
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt`)).toBe(true);
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt.part`)).toBe(false);
    expect(readyWhenFetched).toBe(false);
    expect(
      mockFsEntries.has(
        getReadyMarkerPath(ModelCategory.Tts, MODEL_ID, SOURCE_ID)
      )
    ).toBe(true);
    expect(mockValidateChecksum).toHaveBeenCalledWith(
      `${packDir}/lexicon-en-us.txt.part`,
      LEXICON_SHA
    );

    // The lexicon continues the download progress from the archive bytes.
    const downloading = progress.filter((p) => p.phase === 'downloading');
    expect(downloading.at(-1)).toMatchObject({
      bytesProcessed: 110,
      totalBytes: 110,
      percent: 100,
      assetIndex: 1,
      assetCount: 2,
    });
  });

  it('keeps a lexicon the pack already ships', async () => {
    mockArchiveFiles[`${MODEL_ID}/lexicon-en-us.txt`] = 7;

    await runPost(makeModel());

    expect(mockCreatedTasks).toHaveLength(0);
    expect(mockFsEntries.get(`${packDir}/lexicon-en-us.txt`)?.size).toBe(7);
  });

  it('rejects a lexicon with a wrong checksum and leaves no ready marker', async () => {
    mockValidateChecksum.mockImplementation(async (path: string) =>
      path.endsWith('.part')
        ? { success: false, error: 'CHECKSUM_MISMATCH' as const }
        : { success: true, error: undefined }
    );

    await expect(runPost(makeModel())).rejects.toMatchObject({
      code: 'DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH',
    });
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt`)).toBe(false);
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt.part`)).toBe(false);
    expect(
      mockFsEntries.has(
        getReadyMarkerPath(ModelCategory.Tts, MODEL_ID, SOURCE_ID)
      )
    ).toBe(false);
    // The archive stays for a retry.
    expect(mockFsEntries.has(archivePath)).toBe(true);
  });

  it('fails the download when the lexicon cannot be fetched', async () => {
    mockTaskBehaviors.push((task) =>
      task.handlers.error?.({ error: 'HTTP 404', errorCode: 404 })
    );

    await expect(runPost(makeModel())).rejects.toThrow('HTTP 404');
    expect(
      mockFsEntries.has(
        getReadyMarkerPath(ModelCategory.Tts, MODEL_ID, SOURCE_ID)
      )
    ).toBe(false);
  });

  it('surfaces an abort during the lexicon fetch as AbortError', async () => {
    const controller = new AbortController();
    mockTaskBehaviors.push((task) => {
      mockWriteFile(task.destination, 3);
      task.handlers.progress?.({ bytesDownloaded: 3, bytesTotal: 10 });
      controller.abort();
    });

    await expect(
      runPost(makeModel(), { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt.part`)).toBe(false);
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt`)).toBe(false);
  });

  it('does not treat the archive as truncated because bytes counts the lexicon', async () => {
    mockTaskBehaviors.push(mockCompleteWith(10));
    await expect(runPost(makeModel())).resolves.toMatchObject({
      modelId: MODEL_ID,
    });
    expect(mockFsEntries.has(archivePath)).toBe(false); // deleted after extract
  });
});

describe('downloadSupplements', () => {
  it('reports progress on its own when nothing preceded it', async () => {
    mockEnsureDir(packDir);
    const progress: Progress[] = [];
    mockTaskBehaviors.push((task) => {
      mockWriteFile(task.destination, 10);
      task.handlers.progress?.({ bytesDownloaded: 4, bytesTotal: 10 });
      task.handlers.done?.();
    });

    const written = await downloadSupplements({
      category: ModelCategory.Tts,
      model: makeModel(),
      sourceId: SOURCE_ID,
      targetDir: packDir,
      onProgress: (p) => progress.push(p),
    });

    expect(written).toBe(10);
    expect(progress[0]).toMatchObject({
      bytesProcessed: 4,
      totalBytes: 10,
      assetIndex: 0,
      assetCount: 1,
    });
    expect(progress.at(-1)).toMatchObject({ bytesProcessed: 10, percent: 100 });
  });
});

describe('ensureModel — installed model without its supplement', () => {
  const { getModelById } = jest.requireMock('../registry') as {
    getModelById: jest.Mock;
  };
  const { getModelPath } = jest.requireMock('../localModels') as {
    getModelPath: jest.Mock;
  };

  beforeEach(() => {
    getModelById.mockResolvedValue(makeModel());
    getModelPath.mockResolvedValue(packDir);
    for (const [rel, size] of Object.entries(mockArchiveFiles)) {
      mockWriteFile(`${modelDir}/${rel}`, size);
    }
    mockWriteFile(
      `${modelDir}/manifest.json`,
      0,
      JSON.stringify({
        downloadedAt: 'then',
        model: { ...makeModel(), supplements: undefined, bytes: 100 },
        sizeOnDisk: 90,
      })
    );
  });

  it('downloads only the missing lexicon and records it in the manifest', async () => {
    mockTaskBehaviors.push(mockCompleteWith(10));

    const result = await ensureModel(ModelCategory.Tts, MODEL_ID);

    expect(result).toEqual({ modelId: MODEL_ID, localPath: packDir });
    expect(mockCreatedTasks.map((t) => t.url)).toEqual([
      'https://example.invalid/lexicon-en-us.txt',
    ]);
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt`)).toBe(true);
    const manifest = JSON.parse(
      mockFsEntries.get(`${modelDir}/manifest.json`)?.content ?? '{}'
    );
    expect(manifest.model.supplements).toHaveLength(1);
    expect(manifest.sizeOnDisk).toBe(100);
    expect(manifest.downloadedAt).toBe('then');
  });

  it('returns the installed model when the lexicon cannot be fetched', async () => {
    mockTaskBehaviors.push((task) =>
      task.handlers.error?.({ error: 'offline', errorCode: -1 })
    );

    const result = await ensureModel(ModelCategory.Tts, MODEL_ID);

    expect(result).toEqual({ modelId: MODEL_ID, localPath: packDir });
    expect(mockFsEntries.has(`${packDir}/lexicon-en-us.txt`)).toBe(false);
  });

  it('still throws when the caller cancels the lexicon fetch', async () => {
    const controller = new AbortController();
    mockTaskBehaviors.push((task) => {
      mockWriteFile(task.destination, 3);
      controller.abort();
    });

    await expect(
      ensureModel(ModelCategory.Tts, MODEL_ID, { signal: controller.signal })
    ).rejects.toThrow();
  });

  it('downloads nothing when the lexicon is already there', async () => {
    mockWriteFile(`${packDir}/lexicon-en-us.txt`, 10);

    await ensureModel(ModelCategory.Tts, MODEL_ID);

    expect(mockCreatedTasks).toHaveLength(0);
  });
});
