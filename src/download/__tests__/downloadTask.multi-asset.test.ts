import {
  configureDownloadManager,
  deleteIncompleteDownload,
  downloadModel,
  pauseDownload,
  resumeDownload,
} from '../downloadTask';
import { ModelCategory, PauseError } from '../types';

type FsEntry = {
  type: 'file' | 'dir';
  size: number;
  content?: string;
};

type DownloaderEventHandlers = {
  progress?: (event: { bytesDownloaded: number; bytesTotal?: number }) => void;
  done?: () => void;
  error?: (event: { error?: unknown; errorCode?: unknown }) => void;
};

class MockDownloadTask {
  public readonly id: string;
  public readonly url: string;
  public readonly destination: string;
  public readonly metadata: Record<string, unknown>;
  public readonly handlers: DownloaderEventHandlers = {};
  public stopped = false;
  public paused = false;

  constructor(args: {
    id: string;
    url: string;
    destination: string;
    metadata: Record<string, unknown>;
  }) {
    this.id = args.id;
    this.url = args.url;
    this.destination = args.destination;
    this.metadata = args.metadata;
  }

  progress(
    cb: (event: { bytesDownloaded: number; bytesTotal?: number }) => void
  ): this {
    this.handlers.progress = cb;
    return this;
  }

  done(cb: () => void): this {
    this.handlers.done = cb;
    return this;
  }

  error(cb: (event: { error?: unknown; errorCode?: unknown }) => void): this {
    this.handlers.error = cb;
    return this;
  }

  start(): void {
    const behavior = taskStartBehaviors.shift() ?? completeTaskWithBytes(1);
    behavior(this);
  }

  async resume(): Promise<void> {
    const behavior = taskStartBehaviors.shift() ?? completeTaskWithBytes(1);
    behavior(this);
  }

