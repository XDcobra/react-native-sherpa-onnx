jest.mock('@dr.pogodin/react-native-fs', () => ({
  exists: jest.fn(async () => true),
  mkdir: jest.fn(async () => undefined),
  readFile: jest.fn(async () => '{}'),
  stat: jest.fn(async () => ({ size: 10, mtime: new Date() })),
  unlink: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
}));
jest.mock('../../extraction/extractTarBz2', () => ({
  extractTarBz2: jest.fn(),
}));
jest.mock('../activeModelOperations', () => ({
  registerActivePostProcess: jest.fn(),
  unregisterActivePostProcess: jest.fn(),
}));
jest.mock('../downloadEvents', () => ({
  emitDownloadProgress: jest.fn(),
  emitModelsListUpdated: jest.fn(),
}));
jest.mock('../paths', () => ({
  getExtractionStatePath: () => '/m/.extract-state.json',
  getManifestPath: () => '/m/manifest.json',
  getReadyMarkerPath: () => '/m/.ready',
}));
const mockRefreshModels = jest.fn();
jest.mock('../registry', () => ({
  refreshModels: (...a: unknown[]) => mockRefreshModels(...a),
}));
const mockValidateChecksum = jest.fn();
jest.mock('../validation', () => ({
  validateChecksum: (path: string, sha: string) =>
    mockValidateChecksum(path, sha),
  validateExtractedFiles: jest.fn(async () => ({ success: true })),
  resolveActualModelDir: jest.fn(async (dir: string) => dir),
}));

import { runPostDownloadProcessing } from '../postDownloadProcessing';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const model = {
  id: 'voiceprint',
  displayName: 'Voiceprint',
  sourceId: 'github_src',
  category: 'speakerEmbedding',
  bytes: 10,
  sha256: OLD,
  assets: [],
} as never;

function run() {
  return runPostDownloadProcessing({
    category: 'speakerEmbedding' as never,
    id: 'voiceprint',
    model,
    downloadPath: '/m/voiceprint.onnx',
    modelDir: '/m',
    isArchive: false,
    statePath: '/m/.state.json',
    getDownloadedList: async () => [],
  } as never);
}

describe('checksum of a file the source replaced', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The file on disk matches only the new upstream digest.
    mockValidateChecksum.mockImplementation(async (_p: string, sha: string) =>
      sha === NEW
        ? { success: true }
        : { success: false, error: 'CHECKSUM_MISMATCH' }
    );
  });

  it('accepts the download when the reloaded entry has the matching new digest', async () => {
    mockRefreshModels.mockResolvedValue([{ id: 'voiceprint', sha256: NEW }]);
    await expect(run()).resolves.toBeDefined();
    expect(mockRefreshModels).toHaveBeenCalledWith('speakerEmbedding', {
      forceRefresh: true,
      source: 'github_src',
    });
  });

  it('still rejects when the source still lists the old digest', async () => {
    mockRefreshModels.mockResolvedValue([{ id: 'voiceprint', sha256: OLD }]);
    await expect(run()).rejects.toThrow('Checksum verification failed');
  });

  it('still rejects when the new digest does not match the file either', async () => {
    mockRefreshModels.mockResolvedValue([
      { id: 'voiceprint', sha256: 'c'.repeat(64) },
    ]);
    await expect(run()).rejects.toThrow('Checksum verification failed');
  });

  it('still rejects when the source cannot be reached', async () => {
    mockRefreshModels.mockRejectedValue(new Error('offline'));
    await expect(run()).rejects.toThrow('Checksum verification failed');
  });
});
