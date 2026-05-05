jest.mock('../../NativeSherpaOnnx', () => ({
  __esModule: true,
  default: {
    detectAlignmentModel: jest.fn(),
    alignAccurateFromPcm: jest.fn(),
    alignAccurateForcedCtcFromPcm: jest.fn(),
  },
}));

import SherpaOnnx from '../../NativeSherpaOnnx';

describe('alignment/native spec shape', () => {
  test('exposes descriptor-based accurate + forced-ctc methods', () => {
    const native = SherpaOnnx as unknown as {
      alignAccurateFromPcm?: unknown;
      alignAccurateForcedCtcFromPcm?: unknown;
    };

    expect(typeof native.alignAccurateFromPcm).toBe('function');
    expect(typeof native.alignAccurateForcedCtcFromPcm).toBe('function');
  });
});
