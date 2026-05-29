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
        "createAlignment",
        "detectAlignmentModel",
      ]
    `);
  });
});
