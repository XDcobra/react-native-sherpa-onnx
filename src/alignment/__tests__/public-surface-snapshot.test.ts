jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(),
}));

describe('alignment public surface snapshot', () => {
  it('locks exported keys from ../index', () => {
    const keys = Object.keys(
      require('../index') as Record<string, unknown>
    ).sort();

    expect(keys).toMatchInlineSnapshot(`
      [
        "AlignmentErrorCode",
        "OrchestrationErrorCode",
        "accurateOptionsToModelConfig",
        "applyVocabRomanizerToProfile",
        "assertAlignmentCustomConfig",
        "createAlignment",
        "detectAlignmentModel",
        "getRomanizer",
        "hasAlignableAlignmentLetters",
        "identityRomanizer",
        "inferRomanizerFromVocabTokens",
        "isOrchestrationCancelledError",
        "latinDiacriticRomanizer",
        "prepareAlignmentTranscript",
        "resolveAlignmentCustomConfigPaths",
        "resolveAlignmentOnnxPath",
        "resolveAlignmentPackProfile",
        "tokensFromVocabJson",
        "uromanRomanizer",
      ]
    `);
  });
});
