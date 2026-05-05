/**
 * Avoid pulling the real `src/vad/engine` graph (native FS, detect chain) when tests
 * import `src/segment/index`, which requires VAD at module scope.
 */
/* global jest */
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
