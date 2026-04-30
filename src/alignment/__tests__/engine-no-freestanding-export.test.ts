jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn(),
  },
}));

jest.mock('../../detect', () => ({
  resolveFileSourceForDetect: jest.fn(),
}));

jest.mock('../../utils', () => ({
  resolveModelPath: jest.fn(),
}));

import * as alignment from '../index';

describe('alignment public exports', () => {
  it('does not expose the freestanding alignTextToAudio export', () => {
    expect(
      (alignment as Record<string, unknown>).alignTextToAudio
    ).toBeUndefined();
  });

  it('does not expose assertAlignmentGranularityForMode', () => {
    expect(
      (alignment as Record<string, unknown>).assertAlignmentGranularityForMode
    ).toBeUndefined();
  });

  it('exports only runtime alignment APIs expected in P1', () => {
    expect(Object.keys(alignment).sort()).toEqual([
      'createAlignment',
      'detectAlignmentModel',
    ]);
  });
});