  async pause(): Promise<void> {
    this.paused = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

var mockFsRoot = '/jest/sherpa-documents';
var mockFsEntries = new Map<string, FsEntry>();
var mockCreatedTasks: MockDownloadTask[] = [];
var taskStartBehaviors: Array<(task: MockDownloadTask) => void> = [];
type MockChecksumValidationResult = {
  success: boolean;
  error?: 'CHECKSUM_MISMATCH' | 'CHECKSUM_FAILED';
  message?: string;
};

const mockValidateChecksum = jest.fn<
  Promise<MockChecksumValidationResult>,
  [string, string]
>(async () => ({
  success: true,
  error: undefined,
  message: '',
}));

function mockNorm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function mockParent(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) {
    return '/';
  }
  return path.slice(0, idx);
}

function mockEnsureDir(path: string): void {
  const target = mockNorm(path);
  if (!target || target === '/') {
    mockFsEntries.set('/', { type: 'dir', size: 0 });
    return;
  }

  const parts = target.split('/').filter(Boolean);
  let curr = '';
  mockFsEntries.set('/', { type: 'dir', size: 0 });
  for (const part of parts) {
    curr += `/${part}`;
    if (!mockFsEntries.has(curr)) {
      mockFsEntries.set(curr, { type: 'dir', size: 0 });
    }
  }
}

function mockWriteFsFile(path: string, size: number, content = ''): void {
  const filePath = mockNorm(path);
  mockEnsureDir(mockParent(filePath));
  mockFsEntries.set(filePath, { type: 'file', size, content });
}

function mockRemovePathRecursive(path: string): void {
  const target = mockNorm(path);
  for (const key of [...mockFsEntries.keys()]) {
    if (key === target || key.startsWith(`${target}/`)) {
      mockFsEntries.delete(key);
    }
  }
}

function mockListImmediate(
  path: string
): Array<{ name: string; path: string; type: 'file' | 'dir'; size: number }> {
  const base = mockNorm(path);
  const out = new Map<
    string,
    { name: string; path: string; type: 'file' | 'dir'; size: number }
  >();

  for (const [entryPath, entry] of mockFsEntries.entries()) {
    if (entryPath === base || !entryPath.startsWith(`${base}/`)) {
      continue;
    }

    const rest = entryPath.slice(base.length + 1);
    if (!rest || rest.includes('/')) {
      const head = rest.split('/')[0];
      if (!head) {
        continue;
      }
      const childPath = `${base}/${head}`;
      const child = mockFsEntries.get(childPath);
      if (child?.type === 'dir') {
        out.set(childPath, {
          name: head,
          path: childPath,
          type: 'dir',
          size: 0,
        });
      }
      continue;
    }

    out.set(entryPath, {
      name: rest,
      path: entryPath,
      type: entry.type,
      size: entry.size,
    });
  }

  return [...out.values()];
}

function completeTaskWithBytes(
  bytes: number
): (task: MockDownloadTask) => void {
  return (task) => {
    mockWriteFsFile(task.destination, bytes, 'x'.repeat(bytes));
    task.handlers.progress?.({ bytesDownloaded: bytes, bytesTotal: bytes });
    task.handlers.done?.();
  };
}

function failTask(message: string): (task: MockDownloadTask) => void {
  return (task) => {
    task.handlers.error?.({ error: message, errorCode: 'TASK_FAILED' });
  };
}

jest.mock('@dr.pogodin/react-native-fs', () => ({
  __esModule: true,
  DocumentDirectoryPath: '/jest/sherpa-documents',
  exists: jest.fn(async (path: string) => mockFsEntries.has(mockNorm(path))),
  mkdir: jest.fn(async (path: string) => {
    mockEnsureDir(path);
  }),
  readFile: jest.fn(async (path: string) => {
    const item = mockFsEntries.get(mockNorm(path));
    if (!item || item.type !== 'file') {
      throw new Error(`ENOENT: ${path}`);
    }
    return item.content ?? '';
  }),
  writeFile: jest.fn(async (path: string, data: string) => {
    mockWriteFsFile(path, data.length, data);
  }),
  unlink: jest.fn(async (path: string) => {
    mockRemovePathRecursive(path);
  }),
  readDir: jest.fn(async (path: string) =>
    mockListImmediate(path).map((entry) => ({
      name: entry.name,
      path: entry.path,
      size: entry.size,
      isDirectory: () => entry.type === 'dir',
      isFile: () => entry.type === 'file',
    }))
  ),
  stat: jest.fn(async (path: string) => {
    const item = mockFsEntries.get(mockNorm(path));
    if (!item) {
      throw new Error(`ENOENT: ${path}`);
    }
    return {
      size: item.size,
      isFile: () => item.type === 'file',
      isDirectory: () => item.type === 'dir',
      mtime: new Date(),
    };
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    const src = mockNorm(from);
    const dst = mockNorm(to);
    const srcEntry = mockFsEntries.get(src);

    if (srcEntry?.type === 'file') {
      mockEnsureDir(mockParent(dst));
      mockFsEntries.set(dst, srcEntry);
      mockFsEntries.delete(src);
      return;
    }

    mockEnsureDir(dst);
    const keys = [...mockFsEntries.keys()].filter(
      (key) => key === src || key.startsWith(`${src}/`)
    );

    for (const key of keys) {
      const next = key === src ? dst : `${dst}${key.slice(src.length)}`;
      const entry = mockFsEntries.get(key);
      if (entry) {
        mockFsEntries.set(next, entry);
      }
    }

    for (const key of keys) {
      mockFsEntries.delete(key);
    }
  }),
}));

jest.mock('../foregroundDownload', () => ({
  __esModule: true,
  cancelForegroundDownload: jest.fn(async () => {}),
  createForegroundDownloadTask: jest.fn(
    (args: {
      id: string;
      url: string;
      destination: string;
      headers?: Record<string, string>;
    }) => {
      const task = new MockDownloadTask({
        ...args,
        metadata: args.headers ?? {},
      });
      mockCreatedTasks.push(task);
      return task;
    }
  ),
}));

jest.mock('../sources/registry', () => ({
  __esModule: true,
  getSource: jest.fn(() => ({
    defaultHeaders: () => ({}),
  })),
  buildSourceFetchContext: jest.fn(() => ({
    headers: {},
    token: undefined,
    tokenScheme: 'Bearer',
  })),
}));

jest.mock('../registry', () => ({
  __esModule: true,
  getModelById: jest.fn(async (_category: unknown, id: string) => ({
    id,
    displayName: id,
    sourceId: 'hf_source',
    category: 'stt',
    layout: { kind: 'folder', format: 'none', extract: false },
    assets: [
      {
        relativePath: 'encoder.onnx',
        url: 'https://example.invalid/a1',
        bytes: 11,
        sha256:
          '1111111111111111111111111111111111111111111111111111111111111111',
      },
      {
        relativePath: 'decoder.onnx',
        url: 'https://example.invalid/a2',
        bytes: 22,
        sha256:
          '2222222222222222222222222222222222222222222222222222222222222222',
      },
      {
        relativePath: 'tokens.txt',
        url: 'https://example.invalid/a3',
        bytes: 33,
        sha256:
          '3333333333333333333333333333333333333333333333333333333333333333',
      },
    ],
    bytes: 66,
  })),
}));

jest.mock('../modelExtraction', () => ({
  __esModule: true,
  consumePausedExtractionRequest: jest.fn(() => false),
}));

const mockRunPostDownloadProcessing = jest.fn(
  async (options: { id: string; modelDir: string; statePath: string }) => {
    mockRemovePathRecursive(options.statePath);
    return {
      modelId: options.id,
      localPath: options.modelDir,
    };
  }
);

jest.mock('../postDownloadProcessing', () => ({
  __esModule: true,
  runPostDownloadProcessing: (options: unknown) =>
    mockRunPostDownloadProcessing(options as never),
}));

jest.mock('../localModels', () => ({
  __esModule: true,
  listDownloadedModels: jest.fn(async () => []),
}));

jest.mock('../validation', () => ({
  __esModule: true,
  checkDiskSpace: jest.fn(async () => ({ success: true, message: '' })),
  validateChecksum: (filePath: string, expected: string) =>
    mockValidateChecksum(filePath, expected),
  removeDirectoryRecursive: jest.fn(async (path: string) => {
    mockRemovePathRecursive(path);
  }),
}));

describe('downloadTask multi-asset folder flow', () => {
  const category = ModelCategory.Stt;
  const modelId = 'sample-multi-asset';
  const sourceId = 'hf_source';

  const sourceBase = `${mockFsRoot}/sherpa-onnx/models/stt/sources/${sourceId}`;
  const tempDir = `${sourceBase}/.tmp-${modelId}-active`;
  const modelDir = `${sourceBase}/${modelId}`;
  const statePath = `${sourceBase}/.download-state-${modelId}.json`;

  beforeEach(() => {
    configureDownloadManager({ maxParallelDownloads: 1 });
    mockFsEntries.clear();
    mockCreatedTasks.splice(0, mockCreatedTasks.length);
    taskStartBehaviors = [];
    mockEnsureDir(mockFsRoot);
    mockEnsureDir('/');
    mockRunPostDownloadProcessing.mockClear();
    mockValidateChecksum.mockReset();
    mockValidateChecksum.mockResolvedValue({
      success: true,
      error: undefined,
      message: '',
    });
    jest.clearAllMocks();
  });

  it('downloads 3 assets and commits temp dir atomically into model dir', async () => {
    taskStartBehaviors = [
      completeTaskWithBytes(11),
      completeTaskWithBytes(22),
      completeTaskWithBytes(33),
    ];

    const result = await downloadModel(category, modelId, {
      source: sourceId,
    });

    expect(result.modelId).toBe(modelId);
    expect(result.localPath).toBe(modelDir);
    expect(mockRunPostDownloadProcessing).toHaveBeenCalledTimes(1);

    const runCall = mockRunPostDownloadProcessing.mock
      .calls[0]?.[0] as unknown as {
      isArchive: boolean;
      downloadPath: string;
      modelDir: string;
    };
    expect(runCall.isArchive).toBe(false);
    expect(runCall.modelDir).toBe(modelDir);
    expect(runCall.downloadPath).toBe(`${modelDir}/encoder.onnx`);

    expect(mockFsEntries.has(`${modelDir}/encoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/decoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/tokens.txt`)).toBe(true);
    expect(mockFsEntries.has(statePath)).toBe(false);
    expect(mockValidateChecksum).toHaveBeenCalledTimes(3);
    expect(mockCreatedTasks.length).toBe(3);
  });

  it('skips per-asset checksum validation when verifyChecksum is false', async () => {
    taskStartBehaviors = [
      completeTaskWithBytes(11),
      completeTaskWithBytes(22),
      completeTaskWithBytes(33),
    ];

    await downloadModel(category, modelId, {
      source: sourceId,
      verifyChecksum: false,
    });

    expect(mockValidateChecksum).not.toHaveBeenCalled();
  });

  it('skips checksum-failed asset and persists failed index for retry', async () => {
    taskStartBehaviors = [
      completeTaskWithBytes(11),
      completeTaskWithBytes(22),
      completeTaskWithBytes(33),
    ];

    mockValidateChecksum
      .mockResolvedValueOnce({ success: true, error: undefined, message: '' })
      .mockResolvedValueOnce({
        success: false,
        error: 'CHECKSUM_MISMATCH',
        message: 'bad checksum',
      });

    await expect(
      downloadModel(category, modelId, { source: sourceId })
    ).rejects.toThrow('Download incomplete: 1 file(s) failed');

    const rawState = mockFsEntries.get(statePath);
    expect(rawState?.type).toBe('file');
    const stateJson = JSON.parse(rawState?.content ?? '{}') as {
      nextAssetIndex?: number;
      failedAssetIndices?: number[];
    };
    expect(stateJson.nextAssetIndex).toBe(3);
    expect(stateJson.failedAssetIndices).toEqual([1]);
    expect(mockFsEntries.has(tempDir)).toBe(true);
    expect(mockFsEntries.has(modelDir)).toBe(false);
  });

  it('keeps asset on checksum mismatch when onChecksumMismatch returns true', async () => {
    taskStartBehaviors = [
      completeTaskWithBytes(11),
      completeTaskWithBytes(22),
      completeTaskWithBytes(33),
    ];

    mockValidateChecksum
      .mockResolvedValueOnce({ success: true, error: undefined, message: '' })
      .mockResolvedValueOnce({
        success: false,
        error: 'CHECKSUM_MISMATCH',
        message: 'bad checksum',
      })
      .mockResolvedValueOnce({ success: true, error: undefined, message: '' });

    const onChecksumMismatch = jest.fn(async () => true);

    const result = await downloadModel(category, modelId, {
      source: sourceId,
      onChecksumMismatch,
    });

    expect(result.modelId).toBe(modelId);
    expect(onChecksumMismatch).toHaveBeenCalledTimes(1);
    expect(mockFsEntries.has(`${modelDir}/encoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/decoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/tokens.txt`)).toBe(true);
  });

  it('supports pause and later resume from persisted nextAssetIndex state', async () => {
    let secondTask: MockDownloadTask | null = null;
    let secondStartedResolve: (() => void) | null = null;
    const secondStarted = new Promise<void>((resolve) => {
      secondStartedResolve = resolve;
    });

    taskStartBehaviors = [
      completeTaskWithBytes(11),
      (task) => {
        secondTask = task;
        task.handlers.progress?.({ bytesDownloaded: 5, bytesTotal: 22 });
        secondStartedResolve?.();
      },
    ];

    const firstRun = downloadModel(category, modelId, {
      source: sourceId,
    });

    await secondStarted;
    await pauseDownload(category, modelId, sourceId);
    await expect(firstRun).rejects.toBeInstanceOf(PauseError);

    const rawState = mockFsEntries.get(statePath);
    expect(rawState?.type).toBe('file');
    const stateJson = JSON.parse(rawState?.content ?? '{}') as {
      nextAssetIndex?: number;
    };
    expect(stateJson.nextAssetIndex).toBe(1);
    expect(secondTask).not.toBeNull();
    if (!secondTask) {
      throw new Error('expected second task to be created before pause');
    }
    const activeTask = secondTask as unknown as {
      paused: boolean;
      stopped: boolean;
    };
    expect(activeTask.paused || activeTask.stopped).toBe(true);

    taskStartBehaviors = [completeTaskWithBytes(22), completeTaskWithBytes(33)];

    const resumed = await resumeDownload(category, modelId, {
      source: sourceId,
    });

    expect(resumed.modelId).toBe(modelId);
    expect(resumed.localPath).toBe(modelDir);
    expect(mockFsEntries.has(`${modelDir}/encoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/decoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/tokens.txt`)).toBe(true);
    expect(mockFsEntries.has(statePath)).toBe(false);
  });

  it('continues other assets and retries only failed ones', async () => {
    taskStartBehaviors = [completeTaskWithBytes(11), failTask('asset failed')];

    await expect(
      downloadModel(category, modelId, { source: sourceId })
    ).rejects.toThrow('Download incomplete: 1 file(s) failed');

    const firstStateRaw = mockFsEntries.get(statePath);
    expect(firstStateRaw?.type).toBe('file');
    const firstState = JSON.parse(firstStateRaw?.content ?? '{}') as {
      nextAssetIndex?: number;
      failedAssetIndices?: number[];
    };
    expect(firstState.nextAssetIndex).toBe(3);
    expect(firstState.failedAssetIndices).toEqual([1]);

    taskStartBehaviors = [completeTaskWithBytes(22)];
    const resumed = await resumeDownload(category, modelId, {
      source: sourceId,
    });

    expect(resumed.modelId).toBe(modelId);
    expect(resumed.localPath).toBe(modelDir);
    expect(mockFsEntries.has(`${modelDir}/encoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/decoder.onnx`)).toBe(true);
    expect(mockFsEntries.has(`${modelDir}/tokens.txt`)).toBe(true);
    expect(mockFsEntries.has(statePath)).toBe(false);
  });

  it('deleteIncompleteDownload removes source-scoped temp and state', async () => {
    mockEnsureDir(tempDir);
    mockWriteFsFile(`${tempDir}/partial.bin`, 7, 'partial');
    const statePayload = JSON.stringify({
      modelId,
      sourceId,
      category,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
      downloadPath: `${tempDir}/partial.bin`,
      layout: { kind: 'folder', format: 'none', extract: false },
      model: {
        id: modelId,
        displayName: modelId,
        sourceId,
        category,
        layout: { kind: 'folder', format: 'none', extract: false },
        assets: [],
        bytes: 0,
      },
    });
    mockWriteFsFile(statePath, statePayload.length, statePayload);

    await deleteIncompleteDownload(category, modelId, sourceId);

    expect(mockFsEntries.has(tempDir)).toBe(false);
    expect(mockFsEntries.has(statePath)).toBe(false);
  });
});
