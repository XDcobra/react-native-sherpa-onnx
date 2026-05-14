/**
 * Avoid pulling the real `src/vad/engine` graph (native FS, detect chain) when tests
 * import `src/segment/index`, which requires VAD at module scope.
 */
/* global jest */

jest.mock('@dr.pogodin/react-native-fs', () => {
  const resolved = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    DocumentDirectoryPath: '/jest/sherpa-documents',
    LibraryDirectoryPath: '/jest/sherpa-library',
    CachesDirectoryPath: '/jest/sherpa-caches',
    exists: jest.fn().mockResolvedValue(false),
    readDir: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(''),
    writeFile: resolved,
    appendFile: resolved,
    unlink: resolved,
    mkdir: resolved,
    stat: jest.fn().mockResolvedValue({
      size: 0,
      isFile: () => true,
      isDirectory: () => false,
      mtime: new Date(),
    }),
    moveFile: resolved,
    copyFile: resolved,
  };
});

jest.mock('./src/vad/engine', () => ({
  detectVadModel: jest.fn(async () => ({
    success: false,
    error: 'default jest mock (override with jest.mock in the test file)',
  })),
  createStreamingVAD: jest.fn(async () => {
    throw new Error(
      'createStreamingVAD: default jest mock — override in vad tests if needed'
    );
  }),
}));
